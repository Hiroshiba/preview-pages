import { ref } from "vue";
import type { PreviewData } from "../../scripts/constants.ts";

const previewDataRef = ref<
  { loading: false; result: PreviewData } | { loading: true }
>({ loading: true });

void fetch(
  `${import.meta.env.BASE_URL}/preview/previews.json`.replace(/\/\//g, "/"),
).then(async (response) => {
  if (!response.ok) {
    throw new Error(`Failed to fetch previews.json: ${response.statusText}`);
  }
  const previewData = (await response.json()) as PreviewData;
  previewDataRef.value = { loading: false, result: previewData };
});

export function usePreviewData() {
  return previewDataRef;
}
