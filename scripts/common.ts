import fs from "node:fs/promises";
import * as logtape from "@logtape/logtape";
import { config } from "dotenv";
import { App, Octokit, RequestError } from "octokit";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { throttling } from "@octokit/plugin-throttling";
import { Endpoints, OctokitResponse } from "@octokit/types";
import { targetRepos, DownloadData, Source } from "./constants.ts";

export type DownloadResult = {
  repoKey: TargetRepoKey;
  data: DownloadData[];
  numTargets: number;
};

config({
  path: `${import.meta.dirname}/../.env`,
});

// 設定
export type TargetRepoKey = keyof typeof targetRepos;
// デプロイ情報を書き込むコメントの最初に付けるマーカー
export const commentMarker = "<!-- voicevox preview-pages info -->";
// 過去に使われていたマーカーも含めたマーカーの一覧
export const commentMarkers = [
  commentMarker,
  "<!-- voiccevox preview-pages info -->",
];

// ダウンロードしたzipを保存するディレクトリ
export const cacheDownloadDir = `${import.meta.dirname}/cached`;
// ダウンロードしたzipを展開するディレクトリ
export const destinationDir = `${import.meta.dirname}/../public/preview`;
// ビルドチェックのJobの名前
export const pagesBuildCheckName = "build_preview_pages";
// Webプレビューのアーティファクトの名前
export const webArtifactName = "preview-pages";
// 配布ファイルのアーティファクトの名前の接頭辞
export const releaseArtifactPrefix = "preview-pages-release-";
// PagesのURL
export const pagesUrl = "https://voicevox.github.io/preview-pages";

// キャッシュを保存するリポジトリ
export const cacheRepo = "voicevox/preview-pages";
// キャッシュのリリース名
export const cacheReleaseName = "preview-pages-cache";
// 配布ファイルのリリース名
export const distributionReleaseName = "preview-pages-release";

await logtape.configure({
  sinks: {
    console: logtape.getConsoleSink({
      formatter: logtape.getAnsiColorFormatter({
        level: "full",
        categoryColor: "cyan",
        category: (categories: readonly string[]) =>
          `[${categories.join("][")}]`,
      }),
    }),
  },
  loggers: [
    {
      category: "app",
      lowestLevel: "info",
      sinks: ["console"],
    },

    {
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      sinks: ["console"],
    },
  ],
});

export const rootLogger = logtape.getLogger("app");

const getEnv = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
};

let appInfo:
  | OctokitResponse<Endpoints["GET /app"]["response"]["data"]>
  | undefined;
export let octokit: Octokit;

if (process.env.APP_ID) {
  rootLogger.info`Running as GitHub App. (Read + Write)`;
  const app = new App({
    appId: Number.parseInt(getEnv("APP_ID")),
    privateKey:
      process.env.PRIVATE_KEY ||
      (await fs.readFile(`${import.meta.dirname}/../private-key.pem`, "utf8")),
    oauth: {
      clientId: getEnv("CLIENT_ID"),
      clientSecret: getEnv("CLIENT_SECRET"),
    },
    Octokit: Octokit.plugin(paginateRest, throttling),
  });

  appInfo = await app.octokit.request("GET /app");
  if (!appInfo.data) {
    throw new Error("Failed to get app info.");
  }
  rootLogger.info`Running as ${appInfo.data.name}.`;

  const { data: installations } = await app.octokit.request(
    "GET /app/installations",
  );
  const installationId = installations[0].id;

  octokit = await app.getInstallationOctokit(installationId);
} else if (process.env.GITHUB_TOKEN) {
  rootLogger.info`Running with GitHub Token, cannot comment on PRs.`;

  octokit = new Octokit({
    auth: getEnv("GITHUB_TOKEN"),
  });
} else {
  throw new Error("No GitHub App or Token provided.");
}

export const getAppInfo = () => {
  if (!appInfo) {
    throw new Error("This script requires appInfo to be set.");
  }
  return appInfo;
};

export class ExhaustiveError extends Error {
  constructor(value: never) {
    super(`Not exhaustive. value: ${String(value)}`);
  }
}

export function createSourceKey(source: Source): string {
  switch (source.type) {
    case "pullRequest":
      return `pr-${source.pullRequest.number}`;
    case "branch":
      return `branch-${source.branch.name}`;
    default:
      throw new ExhaustiveError(source);
  }
}

export function createCacheFileName(
  repoKey: TargetRepoKey,
  source: Source,
  runId: number,
): string {
  return `${repoKey}-${createSourceKey(source)}-${runId}-v1.zip`;
}

export type Asset =
  Endpoints["GET /repos/{owner}/{repo}/releases/assets/{asset_id}"]["response"]["data"];

/* リポジトリをOctokitのパラメーターに渡せる形で分解する。 */
export function splitRepoName(key: TargetRepoKey | `${string}/${string}`): {
  owner: string;
  repo: string;
} {
  if (key in targetRepos) {
    const targetRepo = targetRepos[key as TargetRepoKey];
    if (!targetRepo) {
      throw new Error(`Unknown repo key: ${key}`);
    }
    const [owner, repo] = targetRepo.repo.split("/");
    return { owner, repo };
  } else if (key.includes("/")) {
    const [owner, repo] = key.split("/");
    return { owner, repo };
  } else {
    throw new Error(`Invalid repo key: ${key}`);
  }
}

let cachedAssets: Asset[] | undefined = undefined;

const cacheLogger = rootLogger.getChild("cache");

async function getCachedAssets(): Promise<Asset[]> {
  if (cachedAssets == undefined) {
    try {
      const { data } = await octokit.rest.repos.getReleaseByTag({
        ...splitRepoName(cacheRepo),
        tag: cacheReleaseName,
      });
      cachedAssets = data.assets;
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) {
        cacheLogger.info`Release ${cacheReleaseName} not found in ${cacheRepo}.`;
        cachedAssets = [];
        return cachedAssets;
      }
      throw error;
    }
  }
  return cachedAssets;
}

export async function getCachedArtifact(
  repoKey: TargetRepoKey,
  source: Source,
  runId: number,
): Promise<string | null> {
  const assets = await getCachedAssets();
  const cacheFileName = createCacheFileName(repoKey, source, runId);

  for (const asset of assets) {
    if (asset.name === cacheFileName) {
      cacheLogger.info`Found cached artifact for ${cacheFileName}`;
      return asset.browser_download_url;
    }
  }

  return null;
}

export function isTargetBranch(branchName: string): boolean {
  return (
    branchName === "main" ||
    branchName === "master" ||
    branchName.startsWith("project-")
  );
}

export class UnreachableError extends Error {
  constructor(message = "Unreachable code executed") {
    super(message);
    this.name = "UnreachableError";
  }
}
