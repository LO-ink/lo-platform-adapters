# LO Bot API emulator

A local request-contract fixture for bot migrations. It loads the same generated manifest as the LO HTTP transport and `lo-aiogram`; it rejects unknown fields, stubbed methods, invalid upload references, upload-only metadata on cached videos, and unsupported albums.

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
