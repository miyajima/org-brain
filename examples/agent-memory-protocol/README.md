# AMP 0.1 の実データ例

個人Wikiの「記憶はどこから入り、いつ使えるようになる？」を、問いの入口と5つのメモリに再編した例。元ページは残し、実装と過去の実行報告を区別する。

- [インデックス](index.md)
- [受付・起動・有効化](orgbrain-intake-state.md)
- [Stopからの共通抽出](orgbrain-stop-intake.md)
- [分類自動保存](orgbrain-classified-save.md)
- [Wikiからの投入](orgbrain-wiki-intake.md)
- [Cursor実セッションの報告](orgbrain-cursor-stop-report.md)

これは設定済みの個人Wikiに保存した文書のコピー。原本IDと保存状態hashはそのWikiに固有で、別のWikiへコピーするだけでは参照検査に通らない。別の保存先では許可済みの原本を取り込み、下層を保存・読戻ししてからインデックスの参照を書き換える。記憶DBへの保存や採用判断の承認とは別の操作である。

実装の説明はチェックアウト `8f5dc131f933` の版付き原本に基づく。試験報告は2026-10-19の保存版を参照し、今回実クライアントを再実行したとは扱わない。各メモリの `limitations` を結論と一緒に読む。

個人Wiki内のパスは `amp/indexes/memory-intake.md` と `amp/memories/*.md`。現在の例は所有プロジェクト未設定なので、所有権フィルターの `project_id` は指定しない。`path_prefix:"amp/"`でこの形式のページに絞れる。

```sh
node packages/orgbrain-cli/src/local-memory.mjs wiki amp-validate amp/indexes/memory-intake.md
node packages/orgbrain-cli/src/local-memory.mjs wiki amp-search '起動したら記憶は使える？' \
  --path-prefix amp/ --facts-json '{"runtime":"local"}'
```

2026-11-11の検索契約0.2では、上の例は既定の短い候補一覧を返す。`next_read`に従って`amp-read`を呼ぶと、`memory`に結論・条件・例外・限界が入る。`include_evidence:true`で原本を照合し、`evidence`に抜粋を添える。本文を一括検索する場合は`--detail memory`、原本も一括で読む場合は`--detail evidence`を使う。

`matched`は渡されたfactsとの機械的な一致で、未記入の条件を推定した結果ではない。説明用の検索では成立する例外も理由付きで返す。通常資料も併用する場合は`--path-prefix amp/`で範囲を限定しない。[改訂した規約](../../docs/AGENT_MEMORY_PROTOCOL.md)と[固定データでの確認](../../docs/agent-memory-protocol/IMPROVEMENT_20261111.md)を参照。
