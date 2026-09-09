# Sol / medium 再抽出の引き継ぎ

2026-09-09。ローカル実装と監査修正の準備が完了。ユーザーがモデルを Sol / medium に切り替えてから再抽出する。今回の準備では外部モデル呼び出し、再抽出、デプロイ、allowlist の有効化を行っていない。

## 引き継ぐ実装

- `coverage/v1` の文単位証拠、依存グループ、条件付き2パス、候補統合。
- recall miss と訂正・拒否・反復失敗の優先順位シグナル。無関係な次メッセージには失敗の加点をしない。
- API保存入力の session/turn hash を実行側へ引き渡す修正。
- 依存グループ内の条件・例外をすべて保持する検証、ツール結果と成功イベントの call ID 照合。
- 実行側と評価側で共用する verifier。採用候補の元配列インデックスを保持し、却下候補の混入を防ぐ。
- 実ソース・入力・設定・goldラベルのfreeze照合、候補ごとの人手判定と安全性判定の充足確認。

コードと運用契約は [coverage/v1仕様](MEMORY_EXTRACTION_COVERAGE_V1.md) を参照。機能は既定OFFのまま。

## 再抽出前の手順

1. この作業ツリーを使う。別タスクへ移す場合は未コミット変更と新規ファイルをすべて引き継ぐ。既存の `MEMORY_UTILITY_V12.md` と v1.2スクリプトの変更を消さない。
2. ユーザー指定の再抽出対象・既存試行台帳・出力先を確認する。hold、送信済み、結果不明の同一試行を再送しない。新しい試行として実施する場合も以前の入力と結果を上書きしない。
3. 抽出モデルはユーザー指定の Sol / medium を実際の実行経路で確認する。親タスクの表示だけでprovider側のモデルを確認済みと扱わず、無断でAPIモデルや別モデルに置き換えない。
4. A/B/C評価では各passの実際に送信したpacket、provider/model/reasoning、候補、状態、usage、時間を保存する。最終packetは同一runの全証拠プールと同じ既存memory snapshotを使う。未送信のC pass 2のみ `skipped` とする。使用量不明はnullを保つ。
5. 品質判定用の人手goldを含む入力が決まった時点で下記のfreezeを生成し、その内容を入力JSONの `freeze` に保存する。生成元manifestを保持し、抽出後にコードや入力を変えてfreezeを再生成しない。

```sh
node scripts/memory-extraction-coverage-evaluate.mjs \
  --input /private/path/coverage-evaluation.json \
  --output /private/path/coverage-freeze.json --freeze-only
```

6. 出力候補のfingerprintごとに人手のcorrect、gold_ids、および wrong_human_attribution / fabricated_evidence / sensitive_leak のboolean判定を記録する。AIによる仮判定を人手確定に変換しない。
7. 評価のみを実行する。このスクリプト自体はモデルを呼び出さない。

```sh
node scripts/memory-extraction-coverage-evaluate.mjs \
  --input /private/path/coverage-evaluation.json \
  --output /private/path/coverage-report.json --split fixed
```

## 証拠の境界

ローカル回帰テスト・型チェックは実抽出の品質合格ではない。75件の調整集合と425件の未使用固定集合、セッション分離、人手ラベル、freeze、実測usageが揃うまでは `evaluation_incomplete` を維持する。今回、その固定集合の実評価は行っていない。実環境への有効化・migration・デプロイも未実施。
