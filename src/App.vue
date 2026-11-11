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
  <main class="main">
    <template v-if="detailRelease != undefined">
      <div class="release-detail">
        <nav class="release-nav">
          <a :href="repoPageUrl"
            >{{ selectableRepos[currentRepo].label }}の一覧</a
          >
          ／ {{ detailRelease.branch }}のリリース
        </nav>
        <h2>{{ selectableRepos[currentRepo].label }}の開発版リリース</h2>
        <a :href="`https://github.com/${selectableRepos[currentRepo].repo}`">
          {{ selectableRepos[currentRepo].repo }}
        </a>
        <div class="release-source">
          <ElTag type="primary" disableTransitions>Branch</ElTag>
          <a
            :href="`https://github.com/${selectableRepos[currentRepo].repo}/tree/${detailRelease.branch}`"
          >
            {{ detailRelease.branch }}
          </a>
          <span>コミット</span>
          <a
            :href="`https://github.com/${selectableRepos[currentRepo].repo}/commit/${detailRelease.commitSha}`"
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
    </template>
    <template v-else>
      <p>プレビューするBranchまたはPull Requestを選択してください。</p>
      <section class="selector">
        <ElButtonGroup>
          <ElButton
            v-for="(repo, repoKey) in selectableRepos"
            :key="repoKey"
            :type="currentRepo === repoKey ? 'primary' : 'default'"
            @click="switchRepo(repoKey)"
          >
            {{ repo.label }}（<a
              :href="`https://github.com/${repo.repo}`"
              target="_blank"
              rel="noopener noreferrer"
              class="download-source-link"
              >{{ repo.repo }}</a
            >）
          </ElButton>
        </ElButtonGroup>
      </section>
      <section class="downloads">
        <template v-if="downloads.loading || releases.loading">
          <ElLoading />
        </template>
        <template v-else>
          <ElCard v-for="card in cards" :key="card.key" class="download-card">
            <template #header>
              <template v-if="card.type === 'branch'">
                <ElTag type="primary" disableTransitions>Branch</ElTag>
                <a
                  class="download-source"
                  :href="`https://github.com/${selectableRepos[currentRepo].repo}/tree/${card.branch}`"
                  @click.stop
                >
                  {{ card.branch }}
                </a>
                ：
                <a
                  :href="`https://github.com/${selectableRepos[currentRepo].repo}/commit/${card.commitSha}`"
                  @click.stop
                >
                  {{ card.commitSha.slice(0, 7) }}
                </a>
              </template>
              <template v-else>
                <ElTag type="success" disableTransitions>Pull Request</ElTag>
                <a
                  class="download-source"
                  :href="card.pullRequest.html_url"
                  @click.stop
                >
                  #{{ card.pullRequest.number }} （{{
                    card.pullRequest.title
                  }}）
                </a>
                ：
                <a
                  :href="`https://github.com/${card.pullRequest.head.repo.full_name}/commit/${card.pullRequest.head.sha}`"
                  @click.stop
                >
                  {{ card.pullRequest.head.sha.slice(0, 7) }}（{{
                    card.pullRequest.head.repo.full_name
                  }}）
                </a>
              </template>
            </template>
            <ElButton
              v-for="link in card.links"
              :key="link.label"
              :type="link.buttonType"
              :href="link.href"
              tag="a"
              target="_blank"
              >{{ link.label }}</ElButton
            >
            <ElButton
              v-if="card.type === 'branch' && card.release != undefined"
              type="primary"
              :href="releasePageUrl(card.branch)"
              tag="a"
              >リリース</ElButton
            >
          </ElCard>
        </template>
      </section>
    </template>
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
import { computed, ref, watch } from "vue";
import type { PullRequest } from "../scripts/constants.ts";
import {
  isTargetRepoKey,
  releaseTargets,
  targetRepos,
} from "../scripts/constants.ts";
import type { AvailableRelease } from "../scripts/releaseSchema.ts";
import { useDownloadData } from "./composables/useDownloadData.ts";
import { useReleaseData } from "./composables/useReleaseData.ts";
import { useColorScheme } from "./composables/useColorScheme.ts";

const selectableRepos = { ...targetRepos, ...releaseTargets };
type RepoKey = keyof typeof selectableRepos;
type WebLink = {
  href: string;
  buttonType: "success" | "danger";
  label: string;
};
type Card =
  | {
      type: "branch";
      key: string;
      branch: string;
      commitSha: string;
      links: readonly WebLink[];
      release?: AvailableRelease;
    }
  | {
      type: "pullRequest";
      key: string;
      pullRequest: PullRequest;
      links: readonly WebLink[];
    };

const downloads = useDownloadData();
const releases = useReleaseData();
useColorScheme();

function isRepoKey(value: string | null): value is RepoKey {
  return value != null && value in selectableRepos;
}

const search = new URLSearchParams(location.search);
const repoParam = search.get("repo");
const currentRepo = ref<RepoKey>(isRepoKey(repoParam) ? repoParam : "editor");
const releaseBranch = search.get("release");
const repoPageUrl = computed(
  () => `${location.pathname}?repo=${encodeURIComponent(currentRepo.value)}`,
);
const releasePageUrl = (branch: string) =>
  `${repoPageUrl.value}&release=${encodeURIComponent(branch)}`;
const joinUrl = (path: string) =>
  `${import.meta.env.BASE_URL}/preview/${path}`.replace(/\/+/g, "/");

const detailRelease = computed(() => {
  if (releaseBranch == null || releases.value.loading) {
    return undefined;
  }
  const release = releases.value.result[currentRepo.value];
  if (release?.status === "available" && release.branch === releaseBranch) {
    return release;
  }
  return undefined;
});

const cards = computed(() => {
  if (downloads.value.loading || releases.value.loading) {
    return [];
  }
  const repoKey = currentRepo.value;
  const release = releases.value.result[repoKey];
  const result: Card[] = [];
  if (isTargetRepoKey(repoKey)) {
    for (const download of downloads.value.result[repoKey].data) {
      const links = targetRepos[repoKey].links.map((link) => ({
        href: joinUrl(`${download.pathFragment}/${link.path}`),
        buttonType: link.buttonType,
        label: link.label,
      }));
      if (download.source.type === "branch") {
        const branch = download.source.branch;
        result.push({
          type: "branch",
          key: download.pathFragment,
          branch: branch.name,
          commitSha: branch.commit.sha,
          links,
          release:
            release?.status === "available" &&
            release.branch === branch.name &&
            release.commitSha === branch.commit.sha
              ? release
              : undefined,
        });
      } else {
        result.push({
          type: "pullRequest",
          key: download.pathFragment,
          pullRequest: download.source.pullRequest,
          links,
        });
      }
    }
  } else if (release?.status === "available") {
    result.push({
      type: "branch",
      key: `${repoKey}-${release.branch}`,
      branch: release.branch,
      commitSha: release.commitSha,
      links: [],
      release,
    });
  }
  return result;
});

const switchRepo = (repoKey: RepoKey) => {
  currentRepo.value = repoKey;
};
watch(currentRepo, (newVal) => {
  const next = new URLSearchParams(location.search);
  next.set("repo", newVal);
  history.replaceState(null, "", `${location.pathname}?${next.toString()}`);
});

const formatFileSize = (size: number): string => {
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
