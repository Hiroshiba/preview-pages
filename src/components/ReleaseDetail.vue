<template>
  <div class="release-detail">
    <nav class="release-nav">
      <a :href="repoPageUrl()">{{ targetRepos[repoKey].label }}の一覧</a>
      ／ {{ branch }}のリリース
    </nav>
    <h2 class="release-title">
      {{ targetRepos[repoKey].label }}の開発版リリース
    </h2>
    <a :href="`https://github.com/${targetRepos[repoKey].repo}`">
      {{ targetRepos[repoKey].repo }}
    </a>
    <template v-if="releaseState.type === 'loading'">
      <ElLoading />
    </template>
    <p v-else-if="releaseState.type === 'notFound'">
      リリースが見つかりませんでした。
    </p>
    <template v-else>
      <div class="release-source">
        <ElTag type="primary" disableTransitions>Branch</ElTag>
        <a
          :href="`https://github.com/${targetRepos[repoKey].repo}/tree/${releaseState.release.branch}`"
        >
          {{ releaseState.release.branch }}
        </a>
        <span>コミット</span>
        <a
          :href="`https://github.com/${targetRepos[repoKey].repo}/commit/${releaseState.release.commitSha}`"
        >
          {{ releaseState.release.commitSha.slice(0, 7) }}
        </a>
      </div>
      <h3>配布ファイル</h3>
      <ul class="release-files">
        <li
          v-for="file in releaseState.release.files"
          :key="file.name"
          class="release-file"
        >
          <a :href="file.url">{{ file.name }}</a>
          <span>{{ formatFileSize(file.size) }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ElLoading, ElTag } from "element-plus";
import { computed } from "vue";
import { TargetRepoKey } from "../../scripts/common.ts";
import { ReleaseData, targetRepos } from "../../scripts/constants.ts";
import { usePreviewData } from "../composables/usePreviewData.ts";

const props = defineProps<{
  repoKey: TargetRepoKey;
  branch: string;
}>();
const previewData = usePreviewData();

const releaseState = computed<
  | { type: "loading" }
  | { type: "notFound" }
  | { type: "found"; release: ReleaseData }
>(() => {
  if (previewData.value.loading) {
    return { type: "loading" };
  }
  const release = previewData.value.releases.find(
    (release) =>
      release.repoKey === props.repoKey && release.branch === props.branch,
  );
  if (release == undefined) {
    return { type: "notFound" };
  }
  return { type: "found", release };
});

const repoPageUrl = () =>
  `${location.pathname}?${new URLSearchParams({ repo: props.repoKey }).toString()}`;

const formatFileSize = (size: number) => {
  if (size >= 1_073_741_824) {
    return `${(size / 1_073_741_824).toFixed(1)} GiB`;
  }
  if (size >= 1_048_576) {
    return `${(size / 1_048_576).toFixed(1)} MiB`;
  }
  if (size >= 1_024) {
    return `${(size / 1_024).toFixed(1)} KiB`;
  }
  return `${size} B`;
};
</script>

<style scoped lang="scss">
.release-detail {
  max-width: 900px;
}

.release-nav {
  margin: 1rem 0 1.5rem;
}

.release-title {
  margin-bottom: 0.25rem;
}

.release-source {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1.5rem 0;
  padding: 1rem 0;
  border-top: 1px solid var(--el-border-color);
  border-bottom: 1px solid var(--el-border-color);
}

.release-files {
  list-style: none;
  padding: 0;
}

.release-file {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--el-border-color);
  overflow-wrap: anywhere;
}
</style>
