import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { Semaphore } from "@core/asyncutil";
import { Logger } from "@logtape/logtape";
import { RequestError } from "octokit";
import unzip from "unzip-stream";
import {
  pagesBuildCheckName,
  releaseBuildCheckName,
  artifactName,
  releaseArtifactPrefix,
  destinationDir,
  rootLogger,
  octokit,
  cacheDownloadDir,
  distributionRepo,
  distributionReleaseName,
  createReleaseAssetName,
  getCachedArtifact,
  getCachedRelease,
  splitRepoName,
  isTargetBranch,
} from "./common.ts";
import {
  DownloadData,
  ReleaseData,
  ReleaseFile,
  PreviewData,
  createSourceKey,
  targetRepos,
  DownloadResult,
  ReleaseResult,
  TargetRepoKey,
  Source as ArtifactSource,
} from "./constants.ts";

type Args = {
  fetchUrlOnly: boolean;
};

async function main() {
  const args = processArgs();
  const { totalSuccessfulDownloads, successfulDownloads, totalTargets } =
    await collectAllArtifacts(args);

  if (totalSuccessfulDownloads === 0) {
    rootLogger.error("No artifacts were collected.");
    process.exit(1);
  }
  const successfulReleases = await collectAllReleases();
  const previewData: PreviewData = {
    downloads: successfulDownloads,
    releases: successfulReleases,
  };
  await fs.writeFile(
    `${destinationDir}/previews.json`,
    JSON.stringify(previewData, null, 2),
  );
  rootLogger.info`Done:`;
  for (const { repoKey, data, numTargets } of Object.values(
    successfulDownloads,
  )) {
    rootLogger.info`${repoKey}: ${data.length} successful downloads / ${numTargets} targets`;
  }
  rootLogger.info`Total: ${totalSuccessfulDownloads} successful downloads / ${totalTargets} targets`;
  for (const { repoKey, data, numTargets } of Object.values(
    successfulReleases,
  )) {
    rootLogger.info`${repoKey}: ${data.length} successful releases / ${numTargets} targets`;
  }
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
    if (!("links" in repo)) {
      continue;
    }
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
  const sources = await fetchTargets(repoKey);

  const downloadTargets = await Promise.all(
    sources.map((source) => collectArtifact(args, repoKey, source)),
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
  const log = getSourceLogger(repoKey, source);

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

async function collectAllReleases(): Promise<Record<string, ReleaseResult>> {
  const successfulReleases: Record<string, ReleaseResult> = {};

  for (const [rawRepoKey, repo] of Object.entries(targetRepos)) {
    if (!("release" in repo)) {
      continue;
    }
    const repoKey = rawRepoKey as TargetRepoKey;
    rootLogger.info`Collecting releases for ${repo.repo}...`;
    successfulReleases[repoKey] = await collectReleases(repoKey);
  }
  return successfulReleases;
}

async function collectReleases(repoKey: TargetRepoKey): Promise<ReleaseResult> {
  const sources = await fetchTargets(repoKey);

  const releaseTargets = await Promise.all(
    sources.map((source) => collectRelease(repoKey, source)),
  );
  const successfulReleases = releaseTargets.filter(
    (releaseTarget) => releaseTarget != undefined,
  );
  return {
    repoKey,
    data: successfulReleases,
    numTargets: releaseTargets.length,
  };
}

async function collectRelease(
  repoKey: TargetRepoKey,
  source: ArtifactSource,
): Promise<ReleaseData | undefined> {
  const log = getSourceLogger(repoKey, source);

  try {
    const release = await fetchRelease(log, source, repoKey);
    log.info("Done.");
    return release;
  } catch (e) {
    log.error`Failed to process: ${e}`;
  }
}

function getSourceLogger(
  repoKey: TargetRepoKey,
  source: ArtifactSource,
): Logger {
  return rootLogger
    .getChild(repoKey)
    .getChild(
      source.type === "branch"
        ? `Branch ${source.branch.name}`
        : `PR #${source.pullRequest.number}`,
    );
}

async function fetchTargets(repoKey: TargetRepoKey): Promise<ArtifactSource[]> {
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

  return [
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
  ].flat();
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
    const runId = await fetchSuccessfulRunId(
      log,
      source,
      repoKey,
      pagesBuildCheckName,
    );

    const cachedUrl = await getCachedArtifact(repoKey, source, runId);
    const downloadUrl =
      cachedUrl || (await fetchArtifactUrl(log, repoKey, runId));

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
    const response = await fetch(this.downloadUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download artifact: ${response.status} ${response.statusText}`,
      );
    }
    if (!response.body) {
      throw new Error("Response body is empty");
    }
    this.log.info`Downloading artifact to ${this.downloadPath}`;
    await fs.mkdir(path.dirname(this.downloadPath), {
      recursive: true,
    });
    await pipeline(
      Readable.fromWeb(response.body),
      fsSync.createWriteStream(this.downloadPath),
    );
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

async function fetchRelease(
  log: Logger,
  source: ArtifactSource,
  repoKey: TargetRepoKey,
): Promise<ReleaseData> {
  const runId = await fetchSuccessfulRunId(
    log,
    source,
    repoKey,
    releaseBuildCheckName,
  );

  const cachedRelease = await getCachedRelease(repoKey, source, runId);
  if (cachedRelease != undefined) {
    return { ...cachedRelease, source, cached: true };
  }

  return {
    source,
    runId,
    cached: false,
    files: await fetchReleaseFiles(repoKey, source, runId),
  };
}

async function fetchSuccessfulRunId(
  log: Logger,
  source: ArtifactSource,
  repoKey: TargetRepoKey,
  checkName: string,
): Promise<number> {
  const jobAndRunId = await getJobAndRunId(log, source, repoKey, checkName);
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
  source: ArtifactSource,
  repoKey: TargetRepoKey,
  checkName: string,
): Promise<{ jobId: number; runId: number } | undefined> {
  log.info("Checking...");
  const checkRuns = await octokit.paginate(
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    {
      ...splitRepoName(repoKey),
      ref:
        source.type === "branch"
          ? source.branch.name
          : source.pullRequest.head.sha,
    },
  );
  const buildCheck = checkRuns.find((checkRun) => checkRun.name === checkName);
  if (!buildCheck) {
    log.info("No build check found");
    return;
  }
  if (!buildCheck.details_url) {
    throw new Error(`Build check "${checkName}" does not have a details URL.`);
  }
  const runId = buildCheck.details_url.match(/(?<=\/runs\/)[0-9]+/)?.[0];
  if (!runId) {
    log.error(
      `Failed to extract check run ID from details URL: ${buildCheck.details_url}`,
    );
    return;
  }
  return { jobId: buildCheck.id, runId: Number.parseInt(runId) };
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

async function fetchArtifactUrl(
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
    (artifact) => artifact.name === artifactName,
  );
  if (!artifact) {
    throw new Error(`Artifact "${artifactName}" not found in run ${runId}`);
  }

  const downloadUrl = artifact.archive_download_url;
  if (!downloadUrl) {
    throw new Error(
      `Artifact "${artifactName}" does not have a download URL in run ${runId}`,
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

async function fetchReleaseFiles(
  repoKey: TargetRepoKey,
  source: ArtifactSource,
  runId: number,
): Promise<ReleaseFile[]> {
  const artifacts = await octokit.paginate(
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
    {
      ...splitRepoName(repoKey),
      run_id: runId,
    },
  );
  const releaseArtifacts = artifacts.filter((artifact) =>
    artifact.name.startsWith(releaseArtifactPrefix),
  );
  if (releaseArtifacts.length === 0) {
    throw new Error(
      `Artifact "${releaseArtifactPrefix}*" not found in run ${runId}`,
    );
  }
  const expiredArtifact = releaseArtifacts.find((artifact) => artifact.expired);
  if (expiredArtifact != undefined) {
    throw new Error(
      `Artifact "${expiredArtifact.name}" is expired in run ${runId}`,
    );
  }

  return releaseArtifacts.map((artifact) => {
    const name = artifact.name.slice(releaseArtifactPrefix.length);
    return {
      name,
      size: artifact.size_in_bytes,
      artifactId: artifact.id,
      url: createReleaseAssetUrl(
        createReleaseAssetName(repoKey, source, runId, name),
      ),
    };
  });
}

function createReleaseAssetUrl(assetName: string): string {
  return `https://github.com/${distributionRepo}/releases/download/${distributionReleaseName}/${assetName}`;
}

await main();
