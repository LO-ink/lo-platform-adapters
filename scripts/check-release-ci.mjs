import { pathToFileURL } from "node:url";

const repository = "LO-ink/lo-platform-adapters";
export function selectReleaseRun(runs, workflowId, revision, triggerId) {
  const eligible = runs.filter(
    (run) =>
      run.workflow_id === workflowId &&
      run.head_sha === revision &&
      run.head_branch === "main" &&
      run.head_repository?.full_name === repository &&
      ["push", "workflow_dispatch"].includes(run.event),
  );
  eligible.sort(
    (a, b) =>
      Date.parse(b.run_started_at ?? b.created_at) -
        Date.parse(a.run_started_at ?? a.created_at) || b.id - a.id,
  );
  const latest = eligible[0];
  if (
    !latest ||
    latest.status !== "completed" ||
    latest.conclusion !== "success" ||
    !Number.isSafeInteger(latest.id) ||
    !Number.isFinite(Date.parse(latest.run_started_at ?? latest.created_at)) ||
    (triggerId !== undefined && latest.id !== triggerId)
  )
    throw new Error(
      "Release requires the latest successful Adapter checks run for this exact main revision",
    );
  return latest;
}

export async function verifyReleaseCi({
  revision,
  triggerId,
  token,
  request = fetch,
}) {
  if (
    !/^[a-f0-9]{40}$/.test(revision) ||
    !token ||
    (triggerId !== undefined && !Number.isSafeInteger(triggerId))
  )
    throw new Error(
      "Missing release identity or GitHub Actions read authorization",
    );
  const get = async (path) => {
    const response = await request(
      `https://api.github.com/repos/${repository}/${path}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      },
    );
    if (!response.ok)
      throw new Error(
        `Cannot verify release quality evidence: HTTP ${response.status}`,
      );
    return response.json();
  };
  const workflow = await get("actions/workflows/ci.yml");
  if (
    !Number.isSafeInteger(workflow.id) ||
    workflow.path !== ".github/workflows/ci.yml"
  )
    throw new Error("Invalid Adapter checks workflow identity");
  const result = await get(
    `actions/workflows/${workflow.id}/runs?head_sha=${revision}&per_page=100`,
  );
  if (
    !Array.isArray(result.workflow_runs) ||
    !Number.isSafeInteger(result.total_count) ||
    result.total_count > 100
  )
    throw new Error("Incomplete Adapter checks evidence");
  const latest = selectReleaseRun(
    result.workflow_runs,
    workflow.id,
    revision,
    triggerId,
  );
  if (triggerId !== undefined) {
    const trigger = await get(`actions/runs/${triggerId}`);
    selectReleaseRun([trigger], workflow.id, revision, triggerId);
    if (trigger.run_attempt !== latest.run_attempt)
      throw new Error("Adapter checks evidence changed during verification");
  }
  return latest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const run = await verifyReleaseCi({
    revision: process.env.RELEASE_SHA,
    triggerId: process.env.RELEASE_RUN_ID
      ? Number(process.env.RELEASE_RUN_ID)
      : undefined,
    token: process.env.GH_TOKEN,
  });
  console.log(`Verified Adapter checks run ${run.id} for ${run.head_sha}.`);
}
