# VOICEVOX Preview Pages

VOICEVOXのWebプレビューと開発版リリース一覧を提供するリポジトリです。  
対象ブランチ：

- `main`
- `master`
- `project-*`
- プルリクエスト

## 動かす

### Webサーバーだけ動かす場合

以下のコマンドを実行します：

```
pnpm i
curl https://voicevox.github.io/preview-pages/preview/downloads.json -o ./public/preview/downloads.json
curl https://voicevox.github.io/preview-pages/preview/releases.json -o ./public/preview/releases.json
pnpm run dev
```

### GitHubへ書き込まず取得可否を確認する場合

1. GitHub の Personal Access Token を取得します。
2. `.env.example` をコピーして `.env` を作成します。内容はコメントを参照してください。
3. 以下のコマンドを実行します：

```
pnpm run run:collect-artifacts --fetchUrlOnly
```

### 書き込み系の動作を含めて動かす場合

1. GitHub Appsを作成します。

権限は以下の通りです：

- Pull requests：Read & write
- Actions：Read
- Checks：Read

開発版を配布する場合、preview-pagesのUpdate Pages workflowにはReleaseの作成・削除に使う `contents: write` と `GITHUB_TOKEN` が必要です。

#### Actionsで動かす

2. 作成したGitHub Appsの`Private key`を取得し、リポジトリの`Settings` > `Secrets` に`PRIVATE_KEY`として保存します。
3. `.env.example` の内容をリポジトリの`Settings` > `Secrets` にキーごとに保存します。

#### ローカルで動かす

2. 作成したGitHub Appsの`Private key`を取得し、`private-key.pem`として保存します。
3. `.env.example` をコピーして `.env` を作成します。内容はコメントを参照してください。
4. `GITHUB_TOKEN` にpreview-pagesのContents: Read and write権限を持つPersonal Access Tokenを設定します。Releaseの書き込みにはGitHub Appsの認証情報とは別に必要です。
5. 以下のコマンドを実行します：

```
pnpm run run:collect-artifacts
pnpm run run:update-comments
```

## 仕組み

```mermaid
sequenceDiagram
    actor user as ユーザー
    participant editor_fork as ユーザー/voicevox（フォーク）
    participant editor_main as voicevox/voicevox（main）
    participant preview_pages as voicevox/preview_pages

    user->>editor_fork: PRを出す

    note over editor_fork: ビルドを開始する
    activate editor_fork

    user-->>editor_main: pull_request_targetが発火する
    editor_main->>+preview_pages: update_pages.ymlを発火させる

    loop
        preview_pages->>editor_fork: Jobの終了を問い合わせる
    end

    note over editor_fork: ビルドが完了する
    deactivate editor_fork
    preview_pages->>editor_fork: Artifactをダウンロードする

    note over preview_pages: Pagesにデプロイする
    deactivate preview_pages
```

開発版の配布対象は `scripts/constants.ts` の `releaseTargets` に登録します。登録するリポジトリと追跡ブランチの成功した `build_preview_pages` checkから一つのrunを選び、そのrunの `preview-pages-download-` で始まるActions Artifactに入った通常ファイルを、階層の有無にかかわらず葉の元ファイル名でrun別Releaseへ保存します。ディレクトリは配布ファイルに含めません。同じReleaseに入る全Artifactで葉のファイル名が重複しないようにしてください。配布用Artifactが一件もない場合は配布物を表示しません。Webも提供する対象は、同じrunにWeb用の `preview-pages` Artifactを置きます。配布ファイルは `releases.json`、Webは `downloads.json` に記録し、画面では同じブランチとコミットのカードに表示します。古い配布ReleaseはPages公開後に整理します。
Webと配布を同じカードに表示する場合は、`targetRepos` と `releaseTargets` で同じkeyとリポジトリを使います。

送信側は、同じリポジトリとブランチの一回の更新で必要なWebと配布ファイルをすべて同じworkflow runへuploadしてください。すべてのuploadが終わってから `build_preview_pages` checkを成功させ、その成功に依存する通知jobから入力なしの `update_pages.yml` を一回起動してください。通知は収集の合図であり、run IDやコミットは渡しません。Webと配布物を別のrunに分けたまま `releaseTargets` へ登録できません。

## リポジトリの追加

1. `scripts/constants.ts` を編集します。

設定例：

```ts
  blog: {
    repo: "VOICEVOX/voicevox_blog",
    label: "ホームページ",
    links: [
      {
        path: "index.html",
        buttonType: "success",
        emoji: ":house:",
        label: "ホームページ",
      },
    ],
  },
```

2. Webプレビューだけを提供するリポジトリには以下の2つのWorkflowを追加します。開発版も配布する場合は、上記の契約に従い、ビルド完了後の通知jobから起動してください。

<details>
<summary>DANGEROUS_trigger_preview_pages.yml</summary>

```yaml
name: "Trigger preview-pages' workflow"

# プレビュー用ページのワークフローを起動する。
# 詳細： https://github.com/voicevox/preview-pages?tab=readme-ov-file#%E4%BB%95%E7%B5%84%E3%81%BF

on:
  pull_request_target:
    types:
      - opened
      - synchronize
      - closed
      - reopened
  push:
    branches:
      - main
      - project-*

jobs:
  trigger:
    runs-on: ubuntu-latest
    if: github.repository_owner == 'VOICEVOX'
    steps:
      - name: Trigger Workflow
        run: |
          gh workflow run -R voicevox/preview-pages update_pages.yml
        env:
          GH_TOKEN: ${{ secrets.TRIGGER_PREVIEW_PAGES_TOKEN }}
```

</details>
<details>
<summary>build_preview_pages.yml</summary>

```yaml
name: "Build Preview Pages"

# プレビュー用ページをビルドする。
# 詳細： https://github.com/voicevox/preview-pages?tab=readme-ov-file#%E4%BB%95%E7%B5%84%E3%81%BF

on:
  push:
    branches:
      - main
      - project-*
  pull_request:

jobs:
  # このJobの名前を変更したときは、voicevox/preview-pages側のscripts/collect.tsも変更すること。
  build_preview_pages:
    runs-on: ubuntu-latest
    steps:
      # ... 環境構築 ...

      - name: Determine base URL
        id: determine_base_url
        uses: VOICEVOX/preview-pages/base@main
        with:
          name: blog

      # このStepは適宜変更すること。
      - name: Build
        run: |
          pnpm run build --base ${{ steps.determine_base_url.outputs.base_url }}

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: preview-pages
          # pathも適宜変更すること。
          path: "./dist"
```

</details>
## ライセンス

[LICENSE](LICENSE) を参照してください。
