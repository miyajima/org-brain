# Agent Memory Protocol (AMP) 0.3 — 提案草案

状態: OrgBrainで試せるローカル参照実装。外部で承認された標準や、他製品との互換性を意味しない。

2026-11-11: 検索の応答契約を`retrieval_version:0.2`へ更新した。既定は説明用の候補一覧。従来の原本検索を同じ範囲で併用し、本文と根拠を段階的に読む。既存の一括取得が必要なら`detail:evidence`、条件不一致を除外する用途なら`mode:apply`を明示する。

2026-11-12: 文書形式`amp/0.2`を追加した。0.1では整理済みの記憶が5件しか作られず、未整理の質問ではAMPが従来検索に何も上乗せできなかった。原因は保存の重さ（10項目以上の必須欄、手書きのID・版・SHA-256、索引のhash固定）にあるため、0.2は「保存しやすさ」を優先する。
- 必須は`basis`、`claim`、`evidence`（1〜8件）だけ。他は既定値（別名・条件・例外・手順・限界は空、`status:active`）。
- IDはページのパス、版はWikiのページhash。手書きの`revision`は使わない。
- 根拠の参照は`source:ID@版#L開始-L終了`だけを書けばよい。`orgbrain_wiki_amp_save`が範囲を実際に読み、原本のSHA-256を補って保存する。読めない範囲があれば何も保存しない。
- 索引はパスで記憶を指す。記憶を更新しても索引の再固定は不要で、検索から消えない。
- 0.1のページはそのまま読める（索引のhash固定などの0.1の規則も維持）。

2026-11-12（同日）: 他のメモリ層ツールの形式を調べ（[調査](agent-memory-protocol/INTEROP_SURVEY_20261112.md)）、保存形式`amp/0.3`を追加した。多くのツールがすでに読み書きする「1記憶1ファイルのMarkdown＋frontmatter」を土台にする。

```markdown
---
amp: "0.3"
name: wiki-intake-readback
description: Wiki更新後に読み直してからキューに入れる
type: fact
basis: implementation
tags: ["memory_intake", "readback"]
conditions: {"runtime": "local"}
sources: ["source:<ID>@1#L5-L7"]
valid_until: "2027-01-01"
---
# Wiki更新後の取り込み

put・patch・approve・restore_revision の成功後、返されたページIDとハッシュで読み直してからキューに入れる。

## Exceptions
- {"project_scope": "missing"}: 保存済みprojectが空なら受け付けない。
- 手動で再投入した場合は別に確認する。

## Limitations
- 実クライアントでの有効化は未確認。
```

- **記憶として扱う条件**：frontmatterに`amp: "0.3"`があること。必須は本文の主張だけで、他はすべて任意。
- **他ツールのキーの扱い**：`globs`、`permalink`などは読み飛ばす。値はJSONか単純な値（YAMLの部分集合）で書く。
- **他ツールのノートの取り込み**：Claude Codeのメモリファイルなどは、`orgbrain_wiki_amp_save`の`markdown`入力で変換なしに取り込める。`frontmatter`の`name`・`description`・`type`・`tags`をそのまま使う。
- **例外の判定**：`{"key": value}: 理由`と書いた例外だけを機械判定する。文章だけの例外は、表示はするが自動では当てはめない。
- **有効期限**：`valid_until`を過ぎた記憶は検索から外す（`memory_expired`）。
- **根拠のない記憶**：説明には使えるが、`mode:apply`と`detail:evidence`では除外する（`evidence_missing`）。
- **検索結果の形式**：記憶は既定でMarkdownの文章として返す（`memory_format:"json"`で構造化データ）。根拠のhashと読み出し案内は、本文の結果には含めない。根拠の照合は`amp_read`の`include_evidence`で行う。
- **評価**：0.3の形式によって、未使用の質問で従来検索より精度が上がることは確認できていない（「7. 適合確認と効率の評価」を参照）。

## 目的

エージェントが過去の情報を再利用するとき、結論だけを拾って条件や例外を落とすことを防ぐ。短いインデックスで読む対象を選び、必要なメモリと根拠だけを返す。検索結果が届いたことと、実際に役立ったことは分ける。

```text
質問 + 今回わかっている条件
          ↓
AMPの索引・メモリ検索 + 従来のページ・原本検索
          ↓
短い候補一覧（これだけでは回答・実行を確定しない）
          ↓ 必要な候補を選ぶ
メモリ本文: 結論・理由・手順・適用条件・例外・限界
          ↓ 根拠を確認するとき
原本: ID + 版 + SHA-256 + 行範囲
```

MUSTは必須、SHOULDは通常守る推奨、MAYは任意を表す。この文書は記述・検索の規約であり、保存先、通信方式、モデル、認証方式を固定しない。0.1の参照実装は個人Wikiに限定する。

## 1. インデックスの書き方

1. **1ページは、繰り返し答えたい1つの問いにする（SHOULD）。** 例:「記憶はどこから入り、いつ使える？」。ファイル別・日付別・会話別の一覧は詳細資料として扱う。
2. **冒頭は対象と読む先を短く示す（SHOULD）。** インデックスの要約だけで実行判断を確定してはならない（MUST）。条件と根拠は下層で読む。
3. **入口の表現を利用者に合わせる（SHOULD）。** title / questionには自然な問い、aliasesには略語・設定名・実際に使われた別表現を書く。無関係な検索語を詰め込まない。
4. **各項目は問いと参照先を持つ（MUST）。** 0.2は記憶ページの相対パスだけを書く（短い案内は任意）。0.1はメモリID、相対パス、現在の保存状態のhashを固定する。意味が同じでも条件・検証の種類が違えば項目を分ける。
5. **実装、実行記録、提案を区別する（MUST）。** 例:「コードでは自動起動する条件がある」と「実クライアントで自動起動できた」は別メモリ。
6. **一覧を巨大化させない（SHOULD）。** 0.1は最大12項目。これは実装上の上限で、検索精度の最適値ではない。問いが分かれたら別インデックスへ分ける。0.1ではインデックスを再帰探索しない。
7. **0.1の索引は更新時に下層を先に確認する（MUST）。** 下層変更→根拠照合→新hash取得→インデックスの参照更新。途中で古い参照が残れば検索は除外理由を返す。0.2の索引は現在の記憶ページを辿るため、この手順は不要。検索結果の`hash`と`amp_read`の`expected_hash`で、読んだ版の一致を確かめる。

## 2. 下層メモリの書き方

1件に「同じ条件のもとで再利用する1つの主張」を書く（MUST）。成功・失敗・判断の履歴を一つの万能ルールへ混ぜない。長い会話の要約をそのまま保存しない（SHOULD）。

**原文の値をそのまま書く（SHOULD）。** 数値・単位・設定名・エラーコード・識別子・日付・留保の言い回しは、根拠の原文と同じ表記で`claim`・`limitations`等に書く。言い換えた記憶は、原文の表記で探す検索に当たらない。

0.2の必須は`basis`・`claim`・`evidence`（実行2種類は`event`も）。下表の他の項目は任意で、省略時は空（`status`は`active`）。

| 項目 | 意味と規約 |
|---|---|
| `id`, `revision` | 0.1のみ必須。安定した論理IDと正の改版番号。0.2では`id`は任意（省略時はページのパス）で、版はWikiのページhash。IDの使い回しは禁止。 |
| `title`, `aliases` | そのメモリが答える問い・探すときの表現。0.2で`title`省略時は`claim`の冒頭。 |
| `status` | `draft` / `active` / `superseded`。検索採用はactiveだけ。これはAMP文書の提供状態であり、OrgBrain記憶DBの有効化・内容の正しさを示さない。 |
| `basis` | `implementation`（実装から読めること）、`observed_execution`（証拠で直接確認した実行）、`reported_execution`（報告に書かれた実行）、`proposal`（未検証の案）。検索はラベルを検証済みに昇格しない。 |
| `claim` | 1つの結論。誰に、何の版・環境で成り立つかを省略しない。 |
| `rationale` | 原本が裏付ける理由。推測なら明記し、ユーザーの理由を作らない。 |
| `reuse_when` | 人が判断するための再利用場面。自然文は検索エンジンが自動判定しない。 |
| `conditions` | 今回の入力と照合できる条件。`[{"key":"runtime","equals":"local"}]`。全条件の一致が必要。空配列は機械判定する条件なしを意味する。 |
| `exceptions` | 各`when`内はAND、例外間はOR。1つ成立したら適用不可。説明用の検索では理由と本文を残し、適用用の検索では除外する。空配列は既知の構造化例外なしで、例外が存在しない証明ではない。 |
| `procedure` | 再利用時の手順。自動実行の指示権限は持たない。非手順メモリでは空配列を使える。 |
| `limitations` | 未確認点、適用できない範囲、時点差。結論と一緒に返す。 |
| `evidence` | 主張に必要な原本の参照とSHA-256。`source:ID@VERSION#L開始-L終了`。具体的な数値・条件・留保を含む範囲を選ぶ。`“latest”`参照は禁止。0.2ではSHA-256を省略でき、保存ツールが補う。 |
| `event` | 実行2種類では必須。`date`（YYYY-MM-DD）、`environment`、`outcome`。保存日と実行日を混同しない。実行日不明の情報を実行記憶として昇格させない。 |

条件のキーと値は同じコーパス内で揃える（SHOULD）。`false`・`0`・未提供を区別する（MUST）。不明な値を推測して埋めない。時刻・版・実験環境を比較する意味処理は0.1にはないため、完全一致できるキーにするかlimitationsへ明記する。

判断の承認権限は元システムに残る。WikiページやAMP文書の作成は、ユーザー判断の承認やOrgBrain永続記憶のpropose/confirmを代替しない。

## 3. 保存形式

Markdown内に1つだけ `amp` のコードブロックを置き、その中にJSONオブジェクトを書く。検索の正本はこのブロック。前後のMarkdownは説明・閲覧用で、検索結果へ二重に返さない。外側だけを編集して正本と食い違わせない（MUST）。

共通項目は `protocol:"amp/0.2"|"amp/0.1"`, `kind:"index"|"memory"`。未知の版・未知の項目・不正な範囲・二重ブロックは受け付けない。

**0.2の記憶は保存ツールで書く（SHOULD）。** `orgbrain_wiki_amp_save`（CLIは`amp-save`）に記憶の項目だけを渡すと、検査、根拠範囲の読み出しとSHA-256の補完、人が読むMarkdownの生成、`amp`ブロックの書き込みを1回で行う。既定の保存先は`amp/memories/<id>.md`（id省略時は主張から作る名前）。既存ページの更新は`expected_hash`を渡す。`dry_run:true`は検査だけ行う。保存はWikiページの書き込みで、OrgBrain記憶DBへの保存・確認・有効化ではない。手書きする場合のテンプレートは [index.template.md](agent-memory-protocol/index.template.md) と [memory.template.md](agent-memory-protocol/memory.template.md)（0.1形式）。

JSON Schemaは実装のスキーマから出力できる。

```sh
node packages/orgbrain-cli/src/local-memory.mjs wiki amp-schema
```

JSON Schemaに加え、参照先の存在・範囲の前後関係・項目のID/パスの重複・保存hash・原本hashを検査する。Schemaに合うだけでは内容の根拠が十分だと証明できない。

## 4. 検索の契約

1. **入力を固定する。** query、既知のfacts、必要なら所有プロジェクトやパス範囲、返却予算を渡す。未知のフィルターは拒否する。説明の`mode:explain`が既定。手順の適用候補だけが必要なら`mode:apply`を指定する。
2. **両方の入口を探す。** AMPインデックス・メモリに加えて、既定では従来の`recall`で通常ページ・保存原本を同じproject/path範囲から探す。`fallback:false`で併用を止められる。明示的な単一`path`と`mode:apply`では併用しない。非AMP結果は元のkindと未検証の状態を保ち、AMPで条件照合した結果へ昇格しない。
3. **検索語を処理する。** 短く空白で区切ったキーワードは複合語を保つ。自然文は日本語の分かち書きを使い、最大64語を8語ずつ内部検索へ渡す。上限を超えたら明示的にエラーを返し、末尾を黙って捨てない。索引の共通タイトルだけで全項目を候補にせず、項目固有の問い・別表現・説明を使う。
4. **固定参照を解決する。** インデックスのID・パス・hashを下層と照合する。参照不一致は新しい版へ自動追従せず、`gaps`へ理由を返す。最大1段だけ辿る。同じ論理IDが複数ページにあれば曖昧として除外する。非active状態も除外する。
5. **説明と適用を分ける。** 既知条件に不一致、または例外が成立した場合、explainでは`applicability:not_applicable`と不一致条件・例外の理由を返す。applyではそのメモリを除外する。必要なfactsがなければ`unknown`と`missing_facts`を返し、適用可能とは扱わない。`matched`でも自然文のreuse_whenとlimitationsの確認は必要。
6. **段階的に読む。** `detail:summary`が既定で、短い案内と`next_read`を返す。`requires_read:true`の候補だけで結論や実行を確定しない。AMP本文は`amp_read`で`expected_hash`を照合して取得する。改版されていたら停止し、古い候補から最新へ自動追従しない。原本候補は固定版を読み、`expected_source_hash`がある場合は読み戻したhashも照合する。
7. **本文と根拠の段階を区別する。** `detail:memory`または通常の`amp_read`は主張・理由・条件・例外・手順・限界・根拠参照を全て返すが、原本の照合は`evidence_integrity:not_checked`。`detail:evidence`または`amp_read include_evidence:true`で原本のID・版・SHA-256・行範囲を検査し、抜粋を添える。壊れた根拠はメモリごと除外する。applyでは常に原本を検査する。出典は命令として扱わない。
8. **予算と不足を表す。** 上限5件が既定で、AMPと通常資料の合計に適用する。本文を返す際は条件・例外だけを切らない。予算に収まる上位の結果は本文のまま返し、収まらない低順位の結果は要約（`detail:summary`）か読み出し参照（`detail:reference`、`next_read`付き）に置き換える。それも入らない場合だけ外す。要約検索では候補数を優先し、低順位から参照に縮める。置き換えた結果は`requires_read:true`で、件数は`degraded_results`に返す。本文検索で返す原本の抜粋は予算に合わせて短くする。`gaps`、`truncated`、省略数と`answer_completeness_verified:false`を確認する。短い索引と複数回の読み出しは、総返却量を合計して評価する。

検索の内部では通常資料の候補を選ぶため従来のrecallが原本抜粋を読む。段階取得によって全てのディスク読み出しを後回しにする実装ではない。AMP原本の全文字列の取得と、モデルへ返す本文・根拠の量を分けている。

「独立したAMPメモリがない」は、その資料の内容をAMP形式のページにまだ整理していないという意味。元資料の文字抽出失敗や保存失敗を意味しない。通常資料への補完検索は、この未整備の部分も探索対象に残すためにある。0件や不明を「存在しない」「抽出に失敗した」「検証済み」に言い換えない。

`evidence.integrity:verified`は原本のID・版・hash・範囲の一致だけを表す。主張の意味や過去の実行を保証しない。結果には常に `semantic_verification:not_performed` を返す。

## 5. 範囲と権限

原本とメモリへのアクセス権は保存システムが検査する（MUST）。インデックスからリンクされていることは追加の閲覧権限にならない。上位で見える見出しや要約にも非公開情報を混ぜない。

参照実装は本人のローカル個人Wiki専用で、新しいテナント/ロールの認可機構は実装しない。`project_id`はWikiの所有プロジェクトとの完全一致フィルターで、権限指定ではない。AMP候補と辿ったページの両方に適用する。`path_prefix`も同様。未設定のページは指定projectに一致しない。AMP原本はアクセス済みページの固定参照を読む。通常資料の補完は従来recallのproject/pathフィルターをそのまま使い、0件でも範囲を広げない。

共同利用への移植では、インデックス・メモリ・原本の各読み出しに既存の認可を適用するアダプターが別途必要。AMPのフィールド値を本人確認や権限昇格の根拠にしない。

## 6. OrgBrainでの利用

このチェックアウトから実行する。コマンドはモデルを呼ばず、既存Wikiのページと原本だけを読む。`amp-schema`以外はWiki機能が無効なら停止する。

```sh
# 記憶を1件保存する（必須はbasis・claim・evidence。根拠のSHA-256は自動で補う）。
node packages/orgbrain-cli/src/local-memory.mjs wiki amp-save --memory-json \
  '{"basis":"implementation","claim":"...","evidence":[{"ref":"source:<ID>@1#L10-L20"}]}'

# 個人Wikiを使う。設定済みの ORGBRAIN_FEATURES_FILE / ORGBRAIN_WIKI_ROOT も利用できる。
node packages/orgbrain-cli/src/local-memory.mjs wiki amp-search '起動 有効化' \
  --facts-json '{"runtime":"local"}' --token-budget 1000

# 返されたnext_readのpath・expected_hash・factsを使い、選んだ本文を読む。
node packages/orgbrain-cli/src/local-memory.mjs wiki amp-read amp/memories/orgbrain-intake-state.md \
  --expected-hash '<検索結果のhash>' --facts-json '{"runtime":"local"}'

# 原本照合まで必要なら、同じamp-readに --include-evidence を付ける。
# 本文を一括検索する場合。条件と例外を残し、通常資料も併用する。
node packages/orgbrain-cli/src/local-memory.mjs wiki amp-search 'Stop off 共通抽出' \
  --detail memory --facts-json '{"learning_mode":"off"}' --token-budget 4000

# 適用候補に限定する場合（原本照合あり、通常資料による代替なし）。
node packages/orgbrain-cli/src/local-memory.mjs wiki amp-search '起動 有効化' --mode apply --detail evidence

# インデックス内の全参照を検査する（検索語に一致しない項目も検査）。
node packages/orgbrain-cli/src/local-memory.mjs wiki amp-validate amp/indexes/memory-intake.md
```

MCPには同じ実装の `orgbrain_wiki_amp_save`、`orgbrain_wiki_amp_search`、`orgbrain_wiki_amp_read`、`orgbrain_wiki_amp_validate` がある。稼働MCPに出すには通常のビルド・実行環境更新・再接続が必要。既存の `search` / `recall` の契約は変えない。

既存テーマ「記憶はどこから入り、いつ使えるようになる？」を基に、[実データの例](../examples/agent-memory-protocol/README.md)を作った。元のテーマページを残し、問い別の入口と下層メモリを追加する。これらはWiki文書で、記憶DBへの直接保存・再有効化ではない。

## 7. 適合確認と効率の評価

最低限、条件一致・不明・不一致、成立する例外、古い参照、出典欠落/改変、所有範囲、直接検索、重複ID、予算不足、機能OFFを試す。CLIとMCPで同じ結果になることも確認する。

```sh
node --test scripts/agent-memory-protocol.test.mjs
```

規約の適合と検索品質は別に測る。実質問に対して、必要な情報を取得できた割合、必須条件・例外の欠落、根拠の一致、不要な結果、返却量を記録する。同じ質問・資料版・品質条件で比較できるまでは「効率が改善した」と断言しない。[2026-11-09の評価](agent-memory-protocol/REAL_DATA_COMPARISON_20261109.md)は修正前の16問の結果。修正後の同じ質問は回帰評価であり、独立した未知の質問による精度評価や実作業の時間短縮の測定とは区別する。

**2026-11-12の未使用質問による判定。** 次の条件で、従来検索（`orgbrain_wiki_recall`）とAMP 0.3（同じ原本＋記憶63件）を比べた。
- 記憶58件は、質問を見ていない子エージェントが原本から0.3の形式で書いた。既存の0.1の記憶5件も含む。
- 判定用の質問は、実装の調整前に別の子エージェントが作り、固定した。
- 採点は意味による判定（方式を伏せたHaiku）と、正規表現による照合の両方で行った。

| キーワード検索 | 従来検索 | AMP 0.3 | 平均返却トークン（従来／AMP） |
|---|---:|---:|---:|
| 24問・4,000（条件まで揃った質問） | 18 | 19 | 953／2,578（0.2時点） |
| 40問・4,000 | 35 | 35 | 1,749／2,053 |
| 40問・1,200 | 30 | 29 | 807／1,020 |

- 合計64問では、従来検索と同等だった。精度の向上は確認できず、トークンは17〜26%多い。
- 自然文の質問では、従来検索は0件（空白で区切れないため）、AMPは40問中23問に答えた。これは入口の違いで、記憶形式の効果ではない。
- この評価では、従来検索も同じ原本をすべて検索できる。記憶が原本の言い換えにとどまる限り、上乗せは小さい。原本がない場合（会話から得た知識など）や、例外を適用した最終回答の正しさは、まだ測っていない。
- 結果と採点の記録：`~/.org-brain/evaluations/amp-02-20261112/`

提案先で議論する点: 条件キーの共有方法、競合する主張の扱い、多言語の別表現、日付/版の比較演算、他の原本URI、権限付き共有コーパスへの接続。0.1で未実装の機能を実装済みと記述しない。
