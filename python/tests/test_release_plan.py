import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError, URLError

spec = importlib.util.spec_from_file_location(
    "release_plan", Path(__file__).resolve().parents[2] / "scripts/plan_python_release.py"
)
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


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

    def test_existing_versions_are_skipped_without_republishing(self):
        def request(url, **kwargs):
            project, version = url.split("/")[-3:-1]
            return io.StringIO(
                json.dumps(
                    {
                        "info": {"name": project, "version": version},
                        "urls": [
                            {"filename": name} for name in plan.expected_files(project, version)
                        ],
                    }
                )
            )

        self.assertEqual(plan.release_matrix(self.root, request), {"include": []})

    def test_only_missing_package_is_selected_after_a_partial_release(self):
        def request(url, **kwargs):
            project, version = url.split("/")[-3:-1]
            if project == "lo-bot-api-emulator":
                raise HTTPError(url, 404, "not found", {}, None)
            return io.StringIO(
                json.dumps(
                    {
                        "info": {"name": project, "version": version},
                        "urls": [
                            {"filename": name} for name in plan.expected_files(project, version)
                        ],
                    }
                )
            )

        self.assertEqual(
            plan.release_matrix(self.root, request),
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
        return directory, names, lambda *args, **kwargs: io.StringIO(json.dumps(metadata))

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
        self.assertEqual(requests, 5)
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
