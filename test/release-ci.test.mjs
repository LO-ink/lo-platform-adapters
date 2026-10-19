import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import {
  selectReleaseRun,
  verifyReleaseCi,
} from "../scripts/check-release-ci.mjs";
const revision = "a".repeat(40);
const success = {
  id: 10,
  workflow_id: 3,
  head_sha: revision,
  head_branch: "main",
  head_repository: { full_name: "LO-ink/lo-platform-adapters" },
  event: "push",
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
  run_started_at: "2026-10-06T00:00:00Z",
};

test("release gate requires exact workflow, repository, branch, revision and completed success", () => {
  assert.equal(selectReleaseRun([success], 3, revision).id, 10);
  for (const changes of [
    { workflow_id: 4 },
    { head_sha: "b".repeat(40) },
    { head_branch: "feature" },
    { head_repository: { full_name: "foreign/lo-platform-adapters" } },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { run_started_at: "bad" },
  ])
    assert.throws(() =>
      selectReleaseRun([{ ...success, ...changes }], 3, revision),
    );
  assert.throws(() => selectReleaseRun([], 3, revision));
  assert.throws(() => selectReleaseRun([success], 3, revision, 11));
});

test("a newer failed or running attempt cannot be hidden behind an older success", () => {
  for (const changes of [
    { conclusion: "failure" },
    { status: "in_progress", conclusion: null },
  ]) {
    const newer = {
      ...success,
      id: 11,
      run_started_at: "2026-10-06T00:01:00Z",
      ...changes,
    };
    assert.throws(() => selectReleaseRun([success, newer], 3, revision));
  }
});

test("API verification fails closed and verifies automatic trigger identity", async () => {
  const request = async (url, options) => {
    assert.equal(options.redirect, "error");
    if (url.endsWith("ci.yml"))
      return Response.json({ id: 3, path: ".github/workflows/ci.yml" });
    if (url.endsWith("/10")) return Response.json(success);
    assert.ok(url.includes(`head_sha=${revision}`));
    return Response.json({ total_count: 1, workflow_runs: [success] });
  };
  assert.equal(
    (
      await verifyReleaseCi({
        revision,
        triggerId: 10,
        token: "synthetic",
        request,
      })
    ).id,
    10,
  );
  await assert.rejects(
    verifyReleaseCi({
      revision,
      token: "synthetic",
      request: async () => new Response(null, { status: 503 }),
    }),
  );
  await assert.rejects(
    verifyReleaseCi({
      revision,
      token: "synthetic",
      request: async () => {
        throw new Error("Network unavailable");
      },
    }),
  );
});

function publicationFixture({
  main = revision,
  head = revision,
  failure,
  runs = [success],
} = {}) {
  const requests = [];
  return {
    requests,
    options: {
      revision,
      token: "synthetic",
      beforePublish: true,
      sourceRepository: "LO-ink/lo-platform-adapters",
      execute(command, args) {
        assert.equal(command, "git");
        assert.deepEqual(args, ["rev-parse", "HEAD"]);
        return head + "\n";
      },
      async request(url, options) {
        requests.push(url);
        assert.equal(options.redirect, "error");
        assert.equal(options.headers.authorization, "Bearer synthetic");
        if (url.endsWith("/commits/main")) {
          if (failure instanceof Error) throw failure;
          if (failure) return new Response(null, { status: failure });
          return Response.json({ sha: main });
        }
        if (url.endsWith("ci.yml"))
          return Response.json({ id: 3, path: ".github/workflows/ci.yml" });
        return Response.json({ total_count: runs.length, workflow_runs: runs });
      },
    },
  };
}

test("publication rechecks current main after exact-revision CI; an old successful A cannot upload after B", async () => {
  const current = publicationFixture();
  assert.equal((await verifyReleaseCi(current.options)).head_sha, revision);
  assert.ok(current.requests.at(-1).endsWith("/commits/main"));
  const stale = publicationFixture({ main: "b".repeat(40) });
  // Initial planning can still inspect old immutable artifacts without writing.
  assert.equal(
    (await verifyReleaseCi({ ...stale.options, beforePublish: false }))
      .head_sha,
    revision,
  );
  let uploads = 0;
  await assert.rejects(async () => {
    await verifyReleaseCi(stale.options);
    uploads++;
  }, /source is stale/);
  assert.equal(uploads, 0);
});

test("publication refuses missing identity, foreign repository, checkout mismatch and unverified main", async () => {
  for (const invalid of [
    { revision: undefined },
    { revision: "bad" },
    { token: "" },
    { sourceRepository: undefined },
    { sourceRepository: "foreign/lo-platform-adapters" },
  ]) {
    const fixture = publicationFixture();
    await assert.rejects(verifyReleaseCi({ ...fixture.options, ...invalid }));
    assert.deepEqual(fixture.requests, []);
  }
  for (const state of [
    { head: "b".repeat(40) },
    { head: "invalid" },
    { main: null },
    { main: "bad" },
    { main: [] },
    { failure: 401 },
    { failure: 403 },
    { failure: 503 },
    { failure: new Error("network unavailable") },
    { runs: [{ ...success, conclusion: "failure" }] },
  ])
    await assert.rejects(verifyReleaseCi(publicationFixture(state).options));
});

test("both manual publishers verify quality before artifacts or registry access", () => {
  const python = parse(
    readFileSync(
      new URL("../.github/workflows/publish-python.yml", import.meta.url),
      "utf8",
    ),
  );
  const container = parse(
    readFileSync(
      new URL("../.github/workflows/publish-emulator.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(python.jobs.plan.permissions.actions, "read");
  const pythonSteps = python.jobs.plan.steps;
  const gate = pythonSteps.findIndex(
    (step) => step.run === "make release-check",
  );
  assert.ok(
    gate >= 0 && gate < pythonSteps.findIndex((step) => step.id === "releases"),
  );
  assert.ok(python.jobs.publish.needs.includes("plan"));
  assert.equal(python.jobs.publish.permissions.contents, "read");
  assert.equal(python.jobs.publish.permissions.actions, "read");
  const publishSteps = python.jobs.publish.steps;
  const upload = publishSteps.findIndex((step) =>
    step.uses?.startsWith("pypa/gh-action-pypi-publish@"),
  );
  const lastGuard = publishSteps[upload - 1];
  assert.equal(
    lastGuard.run,
    "node scripts/check-release-ci.mjs --before-publish",
  );
  assert.equal(lastGuard.if, "steps.uploads.outputs.has_uploads == 'true'");
  assert.equal(publishSteps[upload].if, lastGuard.if);
  assert.equal(lastGuard.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(lastGuard.env.RELEASE_SHA, pythonSteps[gate].env.RELEASE_SHA);
  assert.equal(
    lastGuard.env.RELEASE_RUN_ID,
    pythonSteps[gate].env.RELEASE_RUN_ID,
  );
  assert.ok(
    publishSteps
      .slice(0, upload)
      .some((step) => step.uses?.startsWith("actions/setup-node@")),
  );
  assert.ok(
    publishSteps.findIndex((step) => step.id === "uploads") < upload - 1,
  );
  assert.equal(container.jobs.publish.permissions.actions, "read");
  const steps = container.jobs.publish.steps;
  const containerGate = steps.findIndex(
    (step) => step.run === "make release-check",
  );
  assert.ok(
    containerGate >= 0 &&
      containerGate <
        steps.findIndex(
          (step) => step.name === "Check source consumers and distributions",
        ),
  );
  const push = steps.find((step) =>
    step.run?.includes("python scripts/publish-emulator-container.py"),
  );
  assert.equal(push.env.GH_TOKEN, "${{ github.token }}");
  assert.ok(push.run.includes('"$EMULATOR_VERSION" "$GITHUB_SHA" release'));
});
