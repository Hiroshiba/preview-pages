import { Semaphore } from "@core/asyncutil";
import { Logger } from "@logtape/logtape";
import { RequestError } from "octokit";
import {
  artifactName,
  octokit,
  pagesBuildCheckName,
  splitRepoName,
} from "./common.ts";

const jobWaitSemaphore = new Semaphore(5);

type JobAndRunId = { jobId: number; runId: number };
type Artifact = Awaited<
  ReturnType<typeof octokit.rest.actions.listWorkflowRunArtifacts>
>["data"]["artifacts"][number];

function getRunId(detailsUrl: string | null): number {
  if (detailsUrl == null || detailsUrl === "") {
    throw new Error(
      `Build check "${pagesBuildCheckName}" does not have a details URL.`,
    );
  }
  const runId = detailsUrl.match(/(?<=\/runs\/)[0-9]+/)?.[0];
  if (runId == undefined) {
    throw new Error(
      `Failed to extract check run ID from details URL: ${detailsUrl}`,
    );
  }
  return Number.parseInt(runId);
}

/** 指定refのプレビュー用jobとActions runを取得する。 */
export async function getJobAndRunId(
  log: Logger,
  repo: `${string}/${string}`,
  ref: string,
): Promise<JobAndRunId | undefined> {
  log.info("Checking...");
  const checkRuns = await octokit.paginate(
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    { ...splitRepoName(repo), ref },
  );
  const buildPageCheck = checkRuns.find(
    (checkRun) => checkRun.name === pagesBuildCheckName,
  );
  if (buildPageCheck == undefined) {
    log.info("No build check found");
    return;
  }
  return {
    jobId: buildPageCheck.id,
    runId: getRunId(buildPageCheck.details_url),
  };
}

/** 選択したcommitとbranchに一致するプレビュー用runを取得する。 */
export async function getJobAndRunIdForBranch(
  log: Logger,
  repo: `${string}/${string}`,
  branch: string,
  commitSha: string,
): Promise<JobAndRunId | undefined> {
  log.info("Checking...");
  const checkRuns = await octokit.paginate(
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    { ...splitRepoName(repo), ref: commitSha },
  );
  for (const checkRun of checkRuns) {
    if (checkRun.name !== pagesBuildCheckName) {
      continue;
    }
    const runId = getRunId(checkRun.details_url);
    const { data: run } = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
      { ...splitRepoName(repo), run_id: runId },
    );
    if (run.head_sha === commitSha && run.head_branch === branch) {
      return { jobId: checkRun.id, runId };
    }
  }
  log.info("No matching build check found");
}

/** プレビュー用jobの成功を待つ。 */
export async function waitForJobCompletion(
  log: Logger,
  jobId: number,
  repo: `${string}/${string}`,
): Promise<boolean> {
  let success = false;
  let done = false;
  // タイムアウト：5分
  for (let i = 0; i < 20; i++) {
    done = await jobWaitSemaphore.lock(async () => {
      const { data: job } = await octokit.request(
        "GET /repos/{owner}/{repo}/actions/jobs/{job_id}",
        { ...splitRepoName(repo), job_id: jobId },
      );
      if (job.status === "completed") {
        success = job.conclusion === "success";
        return true;
      }
      log.info`Waiting for job #${jobId} to complete...`;
      await new Promise((resolve) => setTimeout(resolve, 15000));
      return false;
    });
    if (done) {
      break;
    }
  }
  if (!done) {
    log.error`Job #${jobId} did not complete within the timeout period.`;
    return false;
  }
  if (!success) {
    log.error`Job #${jobId} did not complete successfully.`;
    return false;
  }
  return true;
}

/** Artifactの取得先URLをZIP取得前に解決する。 */
export async function fetchArtifactDownloadUrl(
  log: Logger,
  repo: `${string}/${string}`,
  artifact: Artifact,
): Promise<string | undefined> {
  log.info`Fetching artifact URL: ${artifact.name}`;
  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
      {
        ...splitRepoName(repo),
        artifact_id: artifact.id,
        archive_format: "zip",
        request: { redirect: "manual", parseSuccessResponseBody: false },
      },
    );
    if (response.data instanceof ReadableStream) {
      await response.data.cancel();
    }
    if (
      response.status !== 302 ||
      response.headers.location == null ||
      response.headers.location === ""
    ) {
      throw new Error(`Artifactの取得先を解決できません: ${artifact.name}`);
    }
    return new URL(response.headers.location, response.url).href;
  } catch (error) {
    if (error instanceof RequestError && error.status === 410) {
      log.error("Artifact is expired");
      return;
    }
    throw error;
  }
}

/** 指定runのArtifactを処理直前に取得する。 */
export async function fetchArtifactUrl(
  log: Logger,
  repo: `${string}/${string}`,
  runId: number,
): Promise<string | undefined> {
  const buildPage = await octokit.request(
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
    { ...splitRepoName(repo), run_id: runId },
  );
  const artifact = buildPage.data.artifacts.find(
    (artifact) => artifact.name === artifactName,
  );
  if (artifact == undefined) {
    throw new Error(`Artifact "${artifactName}" not found in run ${runId}`);
  }
  return fetchArtifactDownloadUrl(log, repo, artifact);
}

/** 指定runの配布用Artifactを全ページから取得する。 */
export async function fetchReleaseArtifacts(
  repo: `${string}/${string}`,
  runId: number,
): Promise<Artifact[]> {
  const artifacts = await octokit.paginate(
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
    { ...splitRepoName(repo), run_id: runId, per_page: 100 },
  );
  const releaseArtifacts = artifacts.filter((artifact) =>
    artifact.name.startsWith("preview-pages-download-"),
  );
  if (releaseArtifacts.length === 0) {
    throw new Error(`No release artifacts found in run ${runId}`);
  }
  return releaseArtifacts;
}
