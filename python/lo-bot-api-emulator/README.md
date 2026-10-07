# LO Bot API emulator

A local request-contract fixture for bot migrations. It loads the same generated manifest as the LO HTTP transport and `lo-aiogram`; it rejects unknown fields, stubbed methods, invalid upload references, upload-only metadata on cached videos, and unsupported albums.

Modeled edits and deletions require valid int64 targets; callback answers require a query ID. Keyboard objects must have a modeled shape. Album items resolve their own exact attachment references, including parts named `photo` or `document`. Malformed caption structures receive a JSON 400 refusal, and refused requests do not commit synthetic assets or advance message IDs. These checks validate request inputs; they do not prove a target exists or that a caller is authorized to modify it.

```sh
pip install .
lo-bot-api-emulator --port 8080
lo-bot-api-emulator --disable-video-uploads --legacy-single-attach
```

Use synthetic tokens and media fixtures. The emulator does not authenticate credentials, transcode video, validate media contents or reproduce storage, permission checks and production rate limits. Unmodeled implemented methods explicitly return 501; they never receive a generic successful response. Bind or expose the fixture only in a test environment.

```sh
docker build -t lo-bot-api-emulator .
docker run --rm -p 127.0.0.1:8080:8080 lo-bot-api-emulator
```

The Python API exposes `LoBotApiEmulator.requests`: method, field names, file-part names and status. It retains no tokens or request text. The synthetic asset store is ephemeral. `video_retry_count` provides deterministic preparation refusals for retry tests.

Regenerate the contract from a checked-out server revision using the repository's `scripts/generate-bot-contract.mjs`. `--check` compares all packaged copies without modifying them. CI executes unchanged aiogram handlers and Telegraf/grammY clients against this fixture, including a negative test that removes compatibility middleware.

Contract provenance is checked against Git source digests. Local verification may use `--allow-working-tree`; its manifest has `source.commit: null`, an explicit base commit and source fingerprint. Such a fixture is unreleased and does not identify a deployed server revision.

Document albums require distinct cached file references. The fixture models the observed core refusal for duplicate document IDs; newly uploaded items create distinct synthetic assets.

## Container releases

The main-only **Publish emulator container** workflow builds a Linux amd64 image from the digest-pinned Dockerfile after Python source, wheel and strict bot-client checks. It starts that exact image using its default command on an ephemeral loopback port, checks synthetic identity, invalid-parameter and stub refusals, installed version and non-root execution, then pushes the same image to `ghcr.io/lo-ink/lo-bot-api-emulator` with version and `sha-<full-commit>` tags. The publisher refuses either existing version or commit tag; authentication, transport and unrecognized registry errors fail closed. There is no force override. Workflow concurrency serializes this publisher; registry administrators must also avoid external writes to release tags during publication. The release artifact records the image ID, registry digest, source revision and smoke results. A receipt is saved immediately after each successful push, so a failed second tag still leaves evidence of the first published digest and fails the job. Ordinary CI runs the same container smoke after its Docker build.

Run the smoke locally from the repository root with `python scripts/check-emulator-container.py lo-bot-api-emulator`. It uses synthetic input and removes only the container it started.

This workflow uses the repository's `GITHUB_TOKEN`; no Docker Hub credentials are needed. A new GHCR package is private by default. Publication does not establish public availability: an owner must separately enable public visibility and verify an anonymous pull of the recorded digest before announcing a public image. No image is claimed published merely because this workflow exists. The pinned base does not make rebuilds deterministic: Python build and runtime dependencies still use version ranges. Use the recorded registry digest to identify an actual release.
