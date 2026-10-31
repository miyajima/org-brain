# ローカルClaude CLIの記憶再利用

このプロジェクト専用の段階導入。設定は`.local/memory-reuse/config.json`、通常フックは`.claude/settings.local.json`、原本は既存のローカルMemoryStoreを使う。クラウド設定を変更しない。

2026-10-26の実測と採否は`artifacts/memory-reuse-loop-20261026/REPORT.md`。採用フラグはobject・operation・changes・result。recent・procedureは無効。採用は合成課題での暫定判断であり、通常作業や実メンバーの成果は未観測。

## インストールと状況確認

```sh
node scripts/memory-reuse-claude.mjs install
node scripts/memory-reuse-claude.mjs status
```

installは実測report.jsonの採否を読み、プロジェクト設定へマージする。既存フック・権限を保持し、同じフックを重複登録しない。初回の設定原本は`.local/memory-reuse/settings.before.json`へ保存する。許可を増やすのはこのヘルパーのrecall/reportコマンドだけ。

UserPromptSubmitは明示された相対ファイルと、プロジェクトに設定した具体的な作業表現から最大3対象を選ぶ。検証済み原本のローカル出典参照、またはID・版・出典を固定したbindingsで対象へ接続する。内容の一括検索は行わない。案内前と照会時に権限・期限・現在版・矛盾・機微情報を確認する。

既存の原本を手動で対象に結び付ける場合:

```sh
node scripts/memory-reuse-claude.mjs link '{"source_id":"EXISTING_MEMORY_ID","source_version":1,"object_type_key":"file","object_id":"docs/example.md"}'
```

このコマンドは新しい知識を作らない。既存の原本ID・版を参照する。原本の対話的保存は従来のpropose→明示確認→confirmを維持する。

## 利用と追跡

```sh
node scripts/memory-reuse-claude.mjs recall '{"object_type_key":"file","object_id":"docs/example.md","task_id":"claude:CURRENT_SESSION_ID"}'
```

通常はフックが実際のセッションID付きコマンドを渡す。案別フラグに従いresult/procedure/changes/object/operation/recentを順に調べ、最初の適用可能な参照を返す。channelを指定した単独照会も可能。処理不能なDBエラーを「記憶なし」に置き換えない。

PostToolUseは実際のネイティブ操作IDを記録する。原本が操作に実際に寄与したときだけ、フックが渡す短いreportコマンドを実行する。提示やreceiptの発行だけでは適用や有用性を確定しない。Stopは原本の取得→操作→利用報告の順序・スコープ・版と照合する。成功率や意味の保持は、別の課題検証が必要。

同じ版が会話に残っている間は、実際のrecall完了、または原本提示後の実PostToolUseで確認した参照を再提示しない。PreCompactで提示済み版を解除し、必要なら再取得できるようにする。照合用の操作記録は各UserPromptSubmitで更新する。ネイティブ会話ファイルが存在しなければ、実PostToolUseの記録を使う。これらは固定応答やモデルが書いた操作説明から生成しない。

記録は無視対象の`.local/memory-reuse/native-evidence/`、最終状態は`last-observation.json`。コマンドや応答の照合情報を含むためローカルで扱い、Wikiへ取り込まない。最大4MiB、機微情報が疑われる記録は保留し、欠測を確認済み利用へ変換しない。`natural:false`の実験は通常利用と別扱い。

## 六つの機能と適用境界

|フラグ|動作|現状|
|---|---|---|
|object|対象に結び付いた原本の照会|有効|
|operation|実際の利用で確認した操作と対象の組み合わせから案内|有効|
|recent|個人×案件の1枚カード、7日以内と古い未解決項目、原本ID/版を保持|無効|
|changes|利用者×対象の前回提示版と現在版を比較|有効|
|procedure|異なる2タスク以上で照合済み利用がある原本を手順へ昇格|無効|
|result|入力・出典・環境・版が一致する検証済み結果を照会|有効、信頼されたアダプターが必要|

最近のカードや手順を別知識として数えない。共有時は利用者別のビューと原本の権限を確認する。成果物は既定で所有者限定。別利用者への明示的な共有許可に加え、すべての原本に対する読み取り権限が必要。

`MemoryReuse`のapplyArtifactは信頼されたホストのコールバックを必要とする。任意の保存済みBashは実行しない。結果のフィンガープリントには入力・原本バイト/版・環境・実装版を含める。実行結果は、対応するネイティブ完了をconfirmApplicationで照合して初めて別の適用経路として数える。モデルの原本利用履歴には置き換えない。

今回の実モデル結果再利用は合成計画アダプターを使い、保存された計画をClaudeが選択して現行条件で再検証・適用した。通常業務の任意の確認結果が自動キャッシュされるわけではない。新しい操作へ広げる場合は、その操作の入力・出典・環境・検証条件を定義したアダプターを先に作る。

ローカルMCPの`orgbrain_context_enrich`へ、対象と`reuse:{channel,flags}`を明示すればこの経路を選べる。resultではfingerprint、operationではoperationを指定する。通常のMCP APIと既存の利用追跡APIの設定は維持する。

## 測定と再現

```sh
python3 scripts/memory-reuse-loop.py --summarize
python3 scripts/memory-reuse-report.py
```

これら2コマンドは保存済みデータから再集計するだけでモデルを起動しない。`--channel`やnative-smokeは新しいモデル実行なので、今回終了後は必要性と予算を確認してから実行する。

attempts.jsonはCLI起動前に1件を確保し、準備・失敗も上限へ計上する。初期上限240回から、追加比較について明示回答を受け累計270回、330回へ段階的に変更した。条件充足時の原本省略と前回結果の追加30回も明示回答を受け、累計360回を完了。現在の実モデル測定は終了。未解決の試行があれば新規起動を止める。結果比較のcutoffは開始前に固定し、比較中の対照群の結果を処置群に渡さない。

トークンは入力・キャッシュ作成・キャッシュ読込・出力の総和。内部時間は総時間に二重加算しない。欠測はnull、請求はAPI換算と分ける。今回の初回セットアップ時間・契約請求・親実装費は欠測。通常利用での機能併用は個別案比較と別集計にする。

## 2026-10-27: 既存のWiki由来知識を通常作業へ接続

通常DBの確認済み知識2件は出典が`source:ID@VERSION`であり、ファイルパスだけを扱う旧フックでは対象リンクが作られていなかった。`.local/memory-reuse/config.json`の`bindings`で、既存の記憶ID・現在版・出典参照と、関連するプロジェクト内の対象を結ぶ。原本の本文・権限・審査状態・版を変更しない。

```json
{
  "bindings": [{
    "source_id": "EXISTING_MEMORY_ID",
    "source_version": 1,
    "source_ref": "source:EXISTING_SOURCE_ID@1",
    "targets": ["docs/example.md", "scripts/example.test.mjs"],
    "phrases": ["specific.command", "具体的な作業名"]
  }]
}
```

この対応は、原本と現在の対象を確認してプロジェクト単位で設定する。無関係な文書や似た名前へ自動的に結び付けない。phrasesは4文字以上の具体的な表現を使い、ASCIIの識別子は前後の文字境界も確認する。固定した版や出典が変われば対応を再確認する。未確認の知識を昇格させる機能ではない。

```sh
node scripts/memory-reuse-claude.mjs connect
node scripts/memory-reuse-claude.mjs status
```

connectは現在の利用者で原本を読み直し、activeかつverifiedの知識だけを結ぶ。期限切れ・版違い・権限違い・出典不一致・外部パス・外へ出るシンボリックリンクは接続しない。無関係なDBエラーを「対象なし」に置き換えない。結果は`.local/memory-reuse/connection.json`。installを再実行してもbindingsと選択したローカルDBを保持する。フックも同じ接続処理を実行するので、既存のファイル出典も従来どおり使える。

今回接続したものは既存2知識、対象6件。Codex上の実作業で2知識の利用をネイティブ呼び出しと照合した。Claude上の比較は合成資料で別集計し、実データを外部Claudeへ送っていない。statusの`verified_claude_knowledge_task_pairs`はClaudeの履歴だけを数え、Codexの実利用は含めない。記録がないことを未使用と断定しない。

追加比較の結果と累計CLI台帳への参照は`artifacts/memory-reuse-connected-20261027/REPORT.md`。旧6案比較は当時の結果として保持し、新しい通常接続比較と混ぜない。

## 2026-10-27: 提示と利用報告の費用を減らす

`.local/memory-reuse/config.json`の`delivery_mode`を`inline`へ変更した。対象に結び付いた短い原本を開始フックで直接提示し、モデルがrecallコマンドを実行する手間を省く。本文・理由・適用条件・ID/版は残し、権限と現在版を同じ経路で確認する。報告コマンドは開始時に一度案内し、操作後は実際の操作IDと短い注意だけにする。フラグ・原本・bindings・既存フック権限は保持した。

提示は利用ではない。明示reportと実PostToolUseを照合して初めて確認済み利用にする。inlineでは、実際に生成したフック文脈とネイティブ操作を別の種別で記録し、原本を読んだ架空のツールイベントを作らない。報告欠落・不正な操作ID・提示後の版変更は確認済みにしない。省略時は従来の`lookup`。戻す場合は`delivery_mode`だけを`lookup`へ変更し、バックアップ全体で後日の設定変更を上書きしない。

同じ合成課題をなし・現行・改善版各10回で再比較した。全条件で成功・必須条件保持10/10、現行と改善版とも4知識・8課題（個人4/模擬チーム4）で利用、対象外の誤適用0。総トークンは139,528→243,082→207,743、平均13.333→17.038→17.071秒。改善版は現行比14.54%減だが、記憶なし比48.89%増。調査回数は全条件20回で、短い作業での費用回収は確認できていない。品質と再利用を維持し、現行より負担が小さいためプロジェクト内の暫定採用とする。

結果、費用勘定、ネイティブ根拠の監査は`artifacts/memory-reuse-efficiency-20261027/REPORT.md`、設定と戻し方は同ディレクトリの`ROLLOUT.md`。この測定はモデル/effortを固定した実Claude CLIであり、固定応答再生ではない。自然な実業務のClaude再利用・実チーム効果は引き続き未観測。短い調査だけでなく、同じ条件を繰り返し調べる負担の大きい作業へ対象を限定して使うのが次の観測候補であり、効果が確認できたという意味ではない。

再集計と監査はモデルを起動しない:

```sh
python3 scripts/memory-reuse-efficiency-report.py
```

## 2026-10-27: 操作への申告同梱と最新確認

`tracking_mode=bundled`をプロジェクト設定へ追加した。`action_adapters`で固定argv・対象・許可する操作を定義した場合だけ、モデルが`run`の`uses`へ選んだ参照を実操作へ同梱する。ホストは実際のPostToolUseで操作ID・出力・タスク・対象・権限・現在版を確認し、従来のreport APIからreceiptを得る。ホストの記録はツール呼び出しと区別し、Stopで原本と実操作へ照合する。提示だけや申告なしは利用済みにしない。既存reportによる追跡も維持する。

通常の導入先は`test-wiki-intake`と`test-pipeline-review`の2操作。関連するテストファイルを対象に作業すると、固定したNodeテストのアダプターが案内される。モデルは完全な操作入力を生成し、実際に寄与した参照だけを指定する。任意のBashへ利用追跡用引数を追加しない。未対応の対象では従来の明示reportを使う。戻す場合はtracking_modeをstandaloneへ変更する。

改善1の各10回比較では、独立report8→0、総トークン210,965→169,364、平均16.063→13.550秒。4知識8課題（個人4・模擬チーム4）の利用と成功/必須条件保持10/10を維持した。ただし記憶なし比では20.46%増であり、業務全般の費用回収を示していない。

`freshness_mode=validated`は、事前に成功した信頼できるローカル検証の入力・出典バイト/版・環境・権限・期限が一致するかを確認する。変化や確認不能なら再調査が必要。原本や環境を変えた拒否テスト、申告後の変更をStopで拒否するテストを通過した。内部のハッシュ読み取りや事前検証も準備/追跡費に含める。固定した計画回答を返すキャッシュではない。

改善2は最新確認24回が通っても調査20回が減らず、総トークン169,133→174,093となったため、通常のfreshness_modeは無効のまま。実業務向けの検証プロファイルも設定していない。合成課題のプロファイルは実業務へ流用しない。単に確認機能を用意することと、調査を減らすことを分けて扱う。

2段階の各3条件×10回を順に実施し、段階間の入力は変え、段階内の原本・課題・指示・ツール・成功条件は固定した。追加のAPI換算は1.419806 USD。自然なClaude実業務と実メンバーのチーム効果は未観測。結果は`artifacts/memory-reuse-bundled-20261027/REPORT.md`、反映と戻し方は同じ場所の`ROLLOUT.md`、モデルを起動しない監査は次のコマンド。

```sh
python3 scripts/memory-reuse-actions-report.py
```

## 2026-10-29: 条件を満たす原本と前回結果の優先利用

`source_resolution=verified`と`freshness_mode=validated`を指定した操作では、明示的な`<task_input>`が操作の`conditions`に一致し、検証器が全`required_fields`の`complete_source` coverageを確認した場合だけ、開始時に完全な原本を渡す。`resolve`は同じタスクへ提示済みで現在も条件が一致するとき再取得を省く。`refresh=true`、条件不足、入力の曖昧さ、失効、版・権限・依存関係の変化では現在の原本を照会する。照会の追跡IDは利用申告のIDではない。`uses`には提示された`usage_item_id`だけを指定し、ない場合は`[]`とする。

`result_mode=validated`と操作ごとの`result_contract`を設定すると、成功した実ネイティブ操作の結果だけを元のID・版に結び付けて保存できる。Nodeアダプターの実装、入力、出典バイト/版、宣言した依存関係と環境、権限、期限が一致する場合、開始時に前回結果のIDを案内する。モデルが`run`でその`result_id`を明示選択すれば、計画のモデル再生成を省ける。元の知識をモデルが読んだ記録には変換せず、Stop後の`last-observation.json`の`derived_applications`へ別記する。別利用者には明示grantと元知識の読取権限も必要。

設定には固定した`source_argv`/`source_requests`、検証器の`freshness_profiles`、完全な条件と依存関係が必要。`result_contract`は`operation`、`payload_field`、`result_field`を定義する。検証済み入力に新しい条件が加わる場合はプロファイルを更新し、元の検証結果を使わない。通常作業用の完全条件プロファイルはまだ設定しておらず、既存の通常設定と2つのNodeテスト操作は保持した。任意の操作の調査や検証を一律に省略する設定ではない。

今回の比較は`artifacts/memory-reuse-resolution-20261027/REPORT.md`。準備失敗2回と結果の追加確認1回を分離し、同じ9課題×3条件で比較した。原本照会9→2、成功・意味保持は全条件9/9。知識ではトークン16.29%減・時間7.37%短縮、前回結果も使うと24.43%減・18.47%短縮。知識のみのAPI換算費用は0.44%増で、結果も使う場合は15.38%減。作成済み結果がある当回の効果であり、元の作成費は別記する。合成評価の採用条件は満たしたが、実業務の自然な再利用・実メンバーのチーム効果は未観測。
