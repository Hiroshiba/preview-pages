import { ref } from "vue";
import { releaseResultsSchema } from "../../scripts/releaseSchema.ts";
import type { ReleaseResults } from "../../scripts/releaseSchema.ts";

const releaseResultRef = ref<
  { loading: false; result: ReleaseResults } | { loading: true }
>({ loading: true });

void fetch(
  `${import.meta.env.BASE_URL}/preview/releases.json`.replace(/\/\//g, "/"),
).then(async (response) => {
  if (!response.ok) {
    throw new Error(`リリース一覧を取得できません: ${response.statusText}`);
  }
  const data = releaseResultsSchema.parse(await response.json());
  releaseResultRef.value = { loading: false, result: data };
});

export function useReleaseData() {
  return releaseResultRef;
}
