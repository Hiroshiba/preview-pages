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

### コメントの追加などの書き込み系の動作なしで動かす場合

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

#### Actionsで動かす

2. 作成したGitHub Appsの`Private key`を取得し、リポジトリの`Settings` > `Secrets` に`PRIVATE_KEY`として保存します。
3. `.env.example` の内容をリポジトリの`Settings` > `Secrets` にキーごとに保存します。

#### ローカルで動かす

2. 作成したGitHub Appsの`Private key`を取得し、`private-key.pem`として保存します。
3. `.env.example` をコピーして `.env` を作成します。内容はコメントを参照してください。
4. `GITHUB_TOKEN` にpreview-pagesのContents: Read and write権限を持つPersonal Access Tokenを設定します。
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

### 開発版の配布

開発版の配布対象は `scripts/constants.ts` の `releaseTargets` に登録します。
Webと配布を同じカードに表示する場合は、`targetRepos` と `releaseTargets` で同じkeyとリポジトリを使います。

配布対象のリポジトリは次のようにしてください。

- 配布ファイルを、名前が `preview-pages-download-` で始まるArtifactとしてuploadします。
  - Artifact内の階層は無視し、ファイル名だけで保存します。同じrunの全Artifactでファイル名が重複しないようにしてください。
- Webも提供する場合は、Web用の `preview-pages` Artifactを同じrunへuploadします。
- すべてのuploadが終わってから `build_preview_pages` checkを成功させます。
- その成功に依存するjobから `update_pages.yml` を起動します。

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

2. 追加するリポジトリに以下の2つのWorkflowを追加します。

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
