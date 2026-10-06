"""Select unpublished Python versions; registry failures must stop a release."""
import json
import hashlib
import os
from pathlib import Path
import shutil
import sys
import time
import tomllib
from urllib.error import HTTPError
from urllib.request import urlopen


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
    metadata = tomllib.loads(
        (root / "python" / project / "pyproject.toml").read_text()
    )["project"]
    if metadata["name"] != project:
        raise ValueError("Unexpected release project")
    version = metadata["version"]
    if not isinstance(version, str) or not version or "/" in version:
        raise ValueError("Invalid release version")
    return version


def release_matrix(root, request=urlopen):
    pending = []
    for project, environment in [
        ("lo-aiogram", "pypi"),
        ("lo-bot-api-emulator", "pypi-emulator"),
    ]:
        version = project_version(root, project)
        published = published_release(project, version, request)
        if published is None:
            pending.append({
                "project": project,
                "artifact": "python-" + project,
                "environment": environment,
            })
        elif set(published) != expected_files(project, version):
            raise ValueError(
                f"Incomplete PyPI release {project} {version}; rerun the original failed "
                "publish job to reuse its verified distributions"
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
        if metadata.get("yanked") or metadata["digests"]["sha256"] != hashlib.sha256(files[filename].read_bytes()).hexdigest():
            raise ValueError("Public PyPI bytes differ from the checked release artifact")
    return True


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    if len(sys.argv) == 4 and sys.argv[1] == "--prepare-upload":
        values = {"has_uploads": str(prepare_upload(root, sys.argv[2], Path(sys.argv[3]))).lower()}
    elif len(sys.argv) == 4 and sys.argv[1] == "--verify-upload":
        for attempt in range(10):
            if verify_upload(root, sys.argv[2], Path(sys.argv[3])):
                break
            time.sleep(3)
        else:
            raise RuntimeError("Published distributions are not visible in PyPI")
        values = {"public_integrity": "verified"}
    elif len(sys.argv) == 1:
        matrix = release_matrix(root)
        values = {"matrix": json.dumps(matrix, separators=(",", ":")),
                  "has_releases": str(bool(matrix["include"])).lower()}
    else:
        raise ValueError("Unexpected release planner arguments")
    print(json.dumps(values))
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a") as stream:
            for name, value in values.items():
                stream.write(name + "=" + value + "\n")
