"""Publish an already-tested image without replacing either release tag."""

import argparse
import base64
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
            body = json.load(response)
        except (ValueError, UnicodeError):
            raise RuntimeError("Registry returned an unrecognized response (HTTP " + str(status) + ")") from None
    return status, body


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
    query = urllib.parse.urlencode({"service": "ghcr.io", "scope": "repository:lo-ink/lo-bot-api-emulator:pull"})
    status, body = registry_json("https://ghcr.io/token?" + query, {"Authorization": "Basic " + basic})
    token = body.get("token") or body.get("access_token") if isinstance(body, dict) else None
    if status != 200 or not isinstance(token, str) or not token:
        raise RuntimeError("Registry authorization failed (HTTP " + str(status) + ")")
    return "Bearer " + token


def inspect_absent(repository, tag, authorization, insecure=False):
    registry, name = repository.split("/", 1)
    url = ("http://" if insecure else "https://") + registry + "/v2/" + name + "/manifests/" + tag
    status, body = registry_json(url, {"Authorization": authorization, "Accept": "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json"})
    reference = repository + ":" + tag
    if status == 200:
        raise RuntimeError("Refusing to replace existing tag: " + reference)
    errors = body.get("errors") if isinstance(body, dict) else None
    # The Docker CLI can collapse a real 401 into 'no such manifest'. Only the
    # authenticated registry's explicit missing-name/manifest 404 is absence.
    if status != 404 or not isinstance(errors, list) or not errors or any(not isinstance(error, dict) or error.get("code") not in ("MANIFEST_UNKNOWN", "NAME_UNKNOWN") for error in errors):
        raise RuntimeError("Registry did not confirm tag absence (HTTP " + str(status) + "): " + reference)


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
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version) or not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        parser.error("Expected a stable version and full source commit")
    if args.insecure_local_registry and not re.fullmatch(r"(?:localhost|127\.0\.0\.1):[0-9]+/[a-z0-9/-]+", args.repository):
        parser.error("Insecure registry checks are restricted to loopback test registries")
    tags = [args.version, "sha-" + args.commit]
    references = [args.repository + ":" + tag for tag in tags]
    authorization = registry_authorization(args.repository, args.insecure_local_registry)
    for tag in tags:
        inspect_absent(args.repository, tag, authorization, args.insecure_local_registry)
    if args.check_only:
        print(json.dumps({"absent_tags": references}))
        return
    args.output.mkdir(parents=True, exist_ok=True)
    published = []
    for reference in references:
        subprocess.run(["docker", "tag", args.image_id, reference], check=True, timeout=60)
        subprocess.run(["docker", "push", reference], check=True, timeout=300)
        image = json.loads(subprocess.check_output(["docker", "image", "inspect", args.image_id], text=True, timeout=60))[0]
        digests = [value for value in image["RepoDigests"] if value.startswith(args.repository + "@sha256:")]
        if len(digests) != 1:
            raise RuntimeError("Expected one pushed repository digest")
        published.append(reference)
        record = {"image": args.repository, "version": args.version, "source_commit": args.commit, "image_id": image["Id"], "digest_reference": digests[0], "platform": image["Os"] + "/" + image["Architecture"], "published_tags": published, "completed": len(published) == len(references), "public_anonymous_pull_verified": False}
        # Persist the first real push before attempting the second; a later error
        # must fail the job without hiding an already-published version digest.
        receipt = args.output / "publication.json"
        temporary = receipt.with_suffix(".tmp")
        temporary.write_text(json.dumps(record, indent=2) + "\n")
        temporary.replace(receipt)


if __name__ == "__main__":
    main()
