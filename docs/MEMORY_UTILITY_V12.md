# Memory Utility v1.2 実験 runbook

v1.2は開発データだけを使う私的な比較実験です。通常のRouter、共通契約、本番DB、provider API、アプリケーションサーバーは変更しません。`A`には実験記憶を供給せず、host共通背景記憶は各native sessionで同じhashになるよう固定します。`B`は固定10件では検証済みv1.1出力を再利用し、holdout 5件では凍結v2の抽出・保存判定を使います。`C`はv1.2契約で抽出します。Cのitem IDと先行item参照は`i1`、`i2`の形式に固定し、保存する集約`support_ids`は検証済みfield evidenceからコードで導出します。Cのfield-level `evidence`とqualityの`checked_set`は、native transportでは原文を含めず、source spanを入力順で数えた`span-1`、`span-2`のようなbounded ordinal tokenを持つ`{id}`だけを送ります。qualityのitem参照も抽出itemを入力順で数えた`item-1`、`item-2`のtokenに固定します。受理時にjobのprivate source spanとextracted itemからコードがtokenを実IDへ解決し、検証済みの全文`quote`をcanonical outputへ補完します。Cのspan参照は最大512件、qualityのitem参照は最大96件に制限し、各schemaのenum総数を1000以下でpreflightします。C・quality・replay・evaluationのJSON文字列内で原文の不等号を保持する場合は、`\u003c` / `\u003e`のescapeを使い、受理後のJSON値で原文に戻します。

再現対象は、親agentが選定した未使用の新規runだけです。attempt1〜7の既存runを`V12_MANIFEST`に設定してはなりません。

```sh
SOURCE_MANIFEST=/private/tmp/orgbrain-router-v33-cloud-20260905/manifest.json
CANONICAL_V11=/private/tmp/orgbrain-memory-utility-v11-20260906-attempt3/manifest.json
# 親agentが未使用でまだ存在しない新規runパスを決めた後、その絶対パスを設定する。
export NEW_V12_RUN="${NEW_V12_RUN:?set a new empty v1.2 run path before continuing}"
V12_MANIFEST="$NEW_V12_RUN/manifest.json"
```

`SOURCE_MANIFEST`は元のv3.3 source manifest、`CANONICAL_V11`は固定10件を束縛する唯一のv1.1 baselineです。`NEW_V12_RUN`はattempt1〜7を含む既存runと重ならない、実行時点でまだ存在しない新規絶対パスです。`prepare`がそこへ空のprivate runを作成し、生成した`$NEW_V12_RUN/manifest.json`をそのrunの`V12_MANIFEST`として以後のstageに渡します。既存runへ`prepare`を再実行して上書きしてはいけません。

`attempt1`〜`attempt7`（`/private/tmp/orgbrain-memory-utility-v12-20260907-attempt1`〜`attempt7`）は、修正前の保留証跡です。7 runとも状態は`held`であり、比較対象から除外します。attempt1は初回のnative受理経路で保留され、attempt2は校正5件の受理後、最初のdownstream quality native結果でCLI/events/outputの本文不一致により保留されました。attempt5は校正の最初のsemantic-quality jobで`quality_fields_incomplete`になり、`item_checks.checked_fields`へ9つのsemantic field以外のtop-level item keyを含めたため保留されました。これはprompt/contractの明確化が必要な校正上の保留であり、意味品質の失敗判定ではありません。attempt5の保全済み証跡は`/private/tmp/orgbrain-memory-utility-v12-20260907-attempt5-preservation/baseline.json`を基点とし、137 filesをimmutableに保持します。attempt6はC 5件とsemantic quality 5件を受理した後、条件付き実行依頼の`false_adoption`、世代名依頼の`overretention`・`omission`・`fragmented_incident`を含む意味品質失敗で保留されました。attempt6の保全済み証跡は`/private/tmp/orgbrain-memory-utility-v12-20260907-attempt6-preservation/baseline.json`を基点とし、183 filesをimmutableに保持します。attempt6の他3校正ケースはquality passedでしたが、run全体のquality statusはfailedです。attempt1〜7のjob、attempt、initial、accepted、native log、smoke証跡は変更、再送、内容修復、再評価をしません。これらのrunでsmokeを再実行せず、`V12_MANIFEST`へ設定もしません。修正後の比較は、親agentがattempt1〜7と重ならない未使用の不存在パスを`NEW_V12_RUN`に設定してからprepare・実行します。

attempt7はsynthetic 4件がpassした後、校正Cの3件目でモデルが供給されていない`context-1:r2b1:7`をscope evidenceに出力し、`c_transport_evidence:scope_unknown_id`で保留されました。attempt7ではqualityを開始していません。attempt7の保全済み証跡は`/private/tmp/orgbrain-memory-utility-v12-20260907-attempt7-preservation/baseline.json`を基点とし、98 filesをimmutableに保持します。attempt1〜7のjob、attempt、initial、accepted、native log、smoke証跡は変更、再送、内容修復、再評価をしません。

attempt8は公開人工smoke 4/4がpassした後、校正Cの1件目を受理し、2件目を`source_role_spoof`で保留しました。assistant spanを含むfield evidenceとuser spanを含むscope evidenceから導出されるrole集合が`mixed`になる契約を満たさない出力でした。残り3件、quality、holdoutは未実行です。attempt8は比較対象から除外し、保全済み証跡`/private/tmp/orgbrain-memory-utility-v12-20260907-attempt8-preservation/baseline.json`（run 80 files、code snapshots 7件）をimmutableに保持します。attempt8のjob、attempt、initial、accepted、native log、smoke証跡は変更、再送、内容修復、再評価をしません。

実行前にprivate permissionを固定します。

```sh
umask 077
```

新しいrunを作る場合だけ、次の`prepare`を一度実行します。canonical baselineは省略せず明示します。既存の`V12_MANIFEST`へは再実行しません。

```sh
node scripts/memory-utility-v12.mjs prepare \
  --source-manifest "$SOURCE_MANIFEST" \
  --prior-manifest "$CANONICAL_V11" \
  --canonical-baseline "$CANONICAL_V11" \
  --out "$NEW_V12_RUN"
```

`prepare`後にだけ`V12_MANIFEST="$NEW_V12_RUN/manifest.json"`が存在します。以後のコマンドは、保留済みattempt1〜7のmanifestではなく、この新規manifestを使います。

## transportと受理証跡

`C`のtransport JSONでは、各fieldの`evidence`を`[{"id":"span-1"}]`のような入力順ordinal tokenだけで表します。`support_ids`も同じspan tokenを使います。`quality`の`checked_set`は`[{"id":"span-1"}]`、各quality support listは`["span-1"]`、item参照は`item-1`のようなtokenだけです。`source_role`は9つ全field（scopeを含む）のevidenceに現れるroleのunionから導出し、1種類ならそのrole、2種類以上なら`mixed`、0種類なら`unknown`です。例えばassistant spanをcontent evidence、user spanをscope evidenceに使うitemは`mixed`です。モデルにはsource spanがpayloadとして渡り、Cはそこから引用対象spanのordinal tokenを選び、qualityはそのspanを読んでsemantic supportを判定します。モデル出力には原文quoteやcanonical実IDを含めず、受理側がprivate job sourceの入力順とtokenの対応を検証して実IDと全文`quote`をcanonical outputへ補完します。未知token、重複token、順序・容量外token、ID以外のtransport fieldは受理せず保留します。

受理時は、runnerから得たraw文字列を`initial-JOB_ID.json`へ保存し、通常のJSONは`JSON.parse(raw)`の結果を`parsed`へ保存します。単一のJSON code fenceだけを除去した場合も、元のrawを保持したうえで`format_repair`を記録します。CではparsedのID-only evidence、qualityではparsedのID-only `checked_set`をsource spanからcanonical outputへ解決し、正確な全文`quote`を補完します。canonical outputは後続の保存、検索、品質、再回答に使います。

`initial-JOB_ID.json`には`raw_hash`、`parsed_hash`、`canonical_hash`と`canonical_provenance`を持たせます。provenanceはcanonicalization contract、transport kind、`initial.parsed`をsourceとすること、transport hash、canonical hashを記録します。`accepted-JOB_ID.json`にも同じraw・transport・canonicalのhashとprovenanceを束縛します。

reload時の`outputForJob`は、job・initial・acceptedのhash chainを確認し、rawを再parseして`parsed_hash`と一致すること、initialのparsedから再hydrationしたcanonical outputとcanonical hash・provenance・accepted outputが一致することを検証します。改変、ID差し替え、quote差し替え、受理済みcanonical outputの変更は`answer_binding_changed`として受理しません。

## 段階の実行

各stageはJSONをstdoutへ返します。ジョブを作るstageのpendingは必ず次の形です。

```json
{
  "pending": [
    {"id": "calibrate-c-...", "status": "pending"}
  ],
  "jobs": 5
}
```

`status`は対応する`initial-*.json`がまだない場合は`pending`、初回結果が保留された場合は`held`です。`jobs`アーティファクトと各`job-*.json`はcontent hashで固定されます。`initial`があるjobを再送せず、`accepted`があるjobを再実行しません。

最初に公開人工データだけのnative smokeを一度実行します。これは実験15件に数えず、source transcriptや実験memoryを読みません。smokeが受理されるまで実データjobを開始しません。

```sh
node scripts/memory-utility-v12-smoke.mjs run \
  --manifest "$NEW_V12_RUN/manifest.json"
```

校正5件を準備します。

```sh
node scripts/memory-utility-v12.mjs calibrate \
  --manifest "$V12_MANIFEST"
```

出力の`pending`にある`calibrate-c-*`を一件ずつ実行します。`prepare-cli`はprompt、schema、request、active lockを固定します。`run-cli`は固定requestをnative `codex exec`へstdinで渡し、finalが検証できた場合は受理まで自動で行います。

```sh
JOB_ID=calibrate-c-CASE_ID
node scripts/memory-utility-v12.mjs prepare-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"
node scripts/memory-utility-v12.mjs run-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"
```

校正jobを全件完了した後、校正品質jobを作ります。

```sh
node scripts/memory-utility-v12.mjs calibration-report \
  --manifest "$V12_MANIFEST"
```

初回の返り値は通常`{"status":"calibration_quality_incomplete",...}`で、`calibration-quality-jobs.json`に5件の`quality-calibration-*`が保存されます。これらも一件ずつ、同じ`prepare-cli` / `run-cli`順で実行します。

```sh
JOB_ID=quality-calibration-CASE_ID
node scripts/memory-utility-v12.mjs prepare-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"
node scripts/memory-utility-v12.mjs run-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"
```

校正品質jobを全件完了したら、校正reportを確定します。6種類のquality kindそれぞれに、`passed` / `failed` / `unknown`の結果、具体的な理由、原文spanの`support_ids`が必要です。`unknown`を含む校正は`passed`になりません。

```sh
node scripts/memory-utility-v12.mjs calibration-report \
  --manifest "$V12_MANIFEST"
node scripts/memory-utility-v12.mjs report \
  --manifest "$V12_MANIFEST"
```

校正が`status: "passed"`になった場合だけ、固定10件とholdout 5件の抽出jobを作ります。

```sh
node scripts/memory-utility-v12.mjs extract \
  --manifest "$V12_MANIFEST"
```

固定10件の`extract-b-*`は新しいB抽出を行わず、canonical v1.1の検証済み出力をそのまま参照します。holdoutの`extract-b-*`が存在する場合だけnative実行します。全`extract-c-*`と存在するholdout `extract-b-*`を一件ずつ実行します。

```sh
JOB_ID=extract-c-CASE_ID
node scripts/memory-utility-v12.mjs prepare-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"
node scripts/memory-utility-v12.mjs run-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"

# holdout B jobがextraction-jobs.jsonにある場合だけ実行する
JOB_ID=extract-b-CASE_ID
node scripts/memory-utility-v12.mjs prepare-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"
node scripts/memory-utility-v12.mjs run-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"
```

抽出jobが全件`accepted`になったら検索を作ります。検索時刻は各caseの時間境界より前のrecordだけを対象にし、短期TTLの期限時刻は含めません。conflictの両側は一つのretrieval unitとしてtop-kを数えます。

```sh
node scripts/memory-utility-v12.mjs retrieve \
  --manifest "$V12_MANIFEST"
```

検索後、downstream semantic quality jobを作ります。

```sh
node scripts/memory-utility-v12.mjs quality \
  --manifest "$V12_MANIFEST"
```

初回の返り値は通常`{"status":"quality_incomplete",...}`で、`quality-jobs.json`に15件の`quality-*`が保存されます。全件を一件ずつ実行し、もう一度`quality`を呼びます。

```sh
JOB_ID=quality-CASE_ID
node scripts/memory-utility-v12.mjs prepare-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"
node scripts/memory-utility-v12.mjs run-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"

node scripts/memory-utility-v12.mjs quality \
  --manifest "$V12_MANIFEST"
```

quality reportは15件すべての品質jobが構造検証を通った場合に確定します。`status` / `quality_status` が`passed`だけでなく`failed`または`unknown`でも、品質上の失敗・不足を比較対象として残すため、replayとevaluationへ進めます。品質jobが未完了、保留、件数不足、または構造不正の場合は評価へ進みません。

品質reportが構造的に完了したら、`passed` / `failed` / `unknown`のいずれの意味品質判定でも、A/B/Cの再回答jobを作ります。

```sh
node scripts/memory-utility-v12.mjs replay \
  --manifest "$V12_MANIFEST"
```

15件×3方式の全`replay-a-*`、`replay-b-*`、`replay-c-*`を一件ずつ実行します。各payloadのsupplied memoryは最大5 retrieval unitです。gapは本文へ渡し、conflictは一つのmemory objectの`members`内に両側を保持します。relation target、incident、evidenceのIDはreplayではunit内のlocal ID、evaluationではanswer単位のopaque IDです。

```sh
JOB_ID=replay-a-CASE_ID
node scripts/memory-utility-v12.mjs prepare-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"
node scripts/memory-utility-v12.mjs run-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"
```

評価jobを作ります。`evaluate`はquality reportが15件すべて構造的に完了し、replayが全件acceptedのときだけ進みます。意味品質の`failed` / `unknown`は評価を止めず、後続の比較とreportへ引き継ぎます。

```sh
node scripts/memory-utility-v12.mjs evaluate \
  --manifest "$V12_MANIFEST"
```

全`evaluate-CASE_ID`を一件ずつ実行します。`run-cli`はnative finalが検証できたときに自動acceptします。

```sh
JOB_ID=evaluate-CASE_ID
node scripts/memory-utility-v12.mjs prepare-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"
node scripts/memory-utility-v12.mjs run-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"
```

`accept-cli`は、別の承認済みrunnerが同じrunの`cli-request-JOB_ID.json`と`cli-attempts-JOB_ID.json`を作成済みで、`accepted-JOB_ID.json`がまだない場合だけ使います。通常の`run-cli`は自動acceptするため、その直後に`accept-cli`を呼んではいけません。別runnerでfinal descriptorを作った場合の形式は次のとおりです。

```sh
node scripts/memory-utility-v12.mjs accept-cli \
  --manifest "$V12_MANIFEST" --job "$JOB_ID"
```

評価が全件acceptedになったら、盲検reviewとprivate revealを出力します。

```sh
node scripts/memory-utility-v12.mjs export \
  --manifest "$V12_MANIFEST"
node scripts/memory-utility-v12.mjs audit \
  --manifest "$V12_MANIFEST"
node scripts/memory-utility-v12.mjs report \
  --manifest "$V12_MANIFEST"
```

`export`の返り値は`status: "ai_evaluated_human_pending"`で、`review.json`はtaskとanswer id/textだけ、`reveal.json`は方式対応、評価、検索、private mappingを持ちます。`audit`はprivate tree、chain、schema、runner、job hashを再検証します。最後の`report`は通常`status: "improvement_unconfirmed"`です。AI評価は予備評価として記録され、人による確認済みや本番適格とは扱いません。

## 停止条件と状態

native finalがない既知の通信失敗やtimeoutだけはrunnerの定義した再試行対象です。finalが一度でも存在した場合、JSON不正、schema不一致、根拠不足を含めて再生成・内容修復をせず、`initial-JOB_ID.json`へ保存して保留します。未知の終了、設定/schema障害、入力上限超過、quiescence失敗も保留です。

保留jobが一つでも出たら、そのrunの後続jobを開始しません。`prepare-cli`と`inspect-job`は保留を検出すると`run_held:JOB_ID`で停止します。保留artifact、attempt、stderr、native session logを保存したまま、同じjobの再送や別方式への差し替えをしません。

`report`の進行状態は次の意味です。

| 状態 | 条件 |
| --- | --- |
| `calibration_required` | 校正job一覧がまだない |
| `calibration_incomplete` | 校正jobが未完了 |
| `calibration_held` | 校正に保留jobがある |
| `extraction_required` | 校正後の抽出がまだない |
| `retrieval_required` | 抽出後の検索がまだない |
| `replay_required` | 検索後の再回答がまだない |
| `quality_required` | semantic quality reportがまだない |
| `evaluation_required` | 評価jobがまだない |
| `execution_incomplete` | 評価後のreviewがまだない |
| `improvement_unconfirmed` | AI比較は完了したが、人の確認と改善判定は未確定 |

## source reviewと証拠の扱い

親agentのsource reviewは、実装、契約、stage chain、job hash、固定baseline、品質・評価の根拠を読み取って確認する役割です。これは人の顧客評価やplatform approvalではありません。親agentが確認しても`human_reviewed`は自動でtrueにせず、`report`は`no_human_review_claim: true`を保持します。

合格条件を満たさないquality、根拠不足、評価不一致、tie、unknownは改善の証拠に数えません。15件の実行結果を得ても、方式優位、本番品質、再発率改善を単独で主張しません。現在の実装・テスト段階では実データのmodel callは行っておらず、このrunbookは承認後の再現手順です。

## 引き継ぎ時点の状態（2026-09-07）

v1.2は実験用実装であり、比較45回答・15評価とholdout実行は未完了です。
本番採用や改善効果の確認済みを意味しません。現行のブラウザレビュー画面は
v1の10件形式専用で、v1.2の15件形式には未対応です。

- attempt9：校正C 5件を受理、意味品質は4件passed・1件failed。
  contextだけの情報をomissionとしたため、校正と本比較の両方の品質指示へ
  target-onlyの抽出範囲を明記しました。元の176ファイルは保全しています。
- attempt10：公開smoke 4件を受理、校正C 4件を受理、5件目が
  `false_adoption`で保留。113ファイルを保全し、後続は未実施です。
  自然な世代名付与依頼と採用検証規則の不一致が次の調査対象です。
- attempt1〜10は再実行・修復・上書きせず、以後の実験には未使用runを使います。
- 完了済みのv1.1の10件・30回答の予備AI評価は、v1.2の効果証明とは区別します。

次の作業では採用の意味判定と機械的受理条件の整合を精査し、校正通過後に
固定10件＋holdout 5件の比較を完走してください。現在の運用はAstra親タスク単独で、
サブエージェントを使用しません。私的な原文・実行ログ・比較データはGitへ含めません。
