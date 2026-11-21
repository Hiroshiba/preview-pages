import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { Semaphore } from "@core/asyncutil";
import { Logger } from "@logtape/logtape";
import { RequestError } from "octokit";
import unzip from "unzip-stream";
import {
  pagesBuildCheckName,
  webArtifactName,
  releaseArtifactPrefix,
  destinationDir,
  rootLogger,
  octokit,
  cacheDownloadDir,
  createSourceKey,
  getCachedArtifact,
  splitRepoName,
  isTargetBranch,
} from "./common.ts";
import {
  DownloadData,
  targetRepos,
  DownloadResult,
  TargetRepoKey,
  Branch,
  PullRequest,
  Source as ArtifactSource,
} from "./constants.ts";
import {
  fetchArtifactBody,
  fetchArtifactDownloadUrl,
  ReleaseArtifact,
} from "./artifact.ts";
import { ReleaseSelection, ReleaseSource } from "./release.ts";

type Args = {
  fetchUrlOnly: boolean;
};

async function main() {
  const args = processArgs();
  const { totalSuccessfulDownloads, successfulDownloads, totalTargets } =
    await collectAllArtifacts(args);
  const releaseSelections = await selectAllReleases(args);

  if (totalSuccessfulDownloads + releaseSelections.length === 0) {
    rootLogger.error("No artifacts were collected.");
    process.exit(1);
  }
  await fs.writeFile(
    `${destinationDir}/downloads.json`,
    JSON.stringify(successfulDownloads, null, 2),
  );
  await fs.writeFile(
    `${cacheDownloadDir}/releaseSelections.json`,
    JSON.stringify(releaseSelections, null, 2),
  );
  rootLogger.info`Done:`;
  for (const { repoKey, data, numTargets } of Object.values(
    successfulDownloads,
  )) {
    rootLogger.info`${repoKey}: ${data.length} successful downloads / ${numTargets} targets`;
  }
  rootLogger.info`Releases: ${releaseSelections.length} selected / ${Object.values(targetRepos).filter((repo) => repo.releaseBranch != undefined).length} targets`;
  rootLogger.info`Total: ${totalSuccessfulDownloads} successful downloads / ${totalTargets} targets`;
}

function processArgs(): Args {
  const { values: args } = parseArgs({
    options: {
      fetchUrlOnly: {
        type: "boolean",
      },
      help: {
        type: "boolean",
      },
    },
    args: process.argv.slice(2),
  });

  if (args.help) {
    console.log(`Usage: collectArtifacts.ts [--fetchUrlOnly]`);
    console.log(
      `--fetchUrlOnly: ダウンロードURLのみを取得し、実際のダウンロードは行わない。`,
    );
    process.exit(0);
  }
  if (args.fetchUrlOnly) {
    rootLogger.info("--fetchUrlOnly option is enabled.");
  }

  return {
    fetchUrlOnly: args.fetchUrlOnly ?? false,
  };
}

async function collectAllArtifacts(args: Args) {
  const successfulDownloads: Record<string, DownloadResult> = {};

  let totalSuccessfulDownloads = 0;
  let totalTargets = 0;

  for (const [rawRepoKey, repo] of Object.entries(targetRepos)) {
    const repoKey = rawRepoKey as TargetRepoKey;
    rootLogger.info`Collecting artifacts for ${repo.repo}...`;
    const downloads = await collectArtifacts(args, repoKey);

    successfulDownloads[repoKey] = downloads;
    totalSuccessfulDownloads += downloads.data.length;
    totalTargets += downloads.numTargets;
  }
  return { totalSuccessfulDownloads, successfulDownloads, totalTargets };
}

async function collectArtifacts(
  args: Args,
  repoKey: TargetRepoKey,
): Promise<DownloadResult> {
  if (targetRepos[repoKey].links == undefined) {
    return { repoKey, data: [], numTargets: 0 };
  }
  const { filteredBranches, pullRequests } = await fetchTargets(repoKey);

  const downloadTargets = await Promise.all(
    [
      filteredBranches.map(
        (branch) =>
          ({
            type: "branch",
            branch,
          }) as const,
      ),
      pullRequests.map(
        (pullRequest) =>
          ({
            type: "pullRequest",
            pullRequest,
          }) as const,
      ),
    ]
      .flat()
      .map((source) => collectArtifact(args, repoKey, source)),
  );
  const successfulDownloads = downloadTargets.filter(
    (downloadTarget) => downloadTarget != undefined,
  );
  return {
    repoKey,
    data: successfulDownloads,
    numTargets: downloadTargets.length,
  };
}

async function collectArtifact(
  args: Args,
  repoKey: TargetRepoKey,
  source: ArtifactSource,
): Promise<DownloadData | undefined> {
  const log = rootLogger
    .getChild(repoKey)
    .getChild(
      source.type === "branch"
        ? `Branch ${source.branch.name}`
        : `PR #${source.pullRequest.number}`,
    );

  try {
    const artifact = await Artifact.fetch(log, source, repoKey);

    if (args.fetchUrlOnly) {
      log.info`Download skipped: ${artifact.downloadUrl}`;
    } else {
      await artifact.downloadAndExtract();
      log.info("Done.");
    }

    return artifact.toDownloadData();
  } catch (e) {
    log.error`Failed to process: ${e}`;
  }
}

async function fetchTargets(repoKey: TargetRepoKey): Promise<{
  filteredBranches: Branch[];
  pullRequests: PullRequest[];
}> {
  const branches = await octokit.paginate(
    "GET /repos/{owner}/{repo}/branches",
    splitRepoName(repoKey),
  );
  const filteredBranches = branches.filter((branch) =>
    isTargetBranch(branch.name),
  );

  const pullRequests = await octokit.paginate(
    "GET /repos/{owner}/{repo}/pulls",
    {
      ...splitRepoName(repoKey),
      state: "open",
    },
  );

  return { filteredBranches, pullRequests };
}

export class Artifact {
  constructor(
    private readonly log: Logger,
    public readonly repoKey: TargetRepoKey,
    public readonly source: ArtifactSource,
    public readonly runId: number,
    public readonly cached: boolean,
    public readonly downloadUrl: string,
  ) {}

  static async fetch(
    log: Logger,
    source: ArtifactSource,
    repoKey: TargetRepoKey,
  ): Promise<Artifact> {
    const runId = await getSuccessfulRunId(
      log,
      source.type === "branch"
        ? source.branch.name
        : source.pullRequest.head.sha,
      repoKey,
    );

    const cachedUrl = await getCachedArtifact(repoKey, source, runId);
    const downloadUrl =
      cachedUrl || (await fetchWebArtifactUrl(log, repoKey, runId));

    if (!downloadUrl) {
      throw new Error(`Failed to fetch artifact URL for run ${runId}`);
    }

    return new Artifact(
      log,
      repoKey,
      source,
      runId,
      cachedUrl != null,
      downloadUrl,
    );
  }

  toDownloadData(): DownloadData {
    return {
      source: this.source,
      cached: this.cached,
      pathFragment: this.outputPathFragment,
      runId: this.runId,
    };
  }

  get outputPathFragment(): string {
    return `${this.repoKey}/${createSourceKey(this.source)}`;
  }

  get downloadPath(): string {
    return `${cacheDownloadDir}/${this.outputPathFragment}.zip`;
  }

  get infoPath(): string {
    return `${cacheDownloadDir}/${this.outputPathFragment}.json`;
  }

  get outputDirPath(): string {
    return `${destinationDir}/${this.outputPathFragment}`;
  }

  async downloadAndExtract(): Promise<void> {
    await this.downloadArtifact();
    await this.writeDownloadInfo();
    await this.extractArtifact();
    this.log.info`Downloaded and extracted artifact to ${this.outputDirPath}`;
  }

  private async downloadArtifact(): Promise<void> {
    this.log.info`Downloading artifact from ${this.downloadUrl}`;
    const body = await fetchArtifactBody(this.downloadUrl);
    this.log.info`Downloading artifact to ${this.downloadPath}`;
    await fs.mkdir(path.dirname(this.downloadPath), {
      recursive: true,
    });
    await pipeline(body, fsSync.createWriteStream(this.downloadPath));
  }

  private async writeDownloadInfo(): Promise<void> {
    const downloadData: DownloadData = this.toDownloadData();

    await fs.mkdir(path.dirname(this.infoPath), {
      recursive: true,
    });

    this.log.info`Writing download info to ${this.infoPath}`;
    await fs.writeFile(this.infoPath, JSON.stringify(downloadData, null, 2));
  }

  private async extractArtifact(): Promise<void> {
    this.log.info`Extracting artifact to ${this.outputDirPath}`;
    await fs.mkdir(this.outputDirPath, { recursive: true });
    await pipeline(
      fsSync.createReadStream(this.downloadPath),
      unzip.Extract({ path: this.outputDirPath }),
    );
  }
}

async function getSuccessfulRunId(
  log: Logger,
  ref: string,
  repoKey: TargetRepoKey,
): Promise<number> {
  const jobAndRunId = await getJobAndRunId(log, ref, repoKey);
  if (jobAndRunId == undefined) {
    throw new Error("No job found");
  }

  const { jobId, runId } = jobAndRunId;
  log.info`Job ID: ${jobId}, Run ID: ${runId}`;
  const success = await waitForJobCompletion(log, jobId, repoKey);

  if (!success) {
    throw new Error(`Job #${jobId} did not complete successfully`);
  }
  return runId;
}

async function getJobAndRunId(
  log: Logger,
  ref: string,
  repoKey: TargetRepoKey,
): Promise<{ jobId: number; runId: number } | undefined> {
  log.info("Checking...");
  const checkRuns = await octokit.paginate(
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    {
      ...splitRepoName(repoKey),
      ref,
    },
  );
  const buildPageCheck = checkRuns.find(
    (checkRun) => checkRun.name === pagesBuildCheckName,
  );
  if (!buildPageCheck) {
    log.info("No build check found");
    return;
  }
  if (!buildPageCheck.details_url) {
    throw new Error(
      `Build check "${pagesBuildCheckName}" does not have a details URL.`,
    );
  }
  const runId = buildPageCheck.details_url.match(/(?<=\/runs\/)[0-9]+/)?.[0];
  if (!runId) {
    log.error(
      `Failed to extract check run ID from details URL: ${buildPageCheck.details_url}`,
    );
    return;
  }
  return { jobId: buildPageCheck.id, runId: Number.parseInt(runId) };
}

const jobWaitSemaphore = new Semaphore(5);
async function waitForJobCompletion(
  log: Logger,
  jobId: number,
  repoKey: TargetRepoKey,
): Promise<boolean> {
  let success = false;
  let done = false;
  // タイムアウト：5分
  for (let i = 0; i < 20; i++) {
    done = await jobWaitSemaphore.lock(async () => {
      const { data: job } = await octokit.request(
        "GET /repos/{owner}/{repo}/actions/jobs/{job_id}",
        {
          ...splitRepoName(repoKey),
          job_id: jobId,
        },
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
  } else {
    return true;
  }
}

async function fetchWebArtifactUrl(
  log: Logger,
  repoKey: TargetRepoKey,
  runId: number,
): Promise<string | undefined> {
  const buildPage = await octokit.request(
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
    {
      ...splitRepoName(repoKey),
      run_id: runId,
    },
  );
  const artifact = buildPage.data.artifacts.find(
    (artifact) => artifact.name === webArtifactName,
  );
  if (!artifact) {
    throw new Error(`Artifact "${webArtifactName}" not found in run ${runId}`);
  }

  const downloadUrl = artifact.archive_download_url;
  if (!downloadUrl) {
    throw new Error(
      `Artifact "${webArtifactName}" does not have a download URL in run ${runId}`,
    );
  }
  log.info`Fetching artifact URL from ${downloadUrl}`;

  let innerDownloadUrl: string;
  try {
    innerDownloadUrl = await octokit
      .request(
        "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
        {
          ...splitRepoName(repoKey),
          artifact_id: artifact.id,
          archive_format: "zip",
        },
      )
      .then((response) => response.url);
  } catch (e) {
    if (e instanceof RequestError && e.status === 410) {
      log.error("Artifact is expired");
      return;
    }
    throw e;
  }

  return innerDownloadUrl;
}

async function selectAllReleases(args: Args): Promise<ReleaseSelection[]> {
  const releaseSelections: ReleaseSelection[] = [];
  for (const [rawRepoKey, repo] of Object.entries(targetRepos)) {
    if (repo.releaseBranch == undefined) {
      continue;
    }
    const repoKey = rawRepoKey as TargetRepoKey;
    rootLogger.info`Selecting releases for ${repo.repo}...`;
    const releaseSelection = await selectRelease(
      args,
      repoKey,
      repo.releaseBranch,
    );
    if (releaseSelection != undefined) {
      releaseSelections.push(releaseSelection);
    }
  }
  return releaseSelections;
}

async function selectRelease(
  args: Args,
  repoKey: TargetRepoKey,
  branchName: string,
): Promise<ReleaseSelection | undefined> {
  const log = rootLogger.getChild(repoKey).getChild(`Branch ${branchName}`);

  try {
    const source = await fetchReleaseSource(log, repoKey, branchName);
    const artifacts = await fetchReleaseArtifacts(repoKey, source.runId);

    if (args.fetchUrlOnly) {
      for (const artifact of artifacts) {
        const url = await fetchArtifactDownloadUrl(log, repoKey, artifact);
        log.info`Download skipped: ${url}`;
      }
    }

    log.info("Done.");
    return { source, artifacts };
  } catch (e) {
    log.error`Failed to process: ${e}`;
  }
}

async function fetchReleaseSource(
  log: Logger,
  repoKey: TargetRepoKey,
  branchName: string,
): Promise<ReleaseSource> {
  const { data: branch } = await octokit.rest.repos.getBranch({
    ...splitRepoName(repoKey),
    branch: branchName,
  });
  const runId = await getSuccessfulRunId(log, branch.commit.sha, repoKey);
  return { repoKey, branch: branch.name, commitSha: branch.commit.sha, runId };
}

async function fetchReleaseArtifacts(
  repoKey: TargetRepoKey,
  runId: number,
): Promise<ReleaseArtifact[]> {
  const artifacts = await octokit.paginate(
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
    { ...splitRepoName(repoKey), run_id: runId, per_page: 100 },
  );
  return artifacts
    .filter((artifact) => artifact.name.startsWith(releaseArtifactPrefix))
    .map(({ id, name }) => ({ id, name }));
}

await main();
