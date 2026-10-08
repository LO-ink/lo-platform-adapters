import gzip
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from urllib.error import HTTPError, URLError

spec = importlib.util.spec_from_file_location(
    "release_plan", Path(__file__).resolve().parents[2] / "scripts/plan_python_release.py"
)
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


def sample_distribution(filename, content=b"checked source", stamp=1700000000):
    stream = io.BytesIO()
    if filename.endswith(".whl"):
        with zipfile.ZipFile(stream, "w") as archive:
            for name, payload in [
                ("fixture/__init__.py", content),
                ("fixture.dist-info/METADATA", b"Name: fixture\nVersion: 0.1.0\n"),
            ]:
                info = zipfile.ZipInfo(name, date_time=time.gmtime(stamp)[:6])
                info.external_attr = 0o100644 << 16
                archive.writestr(info, payload)
    else:
        with gzip.GzipFile(fileobj=stream, mode="wb", mtime=stamp) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as archive:
                for name, payload in [("fixture/__init__.py", content), ("README.md", b"guide")]:
                    info = tarfile.TarInfo("fixture-0.1.0/" + name)
                    info.size, info.mtime = len(payload), stamp
                    archive.addfile(info, io.BytesIO(payload))
    return stream.getvalue()


class PythonReleasePlan(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory()
        self.addCleanup(self.fixture.cleanup)
        self.root = Path(self.fixture.name)
        for project in ["lo-aiogram", "lo-bot-api-emulator"]:
            path = self.root / "python" / project
            path.mkdir(parents=True)
            (path / "pyproject.toml").write_text(
                f'[project]\nname = "{project}"\nversion = "0.1.0"\n'
            )

    def registry_request(self, url, **kwargs):
        if "files.pythonhosted.org" in url:
            return io.BytesIO(sample_distribution(url.rsplit("/", 1)[-1]))
        project, version = url.split("/")[-3:-1]
        return io.StringIO(
            json.dumps(
                {
                    "info": {"name": project, "version": version},
                    "urls": [
                        {
                            "filename": name,
                            "url": "https://files.pythonhosted.org/packages/fixture/" + name,
                            "yanked": False,
                            "digests": {
                                "sha256": hashlib.sha256(sample_distribution(name)).hexdigest()
                            },
                        }
                        for name in plan.expected_files(project, version)
                    ],
                }
            )
        )

    def build_fixture(self, root, project, directory):
        self.assertEqual(root, self.root)
        for filename in plan.expected_files(project, "0.1.0"):
            (directory / filename).write_bytes(sample_distribution(filename))

    def test_existing_versions_are_checked_before_skipping(self):
        requests, builds = [], []

        def request(url, **kwargs):
            requests.append(url)
            return self.registry_request(url, **kwargs)

        def build(root, project, directory):
            builds.append(project)
            self.build_fixture(root, project, directory)

        self.assertEqual(plan.release_matrix(self.root, request, build), {"include": []})
        self.assertEqual(builds, ["lo-aiogram", "lo-bot-api-emulator"])
        self.assertEqual(sum("files.pythonhosted.org" in url for url in requests), 4)

    def test_only_missing_package_is_selected_after_a_partial_release(self):
        def request(url, **kwargs):
            project = url.split("/")[-3]
            if project == "lo-bot-api-emulator":
                raise HTTPError(url, 404, "not found", {}, None)
            return self.registry_request(url, **kwargs)

        self.assertEqual(
            plan.release_matrix(self.root, request, self.build_fixture),
            {
                "include": [
                    {
                        "project": "lo-bot-api-emulator",
                        "artifact": "python-lo-bot-api-emulator",
                        "environment": "pypi-emulator",
                    }
                ]
            },
        )

    def test_both_new_packages_keep_their_exact_trusted_publisher_environments(self):
        def request(url, **kwargs):
            raise HTTPError(url, 404, "not found", {}, None)

        self.assertEqual(
            plan.release_matrix(self.root, request),
            {
                "include": [
                    {
                        "project": "lo-aiogram",
                        "artifact": "python-lo-aiogram",
                        "environment": "pypi",
                    },
                    {
                        "project": "lo-bot-api-emulator",
                        "artifact": "python-lo-bot-api-emulator",
                        "environment": "pypi-emulator",
                    },
                ]
            },
        )

    def test_authentication_outages_and_network_errors_are_not_missing_versions(self):
        for code in [401, 403, 429, 500, 503]:
            with self.subTest(code=code):

                def request(url, code=code, **kwargs):
                    raise HTTPError(url, code, "failure", {}, None)

                with self.assertRaises(HTTPError):
                    plan.release_matrix(self.root, request)
        with self.assertRaises(URLError):
            plan.release_matrix(
                self.root, lambda *args, **kwargs: (_ for _ in ()).throw(URLError("network"))
            )

    def test_invalid_registry_metadata_prevents_publication(self):
        for body in ["not json", '{"info":{"name":"other","version":"0.1.0"}}']:
            with self.subTest(body=body), self.assertRaises(ValueError):
                plan.release_matrix(self.root, lambda *args, body=body, **kwargs: io.StringIO(body))

    def test_one_uploaded_distribution_is_not_reported_as_a_complete_release(self):
        def request(url, **kwargs):
            project, version = url.split("/")[-3:-1]
            return io.StringIO(
                json.dumps(
                    {
                        "info": {"name": project, "version": version},
                        "urls": [{"filename": sorted(plan.expected_files(project, version))[0]}],
                    }
                )
            )

        with self.assertRaisesRegex(ValueError, "Incomplete PyPI release.*original failed"):
            plan.release_matrix(self.root, request)

    def upload_fixture(self, existing_count=1, different=False):
        directory = self.root / "dist"
        directory.mkdir()
        names = sorted(plan.expected_files("lo-aiogram", "0.1.0"))
        for name in names:
            (directory / name).write_bytes(b"checked distribution")
        metadata = {
            "info": {"name": "lo-aiogram", "version": "0.1.0"},
            "urls": [
                {
                    "filename": name,
                    "url": "https://files.pythonhosted.org/packages/fixture/" + name,
                    "yanked": False,
                    "digests": {
                        "sha256": hashlib.sha256(
                            b"other" if different else b"checked distribution"
                        ).hexdigest()
                    },
                }
                for name in names[:existing_count]
            ],
        }

        def request(url, **kwargs):
            if "files.pythonhosted.org" in url:
                return io.BytesIO(b"checked distribution")
            return io.StringIO(json.dumps(metadata))

        return directory, names, request

    def test_partial_upload_reuses_checked_artifacts_and_sends_only_the_missing_file(self):
        directory, names, request = self.upload_fixture()
        self.assertTrue(plan.prepare_upload(self.root, "lo-aiogram", directory, request))
        self.assertEqual({x.name for x in (self.root / "upload-dist").iterdir()}, {names[1]})
        self.assertEqual({x.name for x in directory.iterdir()}, set(names))
        self.assertEqual(
            (self.root / "upload-dist" / names[1]).read_bytes(), b"checked distribution"
        )

    def test_complete_byte_identical_upload_does_not_republish(self):
        directory, names, request = self.upload_fixture(existing_count=2)
        self.assertFalse(plan.prepare_upload(self.root, "lo-aiogram", directory, request))
        self.assertEqual(list((self.root / "upload-dist").iterdir()), [])
        self.assertTrue(plan.verify_upload(self.root, "lo-aiogram", directory, request))

    def test_existing_different_bytes_stop_recovery_without_altering_checked_files(self):
        directory, names, request = self.upload_fixture(different=True)
        with self.assertRaisesRegex(ValueError, "bytes differ"):
            plan.prepare_upload(self.root, "lo-aiogram", directory, request)
        self.assertFalse((self.root / "upload-dist").exists())
        self.assertEqual({x.name for x in directory.iterdir()}, set(names))

    def test_post_upload_verification_requires_both_matching_public_files(self):
        directory, names, request = self.upload_fixture()
        self.assertFalse(plan.verify_upload(self.root, "lo-aiogram", directory, request))
        with self.assertRaisesRegex(ValueError, "bytes differ"):
            plan.verify_upload(
                self.root,
                "lo-aiogram",
                directory,
                lambda *args, **kwargs: io.StringIO(
                    json.dumps(
                        {
                            "info": {"name": "lo-aiogram", "version": "0.1.0"},
                            "urls": [
                                {"filename": name, "digests": {"sha256": "wrong"}} for name in names
                            ],
                        }
                    )
                ),
            )

    def test_verification_waits_for_complete_public_files_after_processing(self):
        directory, _, complete = self.upload_fixture(existing_count=2)
        requests = 0
        delays = []

        def request(url, **kwargs):
            nonlocal requests
            requests += 1
            if requests <= 4:
                raise HTTPError(url, 404, "processing", {}, None)
            return complete(url, **kwargs)

        plan.wait_for_upload(self.root, "lo-aiogram", directory, request, delays.append)
        self.assertEqual(requests, 7)
        self.assertEqual(sum(delays), 40)

    def test_verification_timeout_fails_without_claiming_a_release(self):
        directory, _, _ = self.upload_fixture()
        delays = []

        def request(url, **kwargs):
            raise HTTPError(url, 404, "processing", {}, None)

        with self.assertRaisesRegex(RuntimeError, "not visible"):
            plan.wait_for_upload(self.root, "lo-aiogram", directory, request, delays.append)
        self.assertTrue(delays)
        self.assertLessEqual(sum(delays), 300)

    def test_verification_rejects_changed_public_bytes_immediately(self):
        directory, _, request = self.upload_fixture(existing_count=2, different=True)
        with self.assertRaisesRegex(ValueError, "bytes differ"):
            plan.wait_for_upload(
                self.root,
                "lo-aiogram",
                directory,
                request,
                lambda _: self.fail("Cannot wait past an integrity mismatch"),
            )

    def test_changed_source_without_version_bump_is_rejected(self):
        def changed_build(root, project, directory):
            for filename in plan.expected_files(project, "0.1.0"):
                (directory / filename).write_bytes(sample_distribution(filename, b"changed source"))

        with self.assertRaisesRegex(ValueError, "source differs.*bump"):
            plan.release_matrix(self.root, self.registry_request, changed_build)

    def test_unrelated_repository_change_and_archive_time_are_ignored(self):
        (self.root / "other.txt").write_text("unpackaged change")

        def build(root, project, directory):
            for filename in plan.expected_files(project, "0.1.0"):
                (directory / filename).write_bytes(sample_distribution(filename, stamp=1800000000))

        self.assertEqual(
            plan.release_matrix(self.root, self.registry_request, build), {"include": []}
        )

    def test_complete_yanked_release_is_not_silently_skipped(self):
        def request(url, **kwargs):
            value = json.load(self.registry_request(url))
            value["urls"][0]["yanked"] = True
            return io.StringIO(json.dumps(value))

        with self.assertRaisesRegex(ValueError, "yanked"):
            plan.release_matrix(self.root, request, self.build_fixture)

    def test_metadata_visibility_does_not_substitute_for_archive_visibility(self):
        directory, _, complete = self.upload_fixture(existing_count=2)
        delays, archives = [], []

        def request(url, **kwargs):
            if "files.pythonhosted.org" in url:
                archives.append(url)
                if len(archives) <= 2:
                    raise HTTPError(url, 404, "processing", {}, None)
            return complete(url, **kwargs)

        plan.wait_for_upload(self.root, "lo-aiogram", directory, request, delays.append)
        self.assertEqual(delays, [10, 10])
        self.assertEqual(len(archives), 4)
        self.assertFalse((self.root / "upload-dist").exists())

    def test_corrupt_actual_archive_is_rejected_even_when_metadata_matches(self):
        directory, _, complete = self.upload_fixture(existing_count=2)

        def request(url, **kwargs):
            return (
                io.BytesIO(b"corrupt")
                if "files.pythonhosted.org" in url
                else complete(url, **kwargs)
            )

        with self.assertRaisesRegex(ValueError, "bytes differ"):
            plan.wait_for_upload(self.root, "lo-aiogram", directory, request, self.fail)

    def test_untrusted_archive_location_is_refused_without_fetch(self):
        directory, _, complete = self.upload_fixture(existing_count=2)
        requests = []

        def request(url, **kwargs):
            requests.append(url)
            metadata = json.load(complete(url, **kwargs))
            metadata["urls"][0]["url"] = "https://example.test/archive.whl"
            return io.StringIO(json.dumps(metadata))

        with self.assertRaisesRegex(ValueError, "Unexpected public distribution URL"):
            plan.verify_upload(self.root, "lo-aiogram", directory, request)
        self.assertEqual(len(requests), 1)
