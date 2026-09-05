# Router v3.3 探索比較

再レビューで確定したラベルを用い、正式支持条件未達のまま探索的に比較する専用CLI。
旧v3.3の47%ゲート・モデル・回答を変更せず、通常Routerには接続しない。

## 実行

1. `node scripts/memory-extraction-router-v33-explore.mjs prepare --manifest REREVIEW_MANIFEST --out NEW_PRIVATE_DIRECTORY`
2. `node scripts/memory-extraction-router-v33-explore.mjs run --manifest NEW_PRIVATE_DIRECTORY/manifest.json`

prepareは新規ディレクトリしか受け付けない。runもresultディレクトリを排他的に作成し、完了・失敗済みのrunを再実行しない。
ソース入力・新ラベル・group/fold・実験設定・関連実装hashを開始前に固定する。
ディレクトリ0700、ファイル0600。旧runへの書き込みは禁止。

## 評価設計

- rules特徴量だけを使用。未取得の埋め込みを自動生成しない。外部API・Ollama・レビューは呼ばない。
- 同じ120件とgroup単位の外側5／内側4-foldを保持。
- acceptedかつ非excludedだけを学習。未確定も外側OOF予測を保存する。
- class weight・scaler・L2は学習側から算出。内側sampled developmentのlog lossでL2を選ぶ。
- 内側OOFでRecall80/90/95/100%に必要な最も高い耐久閾値を選び、運用閾値は階層全体の運用F1で選ぶ。
- 旧47%閾値選択を参照設定として同じ学習結果へ適用する。
- 外側OOFを使った設定の選び直し・最終モデル作成はしない。全設定を報告する。
- sample80とchallenge40を分離。semantic指標・全件候補率・未確定を含む保守的下限を併記。
- v2との差はgroup paired bootstrap 2,000回。既存packerを変更せず同じ入力で根拠比較。
- このbootstrapは固定OOF予測の区間で、学習ばらつき・複数比較の補正ではない。
- token・料金・Safety・LLM生成本文の評価は含まない。

状態`exploratory_complete`は処理完了のみ。旧支持ゲートの通過や本番品質を意味しない。
失敗時は原因をresult/error.jsonへ残し、自動fallbackしない。

## テスト

`node --test scripts/memory-extraction-router-v33-explore.test.mjs`

旧v3.3・再レビューテスト、対象lint、git diff --checkを併せて実行する。
