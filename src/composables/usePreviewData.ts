import { ref } from "vue";
import type { DownloadResult } from "../../scripts/common.ts";
import type { ReleaseData, TargetRepoKey } from "../../scripts/constants.ts";

const previewDataRef = ref<
  | {
      loading: false;
      downloads: Record<TargetRepoKey, DownloadResult>;
      releases: ReleaseData[];
    }
  | { loading: true }
>({ loading: true });

async function fetchPreviewJson(fileName: string): Promise<unknown> {
  const response = await fetch(
    `${import.meta.env.BASE_URL}/preview/${fileName}`.replace(/\/\//g, "/"),
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch ${fileName}: ${response.statusText}`);
  }
  return response.json();
}

void Promise.all([
  fetchPreviewJson("downloads.json"),
  fetchPreviewJson("releases.json"),
]).then(([downloads, releases]) => {
  previewDataRef.value = {
    loading: false,
    downloads: downloads as Record<TargetRepoKey, DownloadResult>,
    releases: releases as ReleaseData[],
  };
});

export function usePreviewData() {
  return previewDataRef;
}
