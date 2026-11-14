# プロジェクトごとの手順をAMPに保存する

AMP 0.4では、プロジェクトごとに索引を1枚保存する。索引は「何を読むか」、0.4のMarkdown手順メモリは「いつ・どう作業し、何を確認するか」を持つ。普段の情報検索だけでは見つかりにくい共通ルールも、プロジェクトIDから案内できる。

## OrgBrainの具体例

2026-11-14時点の作業ブランチ`feat/amp-0.3-portable-memory-20261112`の資料・実装から確認した手順。以下のサーバー起動やCloudflareへのデプロイを、この文書の作成時に実行したという意味ではない。

### 作業前の共通ルール

現在のAGENTS.mdと、その参照先を読む。対象ブランチと変更内容を確認し、既存の未コミット作業を保持する。振る舞いを変える場合は、失敗する再現テストを先に確認し、修正後に同じ試験を通す。検証結果と未確認事項を分けて報告する。現在の依頼に含まれる操作は進め、保存済みの手順だけで外部変更を許可されたと判断しない。

根拠：[AGENTS.md](../../AGENTS.md)。上位の指示を写して固定せず、実行時に現行の内容を読む。

### ローカルのAPIと画面を起動する

作業ディレクトリはリポジトリのルート。依存パッケージとローカル用の設定・データを準備済みであることを確認する。既に同じポートで起動しているプロセスがあれば、対象と起動元を調べてから扱う。

1. 1つ目のターミナルで`pnpm local:api`を実行する。
2. 2つ目のターミナルで`pnpm local:console`を実行する。
3. APIの`http://127.0.0.1:8787`と、画面の`http://127.0.0.1:4321/`を確認する。表示できただけで業務操作や検索品質まで成功したとはしない。

根拠：[ローカル起動手順](../LOCAL_PRODUCTION_SNAPSHOT.md#start-the-local-api-and-console)と`package.json`の`local:api`・`local:console`。ローカルデータは`.local/production-dump/`を使う。データ更新・本番データの取得は、起動とは別の操作として扱う。

### Cloudflareへの反映を準備・確認する

対象アカウント・環境・サービス・コミットを確認する。認証情報の値を索引や手順に保存しない。

1. `node packages/orgbrain-cli/src/local-memory.mjs cf doctor --root .`でローカル設定を確認する。
2. 変更範囲のテストと型検査を行い、対象アプリの`build`を実行する。`cap-runner`・`org-router`・`api-gateway`の`build`は`wrangler deploy --dry-run`であり、本番反映ではない。Consoleの`build`は`astro build`である。
3. 初期構築の場合は`cf provision`の計画を先に確認し、その計画に含まれる資源作成・移行・公開の対象を確定する。通常のコード更新を初期構築と混同しない。
4. 既存環境への公開は、対象アプリの`pnpm -C apps/<対象> exec wrangler deploy`を使う。構成を一括反映する場合の順序は`cloud-operations.mjs`の計画に従う。既存のOAuthルート指定を失わないよう、現行設定と計画を確認する。
5. 公開後は、指定した実際のMCP URLを使う`cf doctor --root . --live --mcp-url <対象URL>`と、変更箇所のAPI動作を確認する。デプロイ完了の表示、API応答、利用者の操作成功を分けて記録する。

根拠：[READMEのCloudflare設定](../../README.md)、各アプリの`package.json`、[反映計画の実装](../../packages/orgbrain-cli/src/cloud-operations.mjs)。READMEの「deploy in dependency order」にある`build`一覧は、現行のWorkerスクリプトではdry runになる点に注意する。記載の本番手順は資料・実装から確認したもので、この作業では本番へ反映していない。

### AMPを変更したときの確認

```sh
node --test scripts/agent-memory-protocol.test.mjs scripts/wiki-integration.test.mjs
```

入口から本文を読めることに加え、別プロジェクトの情報を返さないこと、古いhashや期限切れを拒むこと、Wiki無効時にも通常の記憶取得が動くことを確認する。CLIを配布するときは`node scripts/build-standalone.mjs <出力先>/dist/orgbrain.mjs`で作った実物にも試験を行う。ソースの成功だけで常駐MCPの更新済みとはしない。

根拠：`scripts/agent-memory-protocol.test.mjs`、`scripts/wiki-integration.test.mjs`、`scripts/build-standalone.mjs`。

## 別のプロジェクトに使う

開発向けの実例は[OrgBrain索引](../../examples/agent-memory-protocol/project-index-org-brain.md)、執筆向けのひな形は[執筆索引](../../examples/agent-memory-protocol/project-index-writing.md)。執筆では、文体・表記・読者・引用方法を本文に置き、確認に使うスキル名とSKILL.mdの場所、どの段階で使うかを明記する。例えば`japanizer`を選んだ場合も、そのプロジェクトで採用した文体とスキルの現行手順を読む。ひな形は利用者の既存の好みを表したものではない。

下層を保存してから、対応するランタイムで索引を保存する。

```sh
node packages/orgbrain-cli/src/local-memory.mjs wiki amp-save \
  --project-id org-brain \
  --markdown-file examples/agent-memory-protocol/project-index-org-brain.md

node packages/orgbrain-cli/src/local-memory.mjs wiki amp-search '今回の作業' --project-id org-brain
```

Wikiの保存先・機能設定は設定済みの個人Wikiを使う。別の保存先へ移行しない。更新時は先に読み、`--expected-hash`を付ける。`amp/projects/org-brain/index.md`を`amp-validate`し、リンク先と出典を確認する。

対応するローカル`orgbrain_context_enrich`は、個人Wikiが有効なら検索語に依存せず索引への参照を返す。索引を読んで必要な本文へ進むところまでは実装できるが、エージェントが実際に手順を守ったかは各作業で確認する。Cloud版、旧ランタイム、索引を読まないクライアントには自動適用されない。
