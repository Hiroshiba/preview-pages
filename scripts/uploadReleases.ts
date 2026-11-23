import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Semaphore } from "@core/asyncutil";
import { Octokit, RequestError } from "octokit";
import {
  createReleaseAssetName,
  createReleaseInfoFileName,
  destinationDir,
  distributionReleaseName,
  distributionRepo,
  getEnv,
  octokit,
  splitRepoName,
  rootLogger,
} from "./common.ts";
import {
  Release,
  ReleaseData,
  ReleaseFile,
  PreviewData,
  TargetRepoKey,
} from "./constants.ts";

const log = rootLogger.getChild("release");

const releaseOctokit = new Octokit({
  auth: getEnv("GITHUB_TOKEN"),
});

async function main() {
  const { releases: releaseResults } = JSON.parse(
    await fs.readFile(`${destinationDir}/previews.json`, "utf-8"),
  ) as PreviewData;

  const release = await createReleaseIfNotExists();
  for (const { repoKey, data } of Object.values(releaseResults)) {
    for (const releaseData of data) {
      await uploadRelease(repoKey, release, releaseData);
    }
  }
}

async function createReleaseIfNotExists(): Promise<Release> {
  log.info`Checking if release ${distributionReleaseName} exists...`;

  try {
    const release = await releaseOctokit.rest.repos.getReleaseByTag({
      ...splitRepoName(distributionRepo),
      tag: distributionReleaseName,
    });
    log.info`Release ${distributionReleaseName} already exists.`;
    return release.data;
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) {
      log.info`Creating release ${distributionReleaseName}...`;
      const release = await releaseOctokit.rest.repos.createRelease({
        ...splitRepoName(distributionRepo),
        tag_name: distributionReleaseName,
        name: "Preview Pages Release",
        body: "preview-pagesの配布ファイルを保存するリリース。手動で編集しないでください。",
        prerelease: true,
      });
      log.info`Release ${distributionReleaseName} created.`;
      return release.data;
    } else {
      throw error;
    }
  }
}

const uploadSemaphore = new Semaphore(3);
async function uploadRelease(
  repoKey: TargetRepoKey,
  release: Release,
  releaseData: ReleaseData,
): Promise<void> {
  const releaseInfoFileName = createReleaseInfoFileName(
    repoKey,
    releaseData.source,
    releaseData.runId,
  );

  if (release.assets.some((asset) => asset.name === releaseInfoFileName)) {
    log.info`Asset ${releaseInfoFileName} already exists, skipping upload.`;
    return;
  }

  try {
    const results = await Promise.allSettled(
      releaseData.files.map((file) =>
        uploadSemaphore.lock(() =>
          uploadReleaseFile(repoKey, release, releaseData, file),
        ),
      ),
    );
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Failed to upload ${errors.length} file(s)`,
      );
    }

    log.info`Uploading ${releaseInfoFileName}...`;
    await releaseOctokit.rest.repos.uploadReleaseAsset({
      ...splitRepoName(distributionRepo),
      release_id: release.id,
      name: releaseInfoFileName,
      data: JSON.stringify(releaseData, null, 2),
    });
  } catch (e) {
    log.error`Failed to upload ${releaseInfoFileName}: ${e}`;
  }
}

async function uploadReleaseFile(
  repoKey: TargetRepoKey,
  release: Release,
  releaseData: ReleaseData,
  file: ReleaseFile,
): Promise<void> {
  const assetName = createReleaseAssetName(
    repoKey,
    releaseData.source,
    releaseData.runId,
    file.name,
  );

  if (release.assets.some((asset) => asset.name === assetName)) {
    log.info`Asset ${assetName} already exists, skipping upload.`;
    return;
  }

  await using tempDir = await fs.mkdtempDisposable(
    path.join(os.tmpdir(), "preview-pages-release-"),
  );
  const filePath = path.join(tempDir.path, file.name);
  await downloadArtifact(repoKey, file.artifactId, filePath);

  log.info`Uploading ${assetName} from ${filePath}...`;
  const { data: asset } = await releaseOctokit.rest.repos.uploadReleaseAsset({
    ...splitRepoName(distributionRepo),
    release_id: release.id,
    name: assetName,
    headers: {
      "content-type": "application/octet-stream",
    },
    // @ts-expect-error octokitの型定義が間違っている。 https://github.com/octokit/octokit.js/discussions/2087
    data: await fsSync.openAsBlob(filePath),
  });
  if (asset.browser_download_url !== file.url) {
    throw new Error(
      `Uploaded asset URL ${asset.browser_download_url} does not match ${file.url}`,
    );
  }
}

async function downloadArtifact(
  repoKey: TargetRepoKey,
  artifactId: number,
  filePath: string,
): Promise<void> {
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
    {
      ...splitRepoName(repoKey),
      artifact_id: artifactId,
      archive_format: "zip",
      request: {
        redirect: "manual",
      },
    },
  );
  const downloadUrl = response.headers.location;
  if (downloadUrl == undefined) {
    throw new Error(`Artifact #${artifactId} does not have a download URL`);
  }

  log.info`Downloading artifact #${artifactId} to ${filePath}`;
  const fileResponse = await fetch(downloadUrl);
  if (!fileResponse.ok) {
    throw new Error(
      `Failed to download artifact: ${fileResponse.status} ${fileResponse.statusText}`,
    );
  }
  if (fileResponse.body == undefined) {
    throw new Error("Response body is empty");
  }
  await pipeline(
    Readable.fromWeb(fileResponse.body),
    fsSync.createWriteStream(filePath),
  );
}

await main();
