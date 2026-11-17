import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { Semaphore } from "@core/asyncutil";
import { Logger } from "@logtape/logtape";
import { Endpoints } from "@octokit/types";
import { RequestError } from "octokit";
import unzip from "unzip-stream";
import {
  pagesBuildCheckName,
  artifactName,
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
  releaseTargets,
  DownloadResult,
  TargetRepoKey,
  ReleaseTargetKey,
  ReleaseData,
  Branch,
  PullRequest,
  Source as ArtifactSource,
} from "./constants.ts";
import {
  Asset,
  createRelease,
  ensureReleaseAsset,
  getRelease,
  publishRelease,
} from "./release.ts";

type Args = {
  fetchUrlOnly: boolean;
};

type ReleaseSource = {
  key: ReleaseTargetKey;
  commitSha: string;
  runId: number;
};

type WorkflowArtifact =
  Endpoints["GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts"]["response"]["data"]["artifacts"][number];

async function main() {
  const args = processArgs();
  const { totalSuccessfulDownloads, successfulDownloads, totalTargets } =
    await collectAllArtifacts(args);
  const releases = await collectAllReleases(args);

  if (totalSuccessfulDownloads + releases.length === 0) {
    rootLogger.error("No artifacts were collected.");
    process.exit(1);
  }
  await fs.writeFile(
    `${destinationDir}/downloads.json`,
    JSON.stringify(successfulDownloads, null, 2),
  );
  await fs.writeFile(
    `${destinationDir}/releases.json`,
    JSON.stringify(releases, null, 2),
  );
  rootLogger.info`Done:`;
  for (const { repoKey, data, numTargets } of Object.values(
    successfulDownloads,
  )) {
    rootLogger.info`${repoKey}: ${data.length} successful downloads / ${numTargets} targets`;
  }
  rootLogger.info`Releases: ${releases.length} published / ${Object.keys(releaseTargets).length} targets`;
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
    const jobAndRunId = await getJobAndRunId(
      log,
      source.type === "branch"
        ? source.branch.name
        : source.pullRequest.head.sha,
      repoKey,
    );
    if (jobAndRunId == undefined) {
      throw new Error("No job found");
    }

    const { jobId, runId } = jobAndRunId;
    log.info`Job ID: ${jobId}, Run ID: ${runId}`;
    const success = await waitForJobCompletion(log, jobId, repoKey);

    if (!success) {
      throw new Error(`Job #${jobId} did not complete successfully`);
    }

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

async function getJobAndRunId(
  log: Logger,
  ref: string,
  repoKey: TargetRepoKey | `${string}/${string}`,
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
  repoKey: TargetRepoKey | `${string}/${string}`,
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

/** 配布対象の配布物を収集する。 */
async function collectAllReleases(args: Args): Promise<ReleaseData[]> {
  const releases: ReleaseData[] = [];
  for (const [rawReleaseKey, target] of Object.entries(releaseTargets)) {
    const releaseKey = rawReleaseKey as ReleaseTargetKey;
    rootLogger.info`Collecting releases for ${target.repo}...`;
    const log = rootLogger.getChild(releaseKey);
    try {
      const releaseSource = await selectReleaseSource(log, releaseKey);
      if (args.fetchUrlOnly) {
        await checkReleaseArtifacts(log, releaseSource);
      } else {
        releases.push(await collectRelease(log, releaseSource));
      }
    } catch (e) {
      log.error`Failed to process: ${e}`;
    }
  }
  return releases;
}

/** 配布対象のbranchの成功runを選ぶ。 */
async function selectReleaseSource(
  log: Logger,
  key: ReleaseTargetKey,
): Promise<ReleaseSource> {
  const target = releaseTargets[key];
  const { data: branch } = await octokit.rest.repos.getBranch({
    ...splitRepoName(target.repo),
    branch: target.branch,
  });
  const jobAndRunId = await getJobAndRunId(log, target.branch, target.repo);
  if (jobAndRunId == undefined) {
    throw new Error("No job found");
  }

  const { jobId, runId } = jobAndRunId;
  log.info`Job ID: ${jobId}, Run ID: ${runId}`;
  const success = await waitForJobCompletion(log, jobId, target.repo);

  if (!success) {
    throw new Error(`Job #${jobId} did not complete successfully`);
  }

  return { key, commitSha: branch.commit.sha, runId };
}

/** 選択したrunの配布用Artifactを取得できるか確認する。 */
async function checkReleaseArtifacts(
  log: Logger,
  source: ReleaseSource,
): Promise<void> {
  const target = releaseTargets[source.key];
  const artifacts = await fetchReleaseArtifacts(target.repo, source.runId);
  for (const artifact of artifacts) {
    await fetchArtifactDownloadUrl(log, target.repo, artifact);
    log.info`Download skipped: ${artifact.name}`;
  }
}

/** 選択したrunの配布ファイルをReleaseへ保存する。 */
async function collectRelease(
  log: Logger,
  source: ReleaseSource,
): Promise<ReleaseData> {
  const target = releaseTargets[source.key];
  const existingRelease = await getRelease(source.key, source.runId);
  if (existingRelease != undefined && !existingRelease.draft) {
    return toReleaseData(source, existingRelease.assets);
  }

  const artifacts = await fetchReleaseArtifacts(target.repo, source.runId);
  const release =
    existingRelease ??
    (await createRelease(source.key, source.runId, source.commitSha));
  const assets: Asset[] = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "preview-release-"));
  try {
    const filePath = path.join(tempDir, "entry");
    for (const artifact of artifacts) {
      const url = await fetchArtifactDownloadUrl(log, target.repo, artifact);
      await forEachZipEntry(url, async (entry) => {
        if (entry.type === "Directory") {
          entry.autodrain();
          return;
        }
        const name = path.posix.basename(entry.path);
        if (assets.some((asset) => asset.name === name)) {
          throw new Error(`Duplicate release file name: ${name}`);
        }
        await pipeline(entry, fsSync.createWriteStream(filePath));
        assets.push(await ensureReleaseAsset(release, name, filePath));
      });
    }
    await publishRelease(release);
    return toReleaseData(source, assets);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function toReleaseData(source: ReleaseSource, assets: Asset[]): ReleaseData {
  return {
    key: source.key,
    branch: releaseTargets[source.key].branch,
    commitSha: source.commitSha,
    runId: source.runId,
    files: assets.map((asset) => ({
      name: asset.name,
      size: asset.size,
      url: asset.browser_download_url,
    })),
  };
}

async function forEachZipEntry(
  url: string,
  processEntry: (entry: unzip.Entry) => Promise<void>,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download artifact: ${response.status} ${response.statusText}`,
    );
  }
  if (response.body == null) {
    throw new Error("Response body is empty");
  }
  await pipeline(
    Readable.fromWeb(response.body),
    unzip.Parse(),
    new Writable({
      objectMode: true,
      write(entry: unzip.Entry, _encoding, callback) {
        void processEntry(entry).then(() => callback(), callback);
      },
    }),
  );
}

/** 指定runの配布用Artifactを全ページから取得する。 */
async function fetchReleaseArtifacts(
  repo: `${string}/${string}`,
  runId: number,
): Promise<WorkflowArtifact[]> {
  const artifacts = await octokit.paginate(
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
    { ...splitRepoName(repo), run_id: runId, per_page: 100 },
  );
  const releaseArtifacts = artifacts.filter((artifact) =>
    artifact.name.startsWith(releaseArtifactPrefix),
  );
  if (releaseArtifacts.length === 0) {
    throw new Error(`No release artifacts found in run ${runId}`);
  }
  return releaseArtifacts;
}

/** Artifactの取得先URLをZIP取得前に解決する。 */
async function fetchArtifactDownloadUrl(
  log: Logger,
  repo: `${string}/${string}`,
  artifact: WorkflowArtifact,
): Promise<string> {
  log.info`Fetching artifact URL: ${artifact.name}`;
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
    {
      ...splitRepoName(repo),
      artifact_id: artifact.id,
      archive_format: "zip",
      request: { redirect: "manual" },
    },
  );
  if (response.headers.location == undefined) {
    throw new Error(`Artifact "${artifact.name}" does not have a download URL`);
  }
  return response.headers.location;
}

await main();
