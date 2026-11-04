# 3経路への共通抽出適用と稼働runtime検証

2026-10-27開始の作業。対象はローカルのリアルタイム、個人Wiki、過去セッション。クラウド配備・公開は対象外。

## 完了したこと

- `packages/shared/src/learning-episode-policy-runtime.mjs` に成功・復旧・再利用と失敗側の発見条件、必要な4項目、証拠区分をまとめ、リアルタイムのターン検出、共通セッション抽出、Wiki/セッションのsource-review抽出・審査へ適用した。検索語の一致は採用を意味しない。型付きのobserve入力は引き続き既存の契約検証と保存確認の対象で、検索による発見とは別である。
- リアルタイムに残っていたassistant報告の観測結果扱いと、assistant文からの本人判断・理由の推測を修正した。報告はunverifiedのreported_verificationに留める。
- 過去セッションのpipelineへcoverage group、復旧/回帰、テスト先行開発の文脈を引き継いだ。以前の3ターン・8 MiBの制限や引数一致の条件は維持する。
- `memory_learning_mode=off` のStopが共通キューと旧式保存へ進む欠陥を止めた。offをonへ変更していない。空のStopはworkspace初期化前でもno-opになる。
- 旧式のラベル付き条件で `Reuse:` 等のラベルが本文に残っていた欠陥も修正した。条件本文・継続行・例外を保持する既存23テストが全件成功した。修正前は同じ元コードで9件失敗していた。
- 前段の3観点・2モデル系列の品質審査、秘密情報除外、対話的な保存確認、quarantine、月枠とモデル指定を維持した。

## ソースとruntime

他の未コミット変更を含めず、専用worktreeで実装し、変更対象12ファイルだけを元のorg-brainへ反映した。`integration-receipt.json` に対象とSHA-256を記録した。

稼働先 `.org-brain/runtimes/attempt-pilot-current` を `three-route-extraction-20261027` に切り替えた。CLI、通常のStop、抽出workerが参照するパスである。旧runtime `memory-pipeline-20261022-9568c0a2` は残した。native Wiki engineは稼働中の元版と同じバイトを同梱し、Wiki utility専用の別runtime設定は変更していない。最終bundleのSHA-256は `runtime-install.json` にある。

新規に起動したMCPでは2026-07-28のserver/discover、tools/list、隔離DBに対する読み取りが成功した（`installed-mcp-smoke.json`）。接続済みの長寿命MCPプロセスは強制終了していないため、そのプロセス自身の再読み込みは未確認。新しいhook/workerプロセスは切替後のパスを参照する。

## 先行テストと回帰

- 新規8動作テストを修正前コードへ適用: **1成功・7失敗**（`full-before.tap`）。別途、追加時の失敗を `before.tap`、`group-before.tap`、`empty-before.tap` に保持した。
- 修正後のNode回帰: **217/217成功、skip 0**（`integrated-node.tap`）。3経路、通常worker、出典・理由・条件、off、既存の確認手順、実bundleと設定済みcontext wrapperを含む。
- Vitest回帰: **98/98成功**（`integrated-vitest.log`）。hook、保持条件、セッションreplay、共有抽出契約を含む。
- 元の作業ツリーへの反映後も同じ検証が成功。`git diff --check` と統合ソース・稼働bundleのハッシュ照合も成功。合計315テスト成功。
- 配布用buildの既存互換性検査も成功した。Zodの既知の循環依存warningは出たがbuildは成功した。

テスト実行の途中でVitest用ファイルをNode runnerに渡した失敗と、既存23件の9失敗を分けて診断した。前者は正しいrunnerで成功、後者は元コードでも再現した条件本文の問題として修正した。CLI canaryでも正式な引数、JSON形式、native engine配置を直してから成功を確認した。これらの試行・修正時間を削減効果へ数えていない。

## 稼働パスから3経路を通した確認

`verify-three-route-runtime.mjs` は、正確な稼働bundleを通常CLIとして起動し、隔離DB/キュー、モック推論で以下を確認する。既存Wikiは実際に読み取るが書き換えない。

| 経路 | 確認結果 |
|---|---|
| リアルタイム | 通常のClaude Stop → キュー → worker → quarantine 1件 |
| 過去セッション | Codex形式の完了ターン → CLI enqueue → worker → quarantine 1件 |
| Wiki | 既存個人Wikiのページ・原本照合 → 新しい抽出器へ渡す → モックのnull候補でabstained |

`installed-canary.json` に記録した。これは入口から保存/棄権までの接続と新条件の適用を検証するもので、実モデルの候補品質ではない。テストのモデル名やusageはfixtureであり実API計測ではない。隔離DBのactive記憶0、本番記憶への書き込み0。

## 実在するWikiと過去セッションの実抽出試行

モックとは別に、稼働runtimeの通常pipelineを使い、実予算と実審査の入口に各1件を渡した。

- Wiki: `wiki/procedures/orgbrain-wiki-memory-worker.md`、page_id `22b14a09-1eed-4367-be58-71347257514a`。固定原本は `source:2bb57177-a377-4359-b14d-8219231cca01@1`。ページ・原本・版の照合後、モデル呼び出し前に `pipeline_monthly_budget_exhausted` でheld。
- 過去セッション: org-brainの完了済みjob `013aa6dc14f45fa48b3e75e4c12471a2690bfbc48fe96922320eb96d8e8a5fc4` の実ツール結果を含む保存packet。packetハッシュ照合後、同じ予算検査でheld。これは合成会話ではなく、実際に保持されていたセッション入力である。
- 元資料のルールのみの抽出も確認したが、選択した2件から新たな審査用候補は作られなかった。モデル結果で補ったり、審査を迂回して登録したりしていない。
- 再参照時、既存heldのWikiはreplayedとして返り、モデルを再送しなかった。実装の最終差分で保存packetのsnapshotにgroupが加わったため、セッション側にはその版のheld記録も残る。同じ原本を別の独立成功として加算しない。

`existing-source-attempts.initial.json` と `existing-source-attempts.json` に結果を記録した。実モデルの抽出が完了した、または実候補の品質審査が成功したという意味ではない。

## 記憶の品質＝再利用と削減効果

| 評価項目 | 結果 |
|---|---|
| 新コードによる実モデル抽出・審査 | 予算で保留、未完了 |
| 新しい本番記憶の有効化 | 0件 |
| 新規記憶が実タスクで選ばれ、再利用されたか | 未検証 |
| 再利用時のトークン削減 | 不明（null） |
| 再利用時の時間短縮 | 不明（null） |
| 同条件で品質・再作業まで揃えた比較 | 未取得 |

既存の比較資料のpreflightはinsufficient_metadataで停止した。文の短縮、プロンプトの小ささ、fixtureでのlookup成功、テスト実行時間だけで費用・時間削減を主張しない。新しい実記憶が作られていないため、今回の変更でその再利用・削減効果を実証することはできない。未観測を0や成功として扱わない。

残る検証を再開する条件は、現行予算内で選択した入力の抽出と既存審査を完了できること、その記憶が対象タスクで実際に選ばれること、品質・開始状態・環境・比較対象・総usage/時間が揃うこと。予算の増額や台帳reset、off解除、比較のための一括有効化を前提にしない。原本の版と新runtimeのハッシュを照合してから行う。

## 変更していない設定と費用の限界

台帳は前後とも **498,512 / 500,000**、残り **1,488**。次の通常予約2,800を満たさない。実provider呼び出し0、有効化0、active記憶113件のまま。allowlist、jrgのoff、org-brain/sociaのみの審査設定、月枠、台帳、モデル/推論設定を変更していない。全件backfill・一括有効化なし。

runtimeの実行先だけを更新した。作業全体の親モデル、試行、修正、検証を含む総費用は未測定。抽出providerを追加で呼んでいないことを、総費用0や節約の証拠にしない。

## 再利用する手順

抽出入口・出典帰属・条件保持・予算停止を変更するときは、新規8テストと関連回帰を実行する。`verify-three-route-runtime.mjs --cli <bundle> --output <結果>` は、モック推論で同じ3入口を確認する。`verify-orgbrain-runtime-mcp.mjs <結果>` は新規MCPプロセスを確認する。`attempt-existing-extraction.mjs` は既存の低い残予算を確認して選択した2原本だけを渡すための、今回の明示的検証scriptであり、予算が変わった際の有料再抽出を自動開始しない。

共通化が効いた理由は、別々の入口で使っていた発見条件と証拠区分を揃え、候補の発見と審査・有効化を分離したため。実モデルでの有用性・削減効果は別に検証する。
