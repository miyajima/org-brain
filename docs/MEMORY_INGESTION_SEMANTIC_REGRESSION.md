# Memory ingestion semantic regression

## 目的

この回帰データセットは、証拠の時刻やケース番号の正規化だけでなく、次の意味経路を検証する。

1. セッションから決定事項と理由を抽出できる。
2. 決定事項と理由が同じ保存レコードに残り、理由検索で再発見できる。
3. 失敗から症状、根本原因、修正、検証結果、再発防止ルールを抽出できる。
4. 失敗の原因検索と再発防止検索が、同じ意味の失敗メモリへ到達する。

## データの作り方

定義ファイルは `packages/shared/test/fixtures/memory-ingestion-regression-v4.json`。実行時に翻訳・生成せず、レビュー済みの英語・日本語テンプレートから決定的にセッションを生成する。

- 全1,037件を交互に `en` / `ja` へ割り当て、英語519件、日本語518件にする。
- capture laneは success 75、decision 75、failure 75、review 12、non-durable 200。
- semantic laneは success、decision、failureの各75件。各レッスンは複数の意味シナリオを反復し、英日で同じシナリオキーと期待値を共有する。
- decisionは `decision_key`、`decision`、`rationale`、却下理由付きの`alternatives`、`reuse_when`を持つ。file evidenceとuser statement evidenceを含める。
- failureは`symptom`、`failed_approach`、`root_cause`、`correction`、`verified_outcome`、`avoidance_rule`を持つ。失敗コマンド（exit code 1）と修正後コマンド（exit code 0）を含める。
- セッションには`mcp_tool_call_end`、イベントハッシュ、ファイル証拠、コマンド証拠、最終回答を含める。パス、コマンド、ID、ハッシュ、スキーマキーは英日で共通化する。
- 実在の個人情報・資格情報・外部ネットワークは使用しない。non-durableケースだけに合成の拒否対象文字列を置き、永続投影へ入らないことを検証する。

## verify方法

### 1. 生成とoracle

`memory-ingestion-regression.test.mjs`で次を確認する。

- 同じ定義から同じセッション・oracle・ハッシュが生成される。
- 英日件数と各コホートの差が1以内になる。
- 英日でシナリオ、decision key、期待項目、証拠種類が一致する。
- runtimeイベントに`expected_route`や意味期待値を混入しない。

### 2. 意味抽出

`semanticTraceErrors`は、保存された学習オブジェクトに対して次を確認する。

- decision: decision key、決定、理由、再利用ルール、因果表現、file/user evidence。
- failure: 症状、原因、修正、防止策、exit code 1/0の証拠。
- success: 手順、なぜ有効だったか、観測結果、再利用条件。

文字列はUnicode・空白・合成ケース表記だけを意味正規化する。主張フレーズの存在判定は別に行い、結論と理由を同一視して通過させない。

### 3. SQLite保存と検索

`memory-ingestion-storage-regression.test.mjs`は、実際のCodexセッション取込、`LocalMemoryStore`、レビュー候補保存、V4検索投影を通す。

- active 225、quarantine 12、excluded 200を確認する。
- decision/failureの学習フィールド、evidence、verification stateをSQLiteで照合する。
- 理由・原因・再発防止の検索結果は、ケースIDの偶然の順位ではなく、同じ言語・同じレッスン・同じdecision keyまたは意味フィールドを持つメモリかで照合する。同一external keyの再取込は別途厳密に照合する。
- 同一データの2回目の取込で、新規memory、version、quarantine候補が0件になることを確認する。
- V4投影には理由、再利用ルール、症状、原因、修正、検証結果、防止策を含める。

### 実行コマンド

```sh
pnpm exec node --test ./scripts/memory-ingestion-regression.test.mjs
pnpm exec node --test ./scripts/memory-ingestion-storage-regression.test.mjs
pnpm exec node --test ./scripts/memory-ingestion-evaluate.test.mjs
```

このテストはローカルSQLiteのみを対象にする。Cloudflare D1やAPIの品質評価、生成モデルによる主観的な意味判定は別のテストスイートで扱う。

### 管理画面用ローカルD1への反映

管理画面でデータを確認する場合は、ローカルAPIを起動した状態で次を実行する。

```sh
pnpm memories:seed-ingestion-local
```

このseedは v4 の active 225件と quarantine 12件を、通常のcapture APIとlearning batch経路で保存する。`orgbrain-ingestion-v4:`の固定external keyを先に照合するため、同じseedの再実行では新しいmemory/versionを作らず、既存のv3データも削除しない。
