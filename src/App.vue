<template>
  <header class="header">
    <a
      href="https://github.com/VOICEVOX/preview-pages"
      target="_blank"
      rel="noopener noreferrer"
      class="header-link"
    >
      VOICEVOX Preview Pages
    </a>
  </header>
  <main v-if="detailRelease != undefined" class="main">
    <div class="release-detail">
      <nav class="release-nav">
        <a :href="repoPageUrl">{{ targetRepos[currentRepo].label }}の一覧</a>
        ／ {{ detailRelease.branch }}のリリース
      </nav>
      <h2>{{ targetRepos[currentRepo].label }}の開発版リリース</h2>
      <a :href="`https://github.com/${targetRepos[currentRepo].repo}`">
        {{ targetRepos[currentRepo].repo }}
      </a>
      <div class="release-source">
        <ElTag type="primary" disableTransitions>Branch</ElTag>
        <a
          :href="`https://github.com/${targetRepos[currentRepo].repo}/tree/${detailRelease.branch}`"
        >
          {{ detailRelease.branch }}
        </a>
        <span>コミット</span>
        <a
          :href="`https://github.com/${targetRepos[currentRepo].repo}/commit/${detailRelease.commitSha}`"
        >
          {{ detailRelease.commitSha.slice(0, 7) }}
        </a>
      </div>
      <h3>配布ファイル</h3>
      <ul class="release-files">
        <li v-for="file in detailRelease.files" :key="file.name">
          <a :href="file.url">{{ file.name }}</a>
          <span>{{ formatFileSize(file.size) }}</span>
        </li>
      </ul>
    </div>
  </main>
  <main v-else class="main">
    <p>BranchまたはPull Requestを選択してください。</p>
    <section class="selector">
      <ElButtonGroup>
        <ElButton
          v-for="(targetRepo, repoKey) in targetRepos"
          :key="repoKey"
          :type="currentRepo === repoKey ? 'primary' : 'default'"
          @click="switchRepo(repoKey)"
        >
          {{ targetRepo.label }}（<a
            :href="`https://github.com/${targetRepo.repo}`"
            target="_blank"
            rel="noopener noreferrer"
            class="download-source-link"
            >{{ targetRepo.repo }}</a
          >
          ）
        </ElButton>
      </ElButtonGroup>
    </section>
    <section class="downloads">
      <template v-if="previewData.loading">
        <ElLoading />
      </template>
      <template v-else-if="'links' in currentTargetRepo">
        <ElCard
          v-for="download in previewData.downloads[currentRepo].data"
          :key="download.pathFragment"
          class="download-card"
        >
          <template #header>
            <template v-if="download.source.type === 'branch'">
              <ElTag type="primary" disableTransitions>Branch</ElTag>
              <a
                class="download-source"
                :href="`https://github.com/${targetRepos[currentRepo].repo}/tree/${download.source.branch.name}`"
                @click.stop
              >
                {{ download.source.branch.name }}
              </a>
              ：
              <a
                :href="`https://github.com/${targetRepos[currentRepo].repo}/commit/${download.source.branch.commit.sha}`"
                @click.stop
              >
                {{ download.source.branch.commit.sha.slice(0, 7) }}
              </a>
            </template>
            <template v-if="download.source.type === 'pullRequest'">
              <ElTag type="success" disableTransitions>Pull Request</ElTag>
              <a
                class="download-source"
                :href="download.source.pullRequest.html_url"
                @click.stop
              >
                #{{ download.source.pullRequest.number }} （{{
                  download.source.pullRequest.title
                }}）
              </a>
              ：
              <a
                :href="`https://github.com/${download.source.pullRequest.head.repo.full_name}/commit/${download.source.pullRequest.head.sha}`"
                @click.stop
              >
                {{ download.source.pullRequest.head.sha.slice(0, 7) }}（{{
                  download.source.pullRequest.head.repo.full_name
                }}）
              </a>
            </template>
          </template>

          <ElButton
            v-for="link in currentTargetRepo.links"
            :key="link.label"
            :type="link.buttonType"
            :href="joinUrl(`${download.pathFragment}/${link.path}`)"
            tag="a"
            target="_blank"
            >{{ link.label }}</ElButton
          >
          <ElButton
            v-if="
              download.source.type === 'branch' &&
              download.source.branch.name === currentRelease?.branch
            "
            type="primary"
            :href="releasePageUrl(download.source.branch.name)"
            tag="a"
            >リリース</ElButton
          >
        </ElCard>
      </template>
      <ElCard v-else-if="currentRelease != undefined" class="download-card">
        <template #header>
          <ElTag type="primary" disableTransitions>Branch</ElTag>
          <a
            class="download-source"
            :href="`https://github.com/${targetRepos[currentRepo].repo}/tree/${currentRelease.branch}`"
            @click.stop
          >
            {{ currentRelease.branch }}
          </a>
          ：
          <a
            :href="`https://github.com/${targetRepos[currentRepo].repo}/commit/${currentRelease.commitSha}`"
            @click.stop
          >
            {{ currentRelease.commitSha.slice(0, 7) }}
          </a>
        </template>

        <ElButton
          type="primary"
          :href="releasePageUrl(currentRelease.branch)"
          tag="a"
          >リリース</ElButton
        >
      </ElCard>
    </section>
  </main>
</template>

<script setup lang="ts">
import {
  ElButton,
  ElButtonGroup,
  ElCard,
  ElLoading,
  ElTag,
} from "element-plus";
import { computed, ref, onMounted, watch } from "vue";
import { TargetRepoKey } from "../scripts/common.ts";
import { targetRepos } from "../scripts/constants.ts";
import { usePreviewData } from "./composables/usePreviewData.ts";
import { useColorScheme } from "./composables/useColorScheme.ts";

const previewData = usePreviewData();
useColorScheme();

const currentRepo = ref<TargetRepoKey>("editor");
const switchRepo = (repo: TargetRepoKey) => {
  currentRepo.value = repo;
};
onMounted(() => {
  const search = new URLSearchParams(location.search);
  const repo = search.get("repo") as TargetRepoKey | null;
  if (repo && repo in targetRepos) {
    currentRepo.value = repo;
  }
});
watch(currentRepo, (newVal) => {
  const search = new URLSearchParams(location.search);
  search.set("repo", newVal);
  history.replaceState(null, "", `${location.pathname}?${search.toString()}`);
});

const currentTargetRepo = computed(() => targetRepos[currentRepo.value]);
const detailBranch = new URLSearchParams(location.search).get("release");
const currentRelease = computed(() => {
  if (previewData.value.loading) {
    return undefined;
  }
  return previewData.value.releases.find(
    (release) => release.repoKey === currentRepo.value,
  );
});
const detailRelease = computed(() =>
  currentRelease.value?.branch === detailBranch
    ? currentRelease.value
    : undefined,
);

const repoPageUrl = computed(
  () => `${location.pathname}?repo=${currentRepo.value}`,
);
const releasePageUrl = (branch: string) =>
  `${repoPageUrl.value}&release=${encodeURIComponent(branch)}`;
const joinUrl = (path: string) =>
  `${import.meta.env.BASE_URL}/preview/${path}`.replace(/\/+/g, "/");

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
@use "@/styles/index.scss" as main;

.header {
  align-content: center;
  padding: 1rem;

  html.light & {
    color: #000000;
    background: main.$theme-light;
  }
  html.dark & {
    color: main.$theme-dark;
    background: #2b2b2b;
  }

  font-size: 1.5rem;
  font-weight: bold;
}

.header-link {
  color: currentColor;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.main {
  padding: 1rem;
  margin-left: auto;
  margin-right: auto;
}

.download-source {
  padding-left: 0.5rem;
}

.download-source-link {
  color: currentColor;
}

.selector {
  margin-bottom: 1rem;
  display: flex;
}

.downloads {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fill, minmax(600px, 1fr));
}

.download-card :deep(.el-card__body) {
  display: flex;
  gap: 1rem;
}

.release-detail {
  max-width: 900px;
}

.release-nav {
  margin: 1rem 0 1.5rem;
}

.release-detail h2 {
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

.release-files li {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--el-border-color);
  overflow-wrap: anywhere;
}
</style>
