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
    <p>プレビューするBranchまたはPull Requestを選択してください。</p>
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
      <template v-if="downloads.loading">
        <ElLoading />
      </template>
      <template v-else>
        <ElCard
          v-for="download in downloads.result[currentRepo].data"
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
            v-for="link in targetRepos[currentRepo].links"
            :key="link.label"
            :type="link.buttonType"
            :href="joinUrl(`${download.pathFragment}/${link.path}`)"
            tag="a"
            target="_blank"
            >{{ link.label }}</ElButton
          >
        </ElCard>
      </template>
    </section>
    <section class="engine-downloads">
      <h2>VOICEVOX ENGINE 開発版</h2>
      <template v-if="engineDownloads.loading">
        <ElLoading />
      </template>
      <p v-else-if="engineDownloads.result.status === 'unavailable'">
        現在、開発版は利用できません。
      </p>
      <template v-else>
        <p>
          <a :href="`https://github.com/${engineRepo}/tree/${engineBranch}`">
            {{ engineBranch }}
          </a>
          ・{{ engineDownloads.result.version }} ・<a
            :href="`https://github.com/${engineRepo}/commit/${engineDownloads.result.commitSha}`"
          >
            {{ engineDownloads.result.commitSha.slice(0, 7) }}
          </a>
          ・<a
            :href="`https://github.com/${engineRepo}/actions/runs/${engineDownloads.result.runId}`"
          >
            Actions run {{ engineDownloads.result.runId }}
          </a>
          ・<a :href="engineDownloads.result.releaseUrl">Release</a>
        </p>
        <div class="engine-targets">
          <ElCard
            v-for="download in engineDownloads.result.targets"
            :key="download.target"
          >
            <template #header>{{ download.target }}</template>
            <div
              v-for="format in engineFormats"
              :key="format.key"
              class="engine-format"
            >
              <h3>{{ format.label }}</h3>
              <ul>
                <li
                  v-for="file in [
                    download[format.key].list,
                    ...download[format.key].parts,
                  ]"
                  :key="file.name"
                >
                  <a :href="file.url">{{ file.name }}</a>
                </li>
              </ul>
            </div>
          </ElCard>
        </div>
      </template>
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
import { ref, onMounted, watch } from "vue";
import { TargetRepoKey } from "../scripts/common.ts";
import { engineBranch, engineRepo, targetRepos } from "../scripts/constants.ts";
import { useDownloadData } from "./composables/useDownloadData.ts";
import { useEngineDownloadData } from "./composables/useEngineDownloadData.ts";
import { useColorScheme } from "./composables/useColorScheme.ts";

const downloads = useDownloadData();
const engineDownloads = useEngineDownloadData();
useColorScheme();

const engineFormats = [
  { key: "sevenZip", label: "7z" },
  { key: "vvpp", label: "VVPP" },
] satisfies { key: "sevenZip" | "vvpp"; label: string }[];

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

const joinUrl = (path: string) =>
  `${import.meta.env.BASE_URL}/preview/${path}`.replace(/\/+/g, "/");
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

.engine-downloads {
  margin-top: 2rem;
}

.engine-targets {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}

.engine-format {
  overflow-wrap: anywhere;
}
</style>
