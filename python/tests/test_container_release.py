import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "container_release",
    Path(__file__).resolve().parents[2] / "scripts/publish-emulator-container.py",
)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

IMAGE = "sha256:" + "a" * 64
DIGEST = "sha256:" + "b" * 64
REVISION = "c" * 40
REPOSITORY = "ghcr.io/lo-ink/lo-bot-api-emulator"
MANIFEST = {
    "schemaVersion": 2,
    "mediaType": "application/vnd.oci.image.manifest.v1+json",
    "config": {"digest": IMAGE},
}


class ContainerRelease(unittest.TestCase):
    def test_registry_manifest_digest_is_bound_to_exact_response_bytes(self):
        payload = json.dumps(MANIFEST).encode()
        digest = "sha256:" + hashlib.sha256(payload).hexdigest()
        for advertised in (digest, "sha256:" + "f" * 64, "invalid"):
            with self.subTest(advertised=advertised):
                response = io.BytesIO(payload)
                response.status = 200
                response.headers = {"Docker-Content-Digest": advertised}
                with patch.object(
                    release.urllib.request,
                    "build_opener",
                    return_value=Mock(open=Mock(return_value=response)),
                ):
                    if advertised == digest:
                        self.assertEqual(
                            release.registry_json("https://ghcr.io/v2/example/manifests/tag", {}),
                            (200, MANIFEST, digest),
                        )
                    else:
                        with self.assertRaisesRegex(RuntimeError, "response bytes"):
                            release.registry_json("https://ghcr.io/v2/example/manifests/tag", {})

    def test_containerd_index_and_manifest_ids_require_exact_top_level_digest(self):
        index = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [{"digest": IMAGE}],
        }
        for body in (index, {**MANIFEST, "config": {"digest": "sha256:" + "d" * 64}}):
            with (
                self.subTest(body=body),
                patch.object(release, "registry_json", return_value=(200, body, IMAGE)),
            ):
                self.assertEqual(
                    release.inspect_tag(REPOSITORY, "0.1.0", "synthetic", IMAGE), IMAGE
                )
        with patch.object(release, "registry_json", return_value=(200, index, DIGEST)):
            with self.assertRaises(RuntimeError):
                release.inspect_tag(REPOSITORY, "0.1.0", "synthetic", IMAGE)

    def test_tag_preflight_accepts_only_confirmed_absence_or_exact_config_and_digest(self):
        cases = [
            ((404, {"errors": [{"code": "MANIFEST_UNKNOWN"}]}, None), None),
            ((200, MANIFEST, DIGEST), DIGEST),
        ]
        for response, expected in cases:
            with (
                self.subTest(response=response),
                patch.object(release, "registry_json", return_value=response),
            ):
                self.assertEqual(
                    release.inspect_tag(REPOSITORY, "0.1.0", "synthetic", IMAGE), expected
                )
        for response in [
            (401, {}, None),
            (403, {}, None),
            (503, {}, None),
            (404, {}, None),
            (404, {"errors": [{"code": "DENIED"}]}, None),
            (200, MANIFEST, None),
            (200, MANIFEST, "invalid"),
            (200, {**MANIFEST, "config": {"digest": "sha256:" + "d" * 64}}, DIGEST),
            (200, {**MANIFEST, "mediaType": "application/vnd.oci.image.index.v1+json"}, DIGEST),
            (200, [], DIGEST),
        ]:
            with (
                self.subTest(response=response),
                patch.object(release, "registry_json", return_value=response),
            ):
                with self.assertRaises(RuntimeError):
                    release.inspect_tag(REPOSITORY, "0.1.0", "synthetic", IMAGE)

    def run_release(self, *, existing=(None, None), fail_guard=None, pushed_digest=DIGEST):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        output = Path(temporary.name) / "receipt"
        commands = []
        guards = 0

        def execute(args, **kwargs):
            nonlocal guards
            commands.append(args)
            if args[0] == "node":
                guards += 1
                self.assertEqual(Path(args[1]).name, "check-release-ci.mjs")
                self.assertEqual(args[2:], ["--before-publish"])
                self.assertEqual(kwargs["env"]["RELEASE_SHA"], REVISION)
                self.assertEqual(kwargs["env"]["GITHUB_REPOSITORY"], "LO-ink/lo-platform-adapters")
                self.assertEqual(kwargs["env"]["GH_TOKEN"], "synthetic")
                self.assertEqual(kwargs["cwd"], Path(__file__).resolve().parents[2])
                self.assertTrue(kwargs["check"])
                if guards == fail_guard:
                    raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0)

        argv = ["publish", IMAGE, REPOSITORY, "0.1.0", REVISION, str(output)]
        image = {
            "Id": IMAGE,
            "RepoDigests": [REPOSITORY + "@" + pushed_digest],
            "Os": "linux",
            "Architecture": "amd64",
        }
        error = None
        with (
            patch.object(sys, "argv", argv),
            patch.dict(
                release.os.environ,
                {"GH_TOKEN": "synthetic", "GITHUB_REPOSITORY": "LO-ink/lo-platform-adapters"},
            ),
            patch.object(release, "registry_authorization", return_value="synthetic"),
            patch.object(release, "inspect_tag", side_effect=existing),
            patch.object(release.subprocess, "run", side_effect=execute),
            patch.object(release.subprocess, "check_output", return_value=json.dumps([image])),
        ):
            try:
                release.main()
            except (subprocess.CalledProcessError, RuntimeError) as caught:
                error = caught
        receipt_path = output / "publication.json"
        receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
        return commands, receipt, error

    def test_current_main_checks_immediately_before_each_of_two_pushes(self):
        commands, receipt, error = self.run_release()
        self.assertIsNone(error)
        pushes = [i for i, args in enumerate(commands) if args[:2] == ["docker", "push"]]
        self.assertEqual(len(pushes), 2)
        for i in pushes:
            self.assertEqual(commands[i - 1][0], "node")
        self.assertTrue(receipt["completed"])
        self.assertEqual(receipt["digest_reference"], REPOSITORY + "@" + DIGEST)

    def test_stale_main_before_first_push_cannot_publish(self):
        commands, receipt, error = self.run_release(fail_guard=1)
        self.assertIsNotNone(error)
        self.assertFalse(any(args[:2] == ["docker", "push"] for args in commands))
        self.assertIsNone(receipt)

    def test_main_advancing_between_pushes_preserves_first_incomplete_receipt(self):
        commands, receipt, error = self.run_release(fail_guard=2)
        self.assertIsNotNone(error)
        self.assertEqual(sum(args[:2] == ["docker", "push"] for args in commands), 1)
        self.assertFalse(receipt["completed"])
        self.assertEqual(receipt["published_tags"], [REPOSITORY + ":0.1.0"])
        self.assertEqual(receipt["digest_reference"], REPOSITORY + "@" + DIGEST)

    def test_current_partial_rerun_only_pushes_missing_tag_and_stale_partial_stops(self):
        for fail_guard in (None, 1):
            with self.subTest(fail_guard=fail_guard):
                commands, receipt, error = self.run_release(
                    existing=(DIGEST, None), fail_guard=fail_guard
                )
                pushes = [args for args in commands if args[:2] == ["docker", "push"]]
                self.assertEqual(len(pushes), 1 if fail_guard is None else 0)
                self.assertEqual(receipt["completed"], fail_guard is None)
                self.assertEqual(error is None, fail_guard is None)
                if pushes:
                    self.assertEqual(pushes[0][-1], REPOSITORY + ":sha-" + REVISION)

    def test_matching_existing_tags_allow_read_only_stale_verification(self):
        commands, receipt, error = self.run_release(existing=(DIGEST, DIGEST), fail_guard=1)
        self.assertIsNone(error)
        self.assertEqual(commands, [])
        self.assertTrue(receipt["completed"])

    def test_existing_tags_with_different_manifest_digests_cannot_claim_completion(self):
        commands, receipt, error = self.run_release(existing=(DIGEST, "sha256:" + "e" * 64))
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(commands, [])
        self.assertIsNone(receipt)

    def test_partial_resume_preserves_both_receipts_if_push_returns_a_different_manifest(self):
        other = "sha256:" + "e" * 64
        commands, receipt, error = self.run_release(existing=(DIGEST, None), pushed_digest=other)
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(sum(args[:2] == ["docker", "push"] for args in commands), 1)
        self.assertFalse(receipt["completed"])
        self.assertEqual(
            set(receipt["manifest_digests"].values()),
            {REPOSITORY + "@" + DIGEST, REPOSITORY + "@" + other},
        )


if __name__ == "__main__":
    unittest.main()
