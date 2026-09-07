# Memory Utility v1

実験専用のJSON CLIと既存評価ページ内の「活用比較」。通常Router v2、旧実験、旧回答parser・保存キー、通常メモリDBを変更しない。これは既知の開発データでの回答・修正方針の比較であり、独立holdout、コード修正実証、不具合再発率、本番品質保証ではない。

## 今回の合意済み条件

2026-09-06、実装中に判明した制約についてユーザーが次を明示選択した。

- Aは共通のhost背景記憶を含み、実験由来の記憶だけを追加しない。`fork_turns: none`でもhostのMemory Summaryは注入されるため、厳密な「記憶なし」とは呼ばない。実行ログから共通Memory Summaryのhashを固定し、相互作用という交絡を残す。
- Bの抽出promptは既存v2を完全維持する。そのprompt内のRouter判定・rule hintsは抽出子にも渡る。replayとevaluateの方式名は引き続き伏せる。

## コマンド

全コマンドに `--manifest` が必要。prepareだけは既存120件のv3.3 manifestを受け、以降は新実験manifestを受ける。

```sh
node scripts/memory-utility-v1.mjs prepare --manifest SOURCE_MANIFEST --out NEW_PRIVATE_DIRECTORY
node scripts/memory-utility-v1.mjs extract --manifest RUN/manifest.json
node scripts/memory-utility-v1.mjs inspect-job --manifest RUN/manifest.json --job JOB_ID
node scripts/memory-utility-v1.mjs accept --manifest RUN/manifest.json --job JOB_ID --metadata NATIVE_POINTER_JSON
node scripts/memory-utility-v1.mjs retrieve --manifest RUN/manifest.json
node scripts/memory-utility-v1.mjs replay --manifest RUN/manifest.json
node scripts/memory-utility-v1.mjs evaluate --manifest RUN/manifest.json
node scripts/memory-utility-v1.mjs export-review --manifest RUN/manifest.json
node scripts/memory-utility-v1.mjs report --manifest RUN/manifest.json --human HUMAN_JSON
```

### v1.1 の校正付き再実行

v1の初回正規runは変更しない。v1.1は同じseedで固定済みの実験10件を再選択し、そのgroupと重ならない適格caseを別seedで5件選んでC抽出契約を先に校正する。

```sh
node scripts/memory-utility-v11.mjs prepare --manifest SOURCE_MANIFEST --out NEW_PRIVATE_DIRECTORY
node scripts/memory-utility-v11.mjs calibrate --manifest RUN/manifest.json
node scripts/memory-utility-v11.mjs prepare-cli --manifest RUN/manifest.json --job JOB_ID
node scripts/memory-utility-v11.mjs run-cli --manifest RUN/manifest.json --job JOB_ID
node scripts/memory-utility-v11.mjs calibration-report --manifest RUN/manifest.json
node scripts/memory-utility-v11.mjs extract --manifest RUN/manifest.json
```

校正5件は実験結果へ混ぜず、抽出、検索、再回答、AI評価、人の比較には使わない。5件すべての初回出力が形式と実行時検証を通り、`calibration-report.json` が `passed` になった場合だけ固定10件の `extract` を作成できる。校正を含むどのjobでも初回出力が保留になればrun全体を停止する。

Cの `storage: "long"` は、対象turnに根拠を持つ空でない `condition` または `reason` がある場合だけ許可する。両方とも空なら `short` または `none` を選ぶ。この条件はjob内のJSON Schemaと日本語instructionへ明記し、受付時にも同じ規則を検証する。校正と実験は同じhost背景記憶hashを要求する。校正通過後のコマンド、native実行条件、人の確認形式はv1と同じで、ブラインドUI用のreview/reveal/human JSON契約はv1互換を維持する。

`extract/replay/evaluate`はジョブを準備するだけ。v1では各pending jobのpromptそのものをnative子のmessageに完全一致で渡す。v1.1では90KB級入力の転記誤りを避けるため、`prepare-cli`が0600のpromptファイルと実行要求を固定し、freshな`codex exec`へstdinでそのまま渡す。Sol/medium、read-only、実行は1件ずつ、ツールを使わずJSONだけ返す。`prepare-cli`から`accept-cli`までrun単位のactive lockを保持し、別jobの準備と並行実行を拒否する。`accept-cli`はnative session logの平文user message、model/effort、単一turn、単一final、ツール未使用、JSONL eventsを照合する。別モデル代替・同じsessionの再利用・成功済み処理の再送はしない。

v1.1の各ジョブは、`run-cli`が固定済みの実行要求を読み、次の経路を1件ずつ実行する。`umask 077`を必須とし、stdout events、stderr、最終回答、試行記録もrun内に閉じる。

```bash
node scripts/memory-utility-v11.mjs prepare-cli --manifest RUN/manifest.json --job JOB_ID
umask 077
node scripts/memory-utility-v11.mjs run-cli --manifest RUN/manifest.json --job JOB_ID
```

`run-cli`は`codex exec -C ROOT -s read-only -m gpt-5.6-sol -c 'model_reasoning_effort="medium"' --json --output-schema SCHEMA -o OUTPUT -`を固定引数で起動し、promptをstdinへ渡す。最終出力が得られた場合は受け入れ検証まで行う。最終イベント・出力ファイル・nativeログのいずれかにfinalがあれば、その内容が不正なJSONでも再試行せず保留する。finalがなく、タイムアウトまたは既知の通信障害をnative/stderrで確認できた場合だけ、プロセス群の終了とquiescenceを確認してfreshなsessionを1回だけ再実行する。未知の終了、設定・schema障害、stream上限超過、プロセス群が残った場合は再試行せず保留する。各試行は`cli-attempt-JOB_ID-N.json`、全体は`cli-attempts-JOB_ID.json`へ保存し、受け入れ時はquiescentな試行、hash、schema、runner、fresh session、非重複時間、finalの一意性を再検証する。

v1のNATIVE_POINTER_JSONは `{"parent_log":"親のnativeログ絶対パス","agent_path":"/root/子の名前"}`。親のspawn引数、fresh指定、子のID・親ID・単一turn・モデル/effort・単一final・ツール未使用・追加入力なし・同時実行なしを照合する。v1.1はstdin promptファイル、CLI events、最終回答ファイル、native session logの4者を照合する。どちらもローカルnative証跡であり、内部backendの独立attestationではない。

初回は別ファイルへ0600で保存する。形式修正は単一JSONフェンスの除去を1回だけ許す。JSON内容・判断・根拠IDの書き換えを必要とする結果は保留し、別方式や再生成で埋めない。形式修復可能な全エラーを救済する契約ではない。

一度でも初回結果が保留になったrunでは、`inspect-job`、`prepare-cli`、`accept`、`accept-cli`が未実行の別jobを `run_held:JOB_ID` で拒否する。別ディレクトリで続けても正規runの継続とは扱わず、除外実行として証跡とtoken数を残す。

### v1.2 の完全な実行順序

v1.2はv1.1の固定10件を、明示したcanonical baselineからそのまま再利用する。既定のbaselineは `/private/tmp/orgbrain-memory-utility-v11-20260906-attempt3/manifest.json` であり、v1だけのmanifestへフォールバックしない。校正5件とholdout 5件はgroupを分離し、holdoutのBも凍結v2のpacking・保持判定・検索本文を通る。Cのupdate/conflict/duplicateは一つの応答をまとめて検証してから保存する。

次の例では、source manifest、canonical v1.1 manifest、v1.2 runを固定する。`prepare`はsourceの再構成とhash照合に失敗した場合はrunを作らず停止する。

```sh
SOURCE_MANIFEST=/private/tmp/orgbrain-router-v33-cloud-20260905/manifest.json
CANONICAL_V11=/private/tmp/orgbrain-memory-utility-v11-20260906-attempt3/manifest.json
V12_RUN=/private/tmp/orgbrain-memory-utility-v12-20260907-run

umask 077
node scripts/memory-utility-v12.mjs prepare \
  --source-manifest "$SOURCE_MANIFEST" \
  --prior-manifest "$CANONICAL_V11" \
  --out "$V12_RUN"
node scripts/memory-utility-v12-smoke.mjs run --manifest "$V12_RUN/manifest.json"
node scripts/memory-utility-v12.mjs calibrate --manifest "$V12_RUN/manifest.json"
```

`calibrate`後は、返された5件の `calibrate-c-*` を一件ずつ、同じrunで実行する。各jobは `prepare-cli` と `run-cli` の順に実行し、active lockを保持する。`run-cli`でfinalが得られないjobはheldとなり、そのrunでは後続jobを実行しない。

```sh
node scripts/memory-utility-v12.mjs prepare-cli --manifest "$V12_RUN/manifest.json" --job JOB_ID
node scripts/memory-utility-v12.mjs run-cli --manifest "$V12_RUN/manifest.json" --job JOB_ID
node scripts/memory-utility-v12.mjs calibration-report --manifest "$V12_RUN/manifest.json"
```

最初の `calibration-report` は5件の意味品質jobを `calibration-quality-jobs.json` に作成して `calibration_quality_incomplete` を返す。`quality-calibration-*` を同じ手順で全件実行し、もう一度 `calibration-report` を実行する。各jobの `positive_evidence` は6種類すべてに一件ずつ必要で、各件が `passed`、`failed`、`unknown` の結果、具体的な理由、source spanのsupportを持つ。unknownを含む校正はpassedにならない。

```sh
node scripts/memory-utility-v12.mjs prepare-cli --manifest "$V12_RUN/manifest.json" --job quality-calibration-JOB_ID
node scripts/memory-utility-v12.mjs run-cli --manifest "$V12_RUN/manifest.json" --job quality-calibration-JOB_ID
node scripts/memory-utility-v12.mjs calibration-report --manifest "$V12_RUN/manifest.json"
node scripts/memory-utility-v12.mjs extract --manifest "$V12_RUN/manifest.json"
```

校正がpassedになった後の固定10件とholdout 5件について、同じjob実行手順を `extract-c-*` および存在する `extract-b-*` 全件へ適用する。その後のstageは次の順で、各stageのpending jobを一件ずつ完了させてから次へ進む。

```sh
node scripts/memory-utility-v12.mjs retrieve --manifest "$V12_RUN/manifest.json"
node scripts/memory-utility-v12.mjs replay --manifest "$V12_RUN/manifest.json"
node scripts/memory-utility-v12.mjs prepare-cli --manifest "$V12_RUN/manifest.json" --job replay-a-JOB_ID
node scripts/memory-utility-v12.mjs run-cli --manifest "$V12_RUN/manifest.json" --job replay-a-JOB_ID
node scripts/memory-utility-v12.mjs quality --manifest "$V12_RUN/manifest.json"
```

`quality`の初回呼び出しはdownstream quality jobを作るため、`quality-*` を全件実行してから再度 `quality` を呼ぶ。quality reportがpassedでない限りevaluateへ進まない。evaluateのjobも `prepare-cli` / `run-cli` で全件完了させ、最後にreview、report、auditを出す。

```sh
node scripts/memory-utility-v12.mjs quality --manifest "$V12_RUN/manifest.json"
node scripts/memory-utility-v12.mjs evaluate --manifest "$V12_RUN/manifest.json"
node scripts/memory-utility-v12.mjs prepare-cli --manifest "$V12_RUN/manifest.json" --job evaluate-JOB_ID
node scripts/memory-utility-v12.mjs run-cli --manifest "$V12_RUN/manifest.json" --job evaluate-JOB_ID
node scripts/memory-utility-v12.mjs export --manifest "$V12_RUN/manifest.json"
node scripts/memory-utility-v12.mjs report --manifest "$V12_RUN/manifest.json"
node scripts/memory-utility-v12.mjs audit --manifest "$V12_RUN/manifest.json"
```

`retrieve`はconflictの両側を一つのretrieval unitとしてtop-kを数える。replayとevaluationへ渡すgapは保持し、evaluation payloadでは候補、選択、relation target、incident、evidenceのIDをanswer単位のopaque IDへ写像する。方式名、case/method ID、frozen providerのstorage reasonはpromptから除き、対応表はprivateな `reveal.json` 側へ保存する。

## データと検索

元120件と元入力ファイルhashを照合し、元セッションの順序と旧source hashを再現する。旧source hashの照合用projectionと、Cへ渡す原文は分離する。本文を切らず、原文から行区間IDとUTF-16 offsetをローカルで生成する。同一発言者・同一本文・同一時刻の重複だけ除去する。対象turnの根拠が新規保存には必須。直前最大2 turnは解釈専用。

後続の最初のユーザー依頼を時間境界とし、後続回答はpacketへ入れない。安全で後続依頼を復元できたcaseを `sha256(memory-utility-v1:case_id)` 順、groupごと最大1件で10件固定する。旧ラベル・旧スコア・抽出成績では選ばない。10件未満なら停止し、人工データで埋めない。

各場面のストアは独立して空から始める。Cの同一出力内の先行itemに対する重複・更新・矛盾を記録する。対象外groupの記憶や通常DBは検索しない。短期は根拠の発生時刻から30日（期限と同時刻は無効）。Bは凍結v2のpacking/短期履歴を使い、候補検証は既存cap-runnerのpure verifier関数だけをASTから取り出して実行する。API/DB/provider関数は取り込まない。

文字2-gram TF-IDF cosine、上位5件、同点はID順。クエリは依頼本文だけ。抽出・保存しなかったもの・検索候補・取得結果・回答子の利用自己申告を別ID列で残す。自己申告は実際のコード上の利用を証明しない。

入力上限は100,000 UTF-8 bytesの保守的な上限。実測token数とは扱わず、超過は未実行。料金はnull、native token数がなければnull。通常DBを開かず、全成果物は新規0700ディレクトリ・0600ファイルへ保存する。Codexの非公開セッションログにも入力と実行内容が残る。

## 人の確認

`/admin/memory-extraction-evaluation` の活用比較へ `review.json` を読み込む。メニューリンクは追加しない。方式名・AI評価は別 `reveal.json` に隔離し、最初のpayloadへ入れない。全10件の人の回答確定後にrevealを読み込める。localStorageは `orgbrain:memory-utility:v1:実験ID`、旧評価と独立。人の判定をJSON保存してreportへ渡す。

単一の「最も役立つ」選択では残り2回答間の順位は分からないためunknownを残す。Cの勝ち数が `負け数 + unknown` より多いという最悪補完でも勝ち越す条件をA/Bそれぞれに要求する。全10件確定、保留なし、Cの重大なAI記憶害ゼロ、人が指摘したCの重大誤りゼロも必要。人の重大誤りの記憶起因性が未確定の場合も保守的に拡大支持を出さない。人とAIを自動で同一判定にしない。

状態は `source_reconstruction_insufficient`、`execution_incomplete`、`ai_evaluated_human_pending`、`expansion_supported` / `expansion_not_supported` を区別する。本番反映や分類器追加学習は行わない。

### v1.1 評価専用の再評価

初回 v1.1 runの `manifest.json`、校正5件、抽出17件、再回答30件、retrieval、各再回答のinitial rawは読み取り専用で参照する。抽出・検索・再回答は再生成しない。初回の `initial-evaluate-*`、`cli-*evaluate-*` など評価証跡は、内容を修復せず `excluded_prior_evaluations` としてhashだけを親参照へ残す。

評価契約だけを更新した評価専用runを、存在しない0700ディレクトリへ作成する。

```sh
node scripts/memory-utility-v11-evaluation-only.mjs prepare \
  --source-run /private/tmp/orgbrain-memory-utility-v11-20260906-attempt3 \
  --out /private/tmp/orgbrain-memory-utility-v11-20260907-evaluation-only
```

`prepare` は親のchain、30件のaccepted replayとinitial raw、retrieval/raw evidence、校正・抽出・再回答の件数を検証し、親ファイルhash、入力hash、runner/schema/code hash、盲検順を新runへ固定する。既存runのファイルは書き換えない。評価jobの入力には供給された全memory IDと再回答の `used_memory_ids` 自己申告を分けて記録する。

実データを評価する前に、公開人工データだけを使う新schemaの短いnative smokeを1回実行する。これは10件の評価には数えず、別の再送は行わない。smokeが成功して `synthetic-smoke.json` を作るまで、評価専用runの `run` は実データjobを開始しない。

```sh
umask 077
node scripts/memory-utility-v11-evaluation-only-smoke.mjs run \
  --manifest /private/tmp/orgbrain-memory-utility-v11-20260907-evaluation-only/manifest.json
```

smokeがacceptedになった場合だけ、10件のうち1件目を実行する。これは実データ評価の最初のjobで、smokeの再送ではない。

```sh
node scripts/memory-utility-v11-evaluation-only.mjs run \
  --manifest /private/tmp/orgbrain-memory-utility-v11-20260907-evaluation-only/manifest.json \
  --job evaluate-only-case-0ca5157d5d546dfc59bc6f0e
```

最初の実データjobがacceptedになった場合だけ、残りのjobを同じrunで実行する。

```sh
node scripts/memory-utility-v11-evaluation-only.mjs run \
  --manifest /private/tmp/orgbrain-memory-utility-v11-20260907-evaluation-only/manifest.json
node scripts/memory-utility-v11-evaluation-only.mjs export-review \
  --manifest /private/tmp/orgbrain-memory-utility-v11-20260907-evaluation-only/manifest.json
node scripts/memory-utility-v11-evaluation-only.mjs report \
  --manifest /private/tmp/orgbrain-memory-utility-v11-20260907-evaluation-only/manifest.json
```

smokeと評価10件は既存の v1.1 `runCli` と `cliResult` をそのまま使い、Sol/medium、read-only、stdin平文、単一turn、単一final、tool-free native logを検証する。finalが一度でも観測された場合はJSON不正や評価証拠不足でも再試行・出力修復せずinitialへ保存してglobal holdにする。通信失敗のrunner retry後を含め、runnerがheldにしたfinal-present試行も受け入れない。評価専用runでholdが発生したら以降のjobを停止する。評価10件の各native sessionから得た共通 Memory Summary hashは、最初のaccepted評価で `host-context.json` へ固定し、以降の全評価で同一であることを検証する。source runのhashとの一致は要求せず、source hashと新run hashの一致・不一致を `source_common_memory_hash_match` として記録し、差異は日時・host contextの差異として扱う。

新schemaでは通常の3指標が従来どおり `rating`、具体的な `reason`、source `support_ids` を持つ。`memory_harm` は次を検証する。

- `meets`: 対象 `checked_answer_id`、その回答へ供給されたmemory IDの完全な集合、具体的なreason。source `support_ids` は空でもよい。
- `partial` / `fails`: 回答本文に実在する問題 passage、因果的な供給memory ID、source制約の `constraint_support_ids`。
- `unknown`: 判定不能な不足証拠を示す `missing_evidence_reason`。

`used_memory_ids` の自己申告だけは無害性の証拠として扱わない。`review.json` は既存 `memory-utility-review/v1` のtaskとanswer id/textだけへ射影してUIの盲検順を維持し、拡張された評価証拠とretrieval/raw evidenceは `reveal.json` に保存する。人の判定JSONが渡されない `report` は `human_judgment_fabricated: false` のまま保留を返し、人の判定を自動生成しない。

## Nativeログの照合範囲

このhostではparentのspawn `message` が暗号化されて保存される。平文が見えるhostでは完全一致を検査し、暗号化された場合は prepared_prompt_hash と dispatch_message_hash を別々に保存する。call ID・子IDでnative実行を結び、`input_plaintext_attested: false` を初回記録・受付結果・副指標・reportへ保持する。暗号化hashを入力一致の証明にしない。

v1.1の`codex exec` session logではuser messageが平文で残るため、固定済みjob promptとの完全一致を検査し、`input_plaintext_attested: true`を記録する。固定した実行要求とnativeのturn contextからSol/medium、read-only、session source、cwd、単一turn、単一final、ツール未使用を照合し、events側のsession IDとusageも確認する。nativeログだけではstdinと同じ内容を位置引数で渡した実行を区別できないため、`execution_transport`はローカルの実行要求と成果物を結んだ記録であり、入力経路に対するbackendの独立証明ではない。共通Memory Summaryのhashは各sessionで同一でなければ受付を拒否する。

今回の初回受付でこの差異を発見したため、元config・全job hash・初回rawを保存し、`validator-revision.json` に変更前後のcode hashを追記した。変更は検証器だけで、prompt・選定・モデル・初回回答は不変。初回の再送はしていない。
