import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Logger } from "@logtape/logtape";
import { Asset } from "./common.ts";
import { ReleaseData } from "./constants.ts";
import {
  createDistributionReleaseIfNotExists,
  createReleaseFileName,
  createReleaseInfoFileName,
  processAllReleases,
  ReleaseSelection,
  transferReleaseFiles,
  uploadReleaseAsset,
} from "./release.ts";

async function main() {
  await processAllReleases(uploadRelease);
}

async function uploadRelease(
  log: Logger,
  releaseSelection: ReleaseSelection,
): Promise<ReleaseData> {
  const { source } = releaseSelection;
  const distributionRelease = await createDistributionReleaseIfNotExists();
  const infoFileName = createReleaseInfoFileName(source);
  const infoAsset = distributionRelease.assets.find(
    (asset) => asset.name === infoFileName && asset.state === "uploaded",
  );
  if (infoAsset != undefined) {
    log.info`Release files already uploaded: ${infoFileName}`;
    return fetchReleaseData(infoAsset);
  }

  await using tempDir = await fs.mkdtempDisposable(
    path.join(os.tmpdir(), "preview-release-"),
  );
  let fileCount = 0;
  const files = await transferReleaseFiles(
    log,
    releaseSelection,
    async (name, content) => {
      const filePath = path.join(tempDir.path, `${fileCount++}`);
      await pipeline(content, fsSync.createWriteStream(filePath));
      const asset = await uploadReleaseAsset(
        distributionRelease,
        createReleaseFileName(source, name),
        filePath,
      );
      await fs.rm(filePath);
      return { name, size: asset.size, url: asset.browser_download_url };
    },
  );
  const releaseData: ReleaseData = { ...source, files };
  const infoPath = path.join(tempDir.path, "info");
  await fs.writeFile(infoPath, JSON.stringify(releaseData, null, 2));
  await uploadReleaseAsset(distributionRelease, infoFileName, infoPath);
  return releaseData;
}

async function fetchReleaseData(asset: Asset): Promise<ReleaseData> {
  const response = await fetch(asset.browser_download_url);
  if (!response.ok) {
    throw new Error(
      `Failed to download release data: ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as ReleaseData;
}

await main();
