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
import {
  checkReleaseArtifacts,
  collectRelease,
  ReleaseSource,
  selectReleaseSource,
} from "./collectReleases.ts";
import {
  DownloadData,
  targetRepos,
  releaseTargets,
  DownloadResult,
  TargetRepoKey,
  ReleaseTargetKey,
  ReleaseData,
  isReleaseTargetKey,
  Branch,
  PullRequest,
  Source as ArtifactSource,
} from "./constants.ts";

type Args = {
  fetchUrlOnly: boolean;
};

type Collection = {
  download: DownloadData;
  release?: ReleaseData;
};

async function main() {
  const args = processArgs();
  const {
    totalSuccessfulDownloads,
    successfulDownloads,
    totalTargets,
    releases,
  } = await collectAllArtifacts(args);

  if (totalSuccessfulDownloads + releases.length === 0) {
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
  const releases: ReleaseData[] = [];

  let totalSuccessfulDownloads = 0;
  let totalTargets = 0;

  for (const [rawRepoKey, repo] of Object.entries(targetRepos)) {
    const repoKey = rawRepoKey as TargetRepoKey;
    rootLogger.info`Collecting artifacts for ${repo.repo}...`;
    const { downloads, releases: repoReleases } = await collectArtifacts(
      args,
      repoKey,
    );

    successfulDownloads[repoKey] = downloads;
    totalSuccessfulDownloads += downloads.data.length;
    totalTargets += downloads.numTargets;
    releases.push(...repoReleases);
  }
  releases.push(...(await collectStandaloneReleases(args)));
  return {
    totalSuccessfulDownloads,
    successfulDownloads,
    totalTargets,
    releases,
  };
}

/** Web対象と共用しない配布対象の配布物を収集する。 */
async function collectStandaloneReleases(args: Args): Promise<ReleaseData[]> {
  const releases: ReleaseData[] = [];
  for (const [rawReleaseKey, target] of Object.entries(releaseTargets)) {
    if (rawReleaseKey in targetRepos) {
      continue;
    }
    const releaseKey = rawReleaseKey as ReleaseTargetKey;
    rootLogger.info`Collecting releases for ${target.repo}...`;
    const log = rootLogger.getChild(releaseKey);
    try {
      const { data: branch } = await octokit.rest.repos.getBranch({
        ...splitRepoName(target.repo),
        branch: target.branch,
      });
      const releaseSource = await selectReleaseSource(
        log,
        releaseKey,
        branch.commit.sha,
      );
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

async function collectArtifacts(
  args: Args,
  repoKey: TargetRepoKey,
): Promise<{ downloads: DownloadResult; releases: ReleaseData[] }> {
  const { filteredBranches, pullRequests } = await fetchTargets(repoKey);

  const collections = await Promise.all(
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
  const successfulCollections = collections.filter(
    (collection) => collection != undefined,
  );
  return {
    downloads: {
      repoKey,
      data: successfulCollections.map((collection) => collection.download),
      numTargets: collections.length,
    },
    releases: successfulCollections
      .map((collection) => collection.release)
      .filter((release) => release != undefined),
  };
}

async function collectArtifact(
  args: Args,
  repoKey: TargetRepoKey,
  source: ArtifactSource,
): Promise<Collection | undefined> {
  const log = rootLogger
    .getChild(repoKey)
    .getChild(
      source.type === "branch"
        ? `Branch ${source.branch.name}`
        : `PR #${source.pullRequest.number}`,
    );

  try {
    const releaseSource = await selectSharedReleaseSource(log, repoKey, source);
    const artifact =
      releaseSource == undefined
        ? await Artifact.fetch(log, source, repoKey)
        : await Artifact.fetchSelected(
            log,
            source,
            repoKey,
            releaseSource.runId,
          );

    if (args.fetchUrlOnly) {
      log.info("Download skipped");
    } else {
      await artifact.downloadAndExtract();
      log.info("Done.");
    }

    const download = artifact.toDownloadData();
    if (releaseSource == undefined) {
      return { download };
    }
    if (args.fetchUrlOnly) {
      await checkReleaseArtifacts(log, releaseSource);
      return { download };
    }
    return { download, release: await collectRelease(log, releaseSource) };
  } catch (e) {
    log.error`Failed to process: ${e}`;
  }
}

/** Web対象のbranchが配布対象でもあれば、Webと配布で共用するrunを選ぶ。 */
async function selectSharedReleaseSource(
  log: Logger,
  repoKey: TargetRepoKey,
  source: ArtifactSource,
): Promise<ReleaseSource | undefined> {
  const key: string = repoKey;
  if (
    source.type === "branch" &&
    isReleaseTargetKey(key) &&
    releaseTargets[key].branch === source.branch.name
  ) {
    return selectReleaseSource(log, key, source.branch.commit.sha);
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
