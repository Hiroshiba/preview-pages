import { ref } from "vue";
import type { ReleaseData } from "../../scripts/constants.ts";

const releaseResultRef = ref<
  { loading: false; result: ReleaseData[] } | { loading: true }
>({ loading: true });

void fetch(
  `${import.meta.env.BASE_URL}/preview/releases.json`.replace(/\/\//g, "/"),
).then(async (response) => {
  if (!response.ok) {
    throw new Error(`Failed to fetch releases.json: ${response.statusText}`);
  }
  const releaseData = (await response.json()) as ReleaseData[];
  releaseResultRef.value = { loading: false, result: releaseData };
});

export function useReleaseData() {
  return releaseResultRef;
}
