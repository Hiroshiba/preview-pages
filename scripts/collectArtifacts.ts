import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { Logger } from "@logtape/logtape";
import unzip from "unzip-stream";
import {
  fetchArtifactUrl,
  getJobAndRunId,
  waitForJobCompletion,
} from "./artifactSource.ts";
import {
  destinationDir,
  rootLogger,
  octokit,
  cacheDownloadDir,
  createSourceKey,
  getCachedArtifact,
  splitRepoName,
  isTargetBranch,
} from "./common.ts";
import { collectRelease, selectReleaseSource } from "./collectReleases.ts";
import {
  DownloadData,
  targetRepos,
  releaseTargets,
  DownloadResult,
  TargetRepoKey,
  ReleaseTargetKey,
  isReleaseTargetKey,
  isTargetRepoKey,
  Branch,
  PullRequest,
  Source as ArtifactSource,
} from "./constants.ts";
import { ReleaseData, ReleaseResults } from "./releaseSchema.ts";

type Args = {
  fetchUrlOnly: boolean;
};

type ReleaseCollection = {
  key: ReleaseTargetKey;
  data: ReleaseData;
  collected: boolean;
};

type Collection = {
  download?: DownloadData;
  release?: ReleaseCollection;
};

const unavailable: ReleaseData = { status: "unavailable" };

async function main() {
  const args = processArgs();
  const {
    totalSuccessfulDownloads,
    successfulDownloads,
    totalTargets,
    releases,
    successfulReleases,
    totalReleaseTargets,
  } = await collectAllArtifacts(args);

  if (totalSuccessfulDownloads + successfulReleases === 0) {
    rootLogger.error("No artifacts were collected.");
    process.exit(1);
  }
  await fs.writeFile(
    `${destinationDir}/downloads.json`,
    JSON.stringify(successfulDownloads, null, 2),
  );
  if (!args.fetchUrlOnly) {
    await fs.writeFile(
      `${destinationDir}/releases.json`,
      JSON.stringify(releases, null, 2),
    );
  }
  rootLogger.info`Done:`;
  for (const { repoKey, data, numTargets } of Object.values(
    successfulDownloads,
  )) {
    rootLogger.info`${repoKey}: ${data.length} successful downloads / ${numTargets} targets`;
  }
  rootLogger.info`Total: ${totalSuccessfulDownloads + successfulReleases} successful downloads / ${totalTargets + totalReleaseTargets} targets`;
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
  const releases: ReleaseResults = Object.fromEntries(
    Object.keys(releaseTargets).map((key) => [key, unavailable]),
  );
  const handledReleaseKeys = new Set<string>();
  let totalSuccessfulDownloads = 0;
  let totalTargets = 0;
  let successfulReleases = 0;

  for (const [rawRepoKey, repo] of Object.entries(targetRepos)) {
    if (!isTargetRepoKey(rawRepoKey)) {
      throw new Error(`不明なWeb対象です: ${rawRepoKey}`);
    }
    const repoKey = rawRepoKey;
    rootLogger.info`Collecting artifacts for ${repo.repo}...`;
    const { downloads, releaseCollections } = await collectArtifacts(
      args,
      repoKey,
    );
    successfulDownloads[repoKey] = downloads;
    totalSuccessfulDownloads += downloads.data.length;
    totalTargets += downloads.numTargets;
    for (const release of releaseCollections) {
      handledReleaseKeys.add(release.key);
      releases[release.key] = release.data;
      successfulReleases += Number(release.collected);
    }
  }

  for (const [key, target] of Object.entries(releaseTargets)) {
    if (handledReleaseKeys.has(key)) {
      continue;
    }
    if (!isReleaseTargetKey(key)) {
      throw new Error(`不明な配布対象です: ${key}`);
    }
    const releaseKey = key;
    const log = rootLogger.getChild(key);
    try {
      const response = await octokit.rest.repos.getBranch({
        ...splitRepoName(target.repo),
        branch: target.branch,
      });
      const selected = await selectReleaseSource(
        log,
        releaseKey,
        response.data.commit.sha,
      );
      const data = await collectRelease(
        log,
        releaseKey,
        selected,
        args.fetchUrlOnly,
      );
      releases[releaseKey] = data;
      successfulReleases++;
    } catch (error) {
      log.error`Failed to process: ${error}`;
    }
  }

  return {
    totalSuccessfulDownloads,
    successfulDownloads,
    totalTargets,
    releases,
    successfulReleases,
    totalReleaseTargets: Object.keys(releaseTargets).length,
  };
}

async function collectArtifacts(
  args: Args,
  repoKey: TargetRepoKey,
): Promise<{
  downloads: DownloadResult;
  releaseCollections: ReleaseCollection[];
}> {
  const { filteredBranches, pullRequests } = await fetchTargets(repoKey);
  const sources: ArtifactSource[] = [];
  for (const branch of filteredBranches) {
    sources.push({ type: "branch", branch });
  }
  for (const pullRequest of pullRequests) {
    sources.push({ type: "pullRequest", pullRequest });
  }
  const results = await Promise.all(
    sources.map((source) => collectArtifact(args, repoKey, source)),
  );
  const data = results.flatMap((result) =>
    result.download == undefined ? [] : [result.download],
  );
  const releaseCollections = results.flatMap((result) =>
    result.release == undefined ? [] : [result.release],
  );
  return {
    downloads: { repoKey, data, numTargets: results.length },
    releaseCollections,
  };
}

function findReleaseTarget(
  repoKey: TargetRepoKey,
  source: ArtifactSource,
): ReleaseTargetKey | undefined {
  if (source.type !== "branch") {
    return;
  }
  const repo: string = targetRepos[repoKey].repo;
  const entry = Object.entries(releaseTargets).find(
    ([, target]) =>
      target.repo === repo && target.branch === source.branch.name,
  );
  if (entry == undefined) {
    return;
  }
  if (!isReleaseTargetKey(entry[0])) {
    throw new Error(`不明な配布対象です: ${entry[0]}`);
  }
  return entry[0];
}

async function collectArtifact(
  args: Args,
  repoKey: TargetRepoKey,
  source: ArtifactSource,
): Promise<Collection> {
  const log = rootLogger
    .getChild(repoKey)
    .getChild(
      source.type === "branch"
        ? `Branch ${source.branch.name}`
        : `PR #${source.pullRequest.number}`,
    );
  const releaseKey = findReleaseTarget(repoKey, source);
  try {
    const selected =
      releaseKey == undefined || source.type !== "branch"
        ? undefined
        : await selectReleaseSource(log, releaseKey, source.branch.commit.sha);
    const artifact =
      selected == undefined
        ? await Artifact.fetch(log, source, repoKey)
        : await Artifact.fetchSelected(log, source, repoKey, selected.runId);
    if (args.fetchUrlOnly) {
      log.info("Download skipped");
    } else {
      await artifact.downloadAndExtract();
      log.info("Done.");
    }
    if (selected == undefined || releaseKey == undefined) {
      return { download: artifact.toDownloadData() };
    }
    const releaseData = await collectRelease(
      log,
      releaseKey,
      selected,
      args.fetchUrlOnly,
    );
    return {
      download: artifact.toDownloadData(),
      release: {
        key: releaseKey,
        data: releaseData,
        collected: true,
      },
    };
  } catch (error) {
    log.error`Failed to process: ${error}`;
    if (releaseKey != undefined) {
      return {
        release: { key: releaseKey, data: unavailable, collected: false },
      };
    }
    return {};
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
    const ref =
      source.type === "branch"
        ? source.branch.name
        : source.pullRequest.head.sha;
    const repo = targetRepos[repoKey].repo;
    const jobAndRunId = await getJobAndRunId(log, repo, ref);
    if (jobAndRunId == undefined) {
      throw new Error("No job found");
    }

    const { jobId, runId } = jobAndRunId;
    log.info`Job ID: ${jobId}, Run ID: ${runId}`;
    const success = await waitForJobCompletion(log, jobId, repo);

    if (!success) {
      throw new Error(`Job #${jobId} did not complete successfully`);
    }

    return Artifact.fetchSelected(log, source, repoKey, runId);
  }

  /** 選択済みrunからWeb Artifactを取得する。 */
  static async fetchSelected(
    log: Logger,
    source: ArtifactSource,
    repoKey: TargetRepoKey,
    runId: number,
  ): Promise<Artifact> {
    const repo = targetRepos[repoKey].repo;
    const cachedUrl = await getCachedArtifact(repoKey, source, runId);
    const downloadUrl = cachedUrl || (await fetchArtifactUrl(log, repo, runId));

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
    this.log.info("Downloading artifact");
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

await main();
