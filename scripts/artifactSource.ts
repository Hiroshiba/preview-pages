import { Semaphore } from "@core/asyncutil";
import { Logger } from "@logtape/logtape";
import { RequestError } from "octokit";
import { octokit, pagesBuildCheckName, splitRepoName } from "./common.ts";

const jobWaitSemaphore = new Semaphore(5);

/** 指定refのプレビュー用jobとActions runを取得する。 */
export async function getJobAndRunId(
  log: Logger,
  repo: `${string}/${string}`,
  ref: string,
): Promise<{ jobId: number; runId: number } | undefined> {
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
  if (buildPageCheck.details_url == null || buildPageCheck.details_url === "") {
    throw new Error(
      `Build check "${pagesBuildCheckName}" does not have a details URL.`,
    );
  }
  const runId = buildPageCheck.details_url.match(/(?<=\/runs\/)[0-9]+/)?.[0];
  if (runId == undefined) {
    log.error(
      `Failed to extract check run ID from details URL: ${buildPageCheck.details_url}`,
    );
    return;
  }
  return { jobId: buildPageCheck.id, runId: Number.parseInt(runId) };
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

/** 指定runのArtifactを処理直前に取得する。 */
export async function fetchArtifactUrl(
  log: Logger,
  repo: `${string}/${string}`,
  runId: number,
  name: string,
): Promise<string | undefined> {
  const buildPage = await octokit.request(
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
    { ...splitRepoName(repo), run_id: runId },
  );
  const artifact = buildPage.data.artifacts.find(
    (artifact) => artifact.name === name,
  );
  if (artifact == undefined) {
    throw new Error(`Artifact "${name}" not found in run ${runId}`);
  }
  if (
    artifact.archive_download_url == null ||
    artifact.archive_download_url === ""
  ) {
    throw new Error(
      `Artifact "${name}" does not have a download URL in run ${runId}`,
    );
  }
  log.info`Fetching artifact URL from ${artifact.archive_download_url}`;

  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
      {
        ...splitRepoName(repo),
        artifact_id: artifact.id,
        archive_format: "zip",
      },
    );
    return response.url;
  } catch (error) {
    if (error instanceof RequestError && error.status === 410) {
      log.error("Artifact is expired");
      return;
    }
    throw error;
  }
}
