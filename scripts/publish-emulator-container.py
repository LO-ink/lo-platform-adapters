"""Publish a current tested image, retaining only verified same-image tags."""

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def registry_json(url, headers):
    # Do not forward credentials to redirects or implicit environment proxies.
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))
    try:
        response = opener.open(urllib.request.Request(url, headers=headers), timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        raise RuntimeError("Registry request failed; tag absence is unconfirmed") from None
    with response:
        status = response.status
        try:
            data = response.read()
            body = json.loads(data)
        except (ValueError, UnicodeError):
            raise RuntimeError(
                "Registry returned an unrecognized response (HTTP " + str(status) + ")"
            ) from None
        digest = response.headers.get("Docker-Content-Digest")
        if digest is not None and digest != "sha256:" + hashlib.sha256(data).hexdigest():
            raise RuntimeError("Registry manifest digest does not match response bytes")
    return status, body, digest


def registry_authorization(repository, insecure):
    if insecure:
        username = os.environ.get("LOCAL_REGISTRY_USERNAME", "")
        password = os.environ.get("LOCAL_REGISTRY_PASSWORD", "")
        return "Basic " + base64.b64encode((username + ":" + password).encode()).decode()
    if repository != "ghcr.io/lo-ink/lo-bot-api-emulator":
        raise RuntimeError("Unexpected publication repository")
    username = os.environ.get("GITHUB_ACTOR")
    password = os.environ.get("GHCR_TOKEN")
    if not username or not password:
        raise RuntimeError("Missing GHCR authorization")
    basic = base64.b64encode((username + ":" + password).encode()).decode()
    query = urllib.parse.urlencode(
        {"service": "ghcr.io", "scope": "repository:lo-ink/lo-bot-api-emulator:pull"}
    )
    status, body, _ = registry_json(
        "https://ghcr.io/token?" + query, {"Authorization": "Basic " + basic}
    )
    token = body.get("token") or body.get("access_token") if isinstance(body, dict) else None
    if status != 200 or not isinstance(token, str) or not token:
        raise RuntimeError("Registry authorization failed (HTTP " + str(status) + ")")
    return "Bearer " + token


def inspect_tag(repository, tag, authorization, image_id, insecure=False):
    registry, name = repository.split("/", 1)
    url = ("http://" if insecure else "https://") + registry + "/v2/" + name + "/manifests/" + tag
    status, body, digest = registry_json(
        url,
        {
            "Authorization": authorization,
            "Accept": "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
        },
    )
    reference = repository + ":" + tag
    if status == 200:
        media_type = body.get("mediaType") if isinstance(body, dict) else None
        manifest = media_type in (
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.v2+json",
        )
        index = media_type in (
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
        )
        # Classic Docker IDs are config digests; containerd can expose the
        # complete manifest/index digest. Never infer an index from its children.
        matches = digest == image_id or (
            manifest
            and isinstance(body.get("config"), dict)
            and body["config"].get("digest") == image_id
        )
        if (
            not isinstance(body, dict)
            or body.get("schemaVersion") != 2
            or not (manifest or index)
            or not matches
            or not isinstance(digest, str)
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest)
        ):
            raise RuntimeError("Refusing an unverified or different existing tag: " + reference)
        return digest
    errors = body.get("errors") if isinstance(body, dict) else None
    # The Docker CLI can collapse a real 401 into 'no such manifest'. Only the
    # authenticated registry's explicit missing-name/manifest 404 is absence.
    if (
        status != 404
        or not isinstance(errors, list)
        or not errors
        or any(
            not isinstance(error, dict)
            or error.get("code") not in ("MANIFEST_UNKNOWN", "NAME_UNKNOWN")
            for error in errors
        )
    ):
        raise RuntimeError(
            "Registry did not confirm tag absence (HTTP " + str(status) + "): " + reference
        )
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image_id")
    parser.add_argument("repository")
    parser.add_argument("version")
    parser.add_argument("commit")
    parser.add_argument("output", type=Path)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--insecure-local-registry", action="store_true")
    args = parser.parse_args()
    if (
        not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version)
        or not re.fullmatch(r"[0-9a-f]{40}", args.commit)
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", args.image_id)
    ):
        parser.error("Expected an image ID, stable version and full source commit")
    if args.insecure_local_registry and not re.fullmatch(
        r"(?:localhost|127\.0\.0\.1):[0-9]+/[a-z0-9/-]+", args.repository
    ):
        parser.error("Insecure registry checks are restricted to loopback test registries")
    tags = [args.version, "sha-" + args.commit]
    references = [args.repository + ":" + tag for tag in tags]
    authorization = registry_authorization(args.repository, args.insecure_local_registry)
    existing = [
        inspect_tag(
            args.repository, tag, authorization, args.image_id, args.insecure_local_registry
        )
        for tag in tags
    ]
    if len({digest for digest in existing if digest}) > 1:
        raise RuntimeError("Existing release tags identify different manifests")
    if args.check_only:
        print(
            json.dumps(
                {
                    "absent_tags": [
                        ref for ref, digest in zip(references, existing, strict=True) if not digest
                    ]
                }
            )
        )
        return
    args.output.mkdir(parents=True, exist_ok=True)
    published = []
    manifest_digests = {}
    for reference, existing_digest in zip(references, existing, strict=True):
        if not existing_digest:
            subprocess.run(["docker", "tag", args.image_id, reference], check=True, timeout=60)
            # Recheck for each write: main can advance after the first tag push.
            subprocess.run(
                ["node", str(Path(__file__).with_name("check-release-ci.mjs")), "--before-publish"],
                cwd=Path(__file__).resolve().parents[1],
                env={**os.environ, "RELEASE_SHA": args.commit},
                check=True,
                timeout=120,
            )
            subprocess.run(["docker", "push", reference], check=True, timeout=300)
        image = json.loads(
            subprocess.check_output(
                ["docker", "image", "inspect", args.image_id], text=True, timeout=60
            )
        )[0]
        if image["Id"] != args.image_id:
            raise RuntimeError("Local image identity changed")
        digests = (
            [args.repository + "@" + existing_digest]
            if existing_digest
            else [
                value
                for value in image["RepoDigests"]
                if value.startswith(args.repository + "@sha256:")
            ]
        )
        if len(digests) != 1:
            raise RuntimeError("Expected one pushed repository digest")
        published.append(reference)
        manifest_digests[reference] = digests[0]
        matching_manifests = len(set(manifest_digests.values())) == 1
        record = {
            "image": args.repository,
            "version": args.version,
            "source_commit": args.commit,
            "image_id": image["Id"],
            "digest_reference": digests[0],
            "platform": image["Os"] + "/" + image["Architecture"],
            "published_tags": published,
            "manifest_digests": manifest_digests,
            "completed": len(published) == len(references) and matching_manifests,
            "public_anonymous_pull_verified": False,
        }
        # Persist the first real push before attempting the second; a later error
        # must fail the job without hiding an already-published version digest.
        receipt = args.output / "publication.json"
        temporary = receipt.with_suffix(".tmp")
        temporary.write_text(json.dumps(record, indent=2) + "\n")
        temporary.replace(receipt)
        if not matching_manifests:
            raise RuntimeError(
                "Published release tags identify different manifests; receipt retained"
            )


if __name__ == "__main__":
    main()
