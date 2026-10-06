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
});
