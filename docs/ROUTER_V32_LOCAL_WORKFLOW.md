# Router v3.2 ローカル実験ワークフロー

この実験は既定 Router v2、既存の500件、既存の回答を変更しない。評価本文と回答はローカルの実験ディレクトリだけに置き、外部LLMやDBへ送信しない。

## 1. 初回40件を用意する

既存500件を開発データとして参照し、v3.1の誤分類キューから耐久16・運用16・不要8を選ぶ。枠不足はCLIの`shortages`に表示し、別ラベルで補充しない。

```sh
node scripts/memory-extraction-router-v32.mjs prepare \
  --manifest /private/tmp/router-v32/manifest.json \
  --input /path/to/deduplicated-500.json \
  --error-queue /path/to/review-queue.json \
  --experiment-id router-v32-2026-09-05 \
  --output /private/tmp/router-v32/review-batch-1.json
```

`review-batch-1.json`を`/admin/memory-extraction-evaluation`へURL直アクセスで読み込む。v3.2は初期payloadから予測とAI下書きを除去したblind reviewである。`durable_memory`を選ぶと、根拠範囲と「将来どの場面で使うか」が必須になる。迷う場合は「保留にする」を使う。

回答を書き出したら、同じ実験IDの非公開ディレクトリへ保存する。

```sh
node scripts/memory-extraction-router-v32.mjs import-review \
  --manifest /private/tmp/router-v32/manifest.json \
  --bundle /private/tmp/router-v32/review-batch-1.json \
  --progress /path/to/router-v32-annotations.json \
  --output /private/tmp/router-v32/labels-1.json \
  --manifest-output /private/tmp/router-v32/manifest-after-import.json
```

UIから書き出す回答は`memory-extraction-router-v32-annotations/v1`です。次の40件へ進む場合は、確定済みlabel snapshotを`--reviewed-labels`へ渡し、同じmanifestを上書きせず`--manifest-output`へ次のmanifestを出力します（最大3ラウンド）。

```sh
node scripts/memory-extraction-router-v32.mjs review-batch \
  --manifest /private/tmp/router-v32/manifest-after-import.json \
  --input /path/to/deduplicated-500.json \
  --error-queue /path/to/review-queue.json \
  --reviewed-labels /private/tmp/router-v32/labels-1.json \
  --round 2 --batch-id batch-2 \
  --output /private/tmp/router-v32/review-batch-2.json \
  --manifest-output /private/tmp/router-v32/manifest-round-2.json
```

final holdoutを40件ずつ確認した場合は、全bundleと全progressをパスリストにして結合してから、1つのsnapshotを作る。結合は重複caseを拒否する。

```sh
node scripts/memory-extraction-router-v32.mjs merge-review \
  --manifest /private/tmp/router-v32/holdout-manifest.json \
  --bundles /private/tmp/router-v32/holdout-bundles.json \
  --output /private/tmp/router-v32/holdout-bundle-all.json
node scripts/memory-extraction-router-v32.mjs merge-progress \
  --manifest /private/tmp/router-v32/holdout-manifest.json \
  --bundles /private/tmp/router-v32/holdout-bundles.json \
  --progresses /private/tmp/router-v32/holdout-progresses.json \
  --output /private/tmp/router-v32/holdout-progress-all.json
node scripts/memory-extraction-router-v32.mjs import-review \
  --manifest /private/tmp/router-v32/holdout-manifest.json \
  --bundle /private/tmp/router-v32/holdout-bundle-all.json \
  --progress /private/tmp/router-v32/holdout-progress-all.json \
  --output /private/tmp/router-v32/holdout-labels.json \
  --manifest-output /private/tmp/router-v32/holdout-manifest-reviewed.json
```

各40件を個別に`import-review`した後で学習・評価する場合は、全bundleを`merge-review`した出力と、各importで得たlabel snapshotを次のように再結合する。結合snapshotはmerged bundleへ再bindingされるため、個別snapshotをそのまま`train`/`evaluate`へ渡さない。

```sh
node scripts/memory-extraction-router-v32.mjs merge-labels \
  --manifest /private/tmp/router-v32/holdout-manifest-reviewed.json \
  --bundle /private/tmp/router-v32/holdout-bundle-all.json \
  --bundles /private/tmp/router-v32/holdout-bundles.json \
  --labels /private/tmp/router-v32/holdout-label-snapshots.json \
  --output /private/tmp/router-v32/holdout-labels-merged.json
```

## 2. 埋め込みと比較学習

Ollamaを起動し、`qwen3-embedding:0.6b`が存在することを確認してから実行する。CLIは自動pullせず、loopback以外の接続先、digest不在、次元不一致をエラーにする。

```sh
node scripts/memory-extraction-router-v32.mjs embed \
  --manifest /private/tmp/router-v32/manifest-after-import.json \
  --bundle /private/tmp/router-v32/review-batch-1.json \
  --output /private/tmp/router-v32/embeddings-1.json
```

同じ入力・同じ確定labelでv2根拠ベースラインを作る。ベースラインは固定v2 routerから再計算できるpacket hashと原文根拠を含むため、4つの数値だけを書いたJSONは受理しない。

```sh
node scripts/memory-extraction-router-v32.mjs baseline \
  --manifest /private/tmp/router-v32/manifest-after-import.json \
  --bundle /private/tmp/router-v32/review-batch-1.json \
  --labels /private/tmp/router-v32/labels-1.json \
  --output /private/tmp/router-v32/dev-v2-baseline.json
```

```sh
node scripts/memory-extraction-router-v32.mjs train \
  --manifest /private/tmp/router-v32/manifest.json \
  --bundle /private/tmp/router-v32/review-batch-1.json \
  --labels /private/tmp/router-v32/labels-1.json \
  --embeddings /private/tmp/router-v32/embeddings-1.json \
  --safety-report /private/tmp/router-v32/safety.json \
  --v2-baseline /private/tmp/router-v32/dev-v2-baseline.json \
  --output /private/tmp/router-v32/model-1.json
```

学習は`rules`、`embedding`、`combined`をgroup単位の外側5-fold・内側4-foldで比較する。final holdoutをbundleまたはlabelsへ混ぜると停止する。40件確定後もゲート未達なら、最大3ラウンドまで新規40件を追加する。

## 3. Safetyとfreeze

```sh
node scripts/memory-extraction-router-v32.mjs safety \
  --manifest /private/tmp/router-v32/manifest.json \
  --output /private/tmp/router-v32/safety.json

node scripts/memory-extraction-router-v32.mjs freeze \
  --manifest /private/tmp/router-v32/manifest.json \
  --model /private/tmp/router-v32/model-1.json \
  --holdout-hash <final-holdout-manifest.input_sha256> \
  --safety-report /private/tmp/router-v32/safety.json \
  --v2-baseline /private/tmp/router-v32/dev-v2-baseline.json \
  --output /private/tmp/router-v32/model-1-frozen.json
```

学習前に「3. Safetyとfreeze」の`safety`コマンドを実行して`safety.json`を作る。`--v2-baseline`には、同じbundle・同じ確定ラベルから`baseline`サブコマンドで生成した`memory-extraction-router-v32-v2-baseline/v1`成果物だけを指定する。`input_sha256`、ラベルhash、v2モデルhash、各caseのsource/packet hash、4つの根拠指標はCLIが再計算して検証するため、手入力の数値や別データのレポートは受理しない。

freeze後のモデルと、ラベル・入力hashを変更してはならない。Safetyはsynthetic fixture上の結果としてのみ解釈する。

## 4. 最終holdout

新規groupをラベルを見る前に固定して作ったfinal holdoutだけを、同じURL直アクセス画面で40件ずつ確認する。全件を`accepted`（保留は不可）に確定し、モデルをfreezeしてから一度だけ評価する。receiptは実験IDのハッシュから決まるローカルtemp registryのcanonical pathに排他的に作られ、別ディレクトリ・別の出力名で再実行しても拒否する。claimだけが残った場合は自動復旧せず、内容を確認して原因を記録する。

```sh
node scripts/memory-extraction-router-v32.mjs evaluate \
  --manifest /private/tmp/router-v32/holdout-manifest.json \
  --bundle /private/tmp/router-v32/holdout-bundle-all.json \
  --labels /private/tmp/router-v32/holdout-labels.json \
  --model /private/tmp/router-v32/model-1-frozen.json \
  --safety-report /private/tmp/router-v32/safety.json \
  --v2-baseline /path/to/v2-baseline.json \
  --output /private/tmp/router-v32/holdout-report.json
```

## 終了状態

- `awaiting_human_review`: 実装済み、40件の確定回答待ち
- `embedding_unavailable`: ローカルモデル準備待ち
- `development_gate_failed`: 開発比較済み、品質未達
- `insufficient_holdout_support`: holdoutの耐久50・運用50・30 group未達
- `holdout_gate_failed`: 独立評価済み、品質未達
- `local_gates_passed`: ローカル品質目標を達成

`local_gates_passed`でも本番品質やproduction readinessは意味しない。production activation、DB変更、バックフィル、Sol/high送信は別承認が必要である。
