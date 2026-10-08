"""Select unpublished Python versions; registry failures must stop a release."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib
import zipfile
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import unquote, urlsplit
from urllib.request import HTTPRedirectHandler, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


urlopen = build_opener(NoRedirect()).open

MAX_DISTRIBUTION_BYTES = 128 * 1024 * 1024
MAX_UNPACKED_BYTES = 512 * 1024 * 1024


def distribution_bytes(metadata, filename, request=urlopen):
    url = metadata.get("url", "")
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.netloc != "files.pythonhosted.org"
        or parsed.query
        or parsed.fragment
        or unquote(parsed.path.rsplit("/", 1)[-1]) != filename
    ):
        raise ValueError("Unexpected public distribution URL")
    chunks, size = [], 0
    with request(url, timeout=30) as response:
        if hasattr(response, "geturl") and response.geturl() != url:
            raise ValueError("Public distribution redirected unexpectedly")
        while chunk := response.read(64 * 1024):
            size += len(chunk)
            if size > MAX_DISTRIBUTION_BYTES:
                raise ValueError("Public distribution exceeds the download limit")
            chunks.append(chunk)
    data = b"".join(chunks)
    if hashlib.sha256(data).hexdigest() != metadata["digests"]["sha256"]:
        raise ValueError("Public PyPI bytes differ from registry metadata")
    return data


def packaged_files(data, filename):
    entries = {}
    size = 0
    if filename.endswith(".whl"):
        with zipfile.ZipFile(BytesIO(data)) as archive:
            for count, entry in enumerate(archive.infolist(), 1):
                if count > 10000:
                    raise ValueError("Distribution exceeds the inspection limit")
                if entry.is_dir():
                    continue
                size += entry.file_size
                if size > MAX_UNPACKED_BYTES or len(entries) >= 10000:
                    raise ValueError("Distribution exceeds the inspection limit")
                if entry.filename in entries:
                    raise ValueError("Distribution contains duplicate files")
                entries[entry.filename] = (archive.read(entry), (entry.external_attr >> 16) & 0o777)
    else:
        with tarfile.open(fileobj=BytesIO(data), mode="r:gz") as archive:
            for count, entry in enumerate(archive, 1):
                if count > 10000:
                    raise ValueError("Distribution exceeds the inspection limit")
                if entry.isdir():
                    continue
                if not entry.isfile():
                    raise ValueError("Distribution contains a non-file entry")
                size += entry.size
                if size > MAX_UNPACKED_BYTES or len(entries) >= 10000:
                    raise ValueError("Distribution exceeds the inspection limit")
                name = entry.name.partition("/")[2]
                if not name or name in entries:
                    raise ValueError("Distribution contains invalid or duplicate files")
                stream = archive.extractfile(entry)
                if stream is None:
                    raise ValueError("Distribution file cannot be read")
                entries[name] = (stream.read(), entry.mode & 0o777)
    if not entries:
        raise ValueError("Distribution contains no files")
    return entries


def build_distributions(root, project, directory):
    subprocess.run(
        [sys.executable, "-m", "build", "--outdir", str(directory), str(root / "python" / project)],
        check=True,
        stdout=sys.stderr,
    )


def published_release(project, version, request=urlopen):
    try:
        with request(f"https://pypi.org/pypi/{project}/{version}/json", timeout=30) as response:
            published = json.load(response)
        if published["info"]["name"] != project or published["info"]["version"] != version:
            raise ValueError("Registry returned unexpected release identity")
        files = published["urls"]
        if len({entry["filename"] for entry in files}) != len(files):
            raise ValueError("Registry returned duplicate distribution filenames")
        return {entry["filename"]: entry for entry in files}
    except HTTPError as error:
        if error.code != 404:
            raise
        return None


def expected_files(project, version):
    name = project.replace("-", "_")
    return {f"{name}-{version}-py3-none-any.whl", f"{name}-{version}.tar.gz"}


def project_version(root, project):
    if project not in {"lo-aiogram", "lo-bot-api-emulator"}:
        raise ValueError("Unexpected release project")
    metadata = tomllib.loads((root / "python" / project / "pyproject.toml").read_text())["project"]
    if metadata["name"] != project:
        raise ValueError("Unexpected release project")
    version = metadata["version"]
    if not isinstance(version, str) or not version or "/" in version:
        raise ValueError("Invalid release version")
    return version


def release_matrix(root, request=urlopen, build=build_distributions):
    pending = []
    for project, environment in [
        ("lo-aiogram", "pypi"),
        ("lo-bot-api-emulator", "pypi-emulator"),
    ]:
        version = project_version(root, project)
        published = published_release(project, version, request)
        if published is None:
            pending.append(
                {
                    "project": project,
                    "artifact": "python-" + project,
                    "environment": environment,
                }
            )
        elif set(published) != expected_files(project, version):
            raise ValueError(
                f"Incomplete PyPI release {project} {version}; rerun the original failed "
                "publish job to reuse its verified distributions"
            )
        else:
            if any(metadata.get("yanked") for metadata in published.values()):
                raise ValueError("Cannot accept a yanked distribution")
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                build(root, project, directory)
                files = {path.name: path for path in directory.iterdir() if path.is_file()}
                if set(files) != expected_files(project, version):
                    raise ValueError("Built distributions do not match the release project")
                for filename, metadata in published.items():
                    public = distribution_bytes(metadata, filename, request)
                    if packaged_files(public, filename) != packaged_files(
                        files[filename].read_bytes(), filename
                    ):
                        raise ValueError(
                            f"Current source differs from PyPI {project} {version}; bump its version"
                        )
    return {"include": pending}


def prepare_upload(root, project, directory, request=urlopen, upload_directory=None):
    version = project_version(root, project)
    files = {path.name: path for path in directory.iterdir() if path.is_file()}
    if set(files) != expected_files(project, version):
        raise ValueError("Downloaded distributions do not match the release project")
    published = published_release(project, version, request) or {}
    if not set(published).issubset(files):
        raise ValueError("Unexpected distributions already exist in the registry")
    for filename, metadata in published.items():
        if metadata.get("yanked"):
            raise ValueError("Cannot resume a yanked distribution")
        digest = hashlib.sha256(files[filename].read_bytes()).hexdigest()
        if metadata["digests"]["sha256"] != digest:
            raise ValueError("Existing PyPI bytes differ from the checked release artifact")
        if hashlib.sha256(distribution_bytes(metadata, filename, request)).hexdigest() != digest:
            raise ValueError("Existing PyPI bytes differ from the checked release artifact")
    missing = set(files) - set(published)
    upload_directory = upload_directory or directory.parent / "upload-dist"
    upload_directory.mkdir()
    for filename in missing:
        shutil.copyfile(files[filename], upload_directory / filename)
    return bool(missing)


def verify_upload(root, project, directory, request=urlopen):
    version = project_version(root, project)
    files = {path.name: path for path in directory.iterdir() if path.is_file()}
    if set(files) != expected_files(project, version):
        raise ValueError("Downloaded distributions do not match the release project")
    published = published_release(project, version, request)
    if published is None or set(published) != set(files):
        return False
    for filename, metadata in published.items():
        if (
            metadata.get("yanked")
            or metadata["digests"]["sha256"]
            != hashlib.sha256(files[filename].read_bytes()).hexdigest()
        ):
            raise ValueError("Public PyPI bytes differ from the checked release artifact")
        try:
            public = distribution_bytes(metadata, filename, request)
        except HTTPError as error:
            if error.code in {404, 408, 429, 500, 502, 503, 504}:
                return False
            raise
        if public != files[filename].read_bytes():
            raise ValueError("Public PyPI bytes differ from the checked release artifact")
    return True


def wait_for_upload(root, project, directory, request=urlopen, wait=time.sleep):
    for attempt in range(30):
        if verify_upload(root, project, directory, request):
            return
        if attempt < 29:
            wait(10)
    raise RuntimeError("Published distributions are not visible in PyPI")


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    if len(sys.argv) == 4 and sys.argv[1] == "--prepare-upload":
        values = {"has_uploads": str(prepare_upload(root, sys.argv[2], Path(sys.argv[3]))).lower()}
    elif len(sys.argv) == 4 and sys.argv[1] == "--verify-upload":
        wait_for_upload(root, sys.argv[2], Path(sys.argv[3]))
        values = {"public_integrity": "verified"}
    elif len(sys.argv) == 1:
        matrix = release_matrix(root)
        values = {
            "matrix": json.dumps(matrix, separators=(",", ":")),
            "has_releases": str(bool(matrix["include"])).lower(),
        }
    else:
        raise ValueError("Unexpected release planner arguments")
    print(json.dumps(values))
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a") as stream:
            for name, value in values.items():
                stream.write(name + "=" + value + "\n")
