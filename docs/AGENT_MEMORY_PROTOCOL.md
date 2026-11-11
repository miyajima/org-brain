# Agent Memory Protocol (AMP) 0.1 — 提案草案

状態: OrgBrainで試せるローカル参照実装。外部で承認された標準や、他製品との互換性を意味しない。

2026-11-11: 文書形式は`amp/0.1`を維持し、検索の応答契約を`retrieval_version:0.2`へ更新した。既定は説明用の候補一覧。従来の原本検索を同じ範囲で併用し、本文と根拠を段階的に読む。既存の一括取得が必要なら`detail:evidence`、条件不一致を除外する用途なら`mode:apply`を明示する。

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
4. **各項目は問い・短い案内・固定された参照を持つ（MUST）。** メモリID、相対パス、現在の保存状態のhashを指定する。意味が同じでも条件・検証の種類が違えば項目を分ける。
5. **実装、実行記録、提案を区別する（MUST）。** 例:「コードでは自動起動する条件がある」と「実クライアントで自動起動できた」は別メモリ。
6. **一覧を巨大化させない（SHOULD）。** 0.1は最大12項目。これは実装上の上限で、検索精度の最適値ではない。問いが分かれたら別インデックスへ分ける。0.1ではインデックスを再帰探索しない。
7. **更新時は下層を先に確認する（MUST）。** 下層変更→根拠照合→新hash取得→インデックスの参照更新。途中で古い参照が残れば検索は除外理由を返す。

## 2. 下層メモリの書き方

1件に「同じ条件のもとで再利用する1つの主張」を書く（MUST）。成功・失敗・判断の履歴を一つの万能ルールへ混ぜない。長い会話の要約をそのまま保存しない（SHOULD）。

| 項目 | 意味と規約 |
|---|---|
| `id`, `revision` | 安定した論理IDと正の改版番号。主張や条件を変更したら番号を増やす。IDの使い回しは禁止。検索では番号だけでなく保存hashも照合する。 |
| `title`, `aliases` | そのメモリが答える問い・探すときの表現。 |
| `status` | `draft` / `active` / `superseded`。検索採用はactiveだけ。これはAMP文書の提供状態であり、OrgBrain記憶DBの有効化・内容の正しさを示さない。 |
| `basis` | `implementation`（実装から読めること）、`observed_execution`（証拠で直接確認した実行）、`reported_execution`（報告に書かれた実行）、`proposal`（未検証の案）。検索はラベルを検証済みに昇格しない。 |
| `claim` | 1つの結論。誰に、何の版・環境で成り立つかを省略しない。 |
| `rationale` | 原本が裏付ける理由。推測なら明記し、ユーザーの理由を作らない。 |
| `reuse_when` | 人が判断するための再利用場面。自然文は検索エンジンが自動判定しない。 |
| `conditions` | 今回の入力と照合できる条件。`[{"key":"runtime","equals":"local"}]`。全条件の一致が必要。空配列は機械判定する条件なしを意味する。 |
| `exceptions` | 各`when`内はAND、例外間はOR。1つ成立したら適用不可。説明用の検索では理由と本文を残し、適用用の検索では除外する。空配列は既知の構造化例外なしで、例外が存在しない証明ではない。 |
| `procedure` | 再利用時の手順。自動実行の指示権限は持たない。非手順メモリでは空配列を使える。 |
| `limitations` | 未確認点、適用できない範囲、時点差。結論と一緒に返す。 |
| `evidence` | 主張に必要な原本の参照とSHA-256。`source:ID@VERSION#L開始-L終了`。具体的な数値・条件・留保を含む範囲を選ぶ。`“latest”`参照は禁止。 |
| `event` | 実行2種類では必須。`date`（YYYY-MM-DD）、`environment`、`outcome`。保存日と実行日を混同しない。実行日不明の情報を実行記憶として昇格させない。 |

条件のキーと値は同じコーパス内で揃える（SHOULD）。`false`・`0`・未提供を区別する（MUST）。不明な値を推測して埋めない。時刻・版・実験環境を比較する意味処理は0.1にはないため、完全一致できるキーにするかlimitationsへ明記する。

判断の承認権限は元システムに残る。WikiページやAMP文書の作成は、ユーザー判断の承認やOrgBrain永続記憶のpropose/confirmを代替しない。

## 3. 保存形式

Markdown内に1つだけ `amp` のコードブロックを置き、その中にJSONオブジェクトを書く。検索の正本はこのブロック。前後のMarkdownは説明・閲覧用で、検索結果へ二重に返さない。外側だけを編集して正本と食い違わせない（MUST）。

共通項目は `protocol:"amp/0.1"`, `kind:"index"|"memory"`, `id`, `revision`, `title`, `aliases`。未知の版・未知の項目・不正な範囲・二重ブロックは受け付けない。テンプレートは [index.template.md](agent-memory-protocol/index.template.md) と [memory.template.md](agent-memory-protocol/memory.template.md) を使う。

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
8. **予算と不足を表す。** 上限5件が既定で、AMPと通常資料の合計に適用する。本文を返す際は条件・例外だけを切らず、予算を超えたら低順位の結果を丸ごと外す。`gaps`、`truncated`、省略数と`answer_completeness_verified:false`を確認する。短い索引と複数回の読み出しは、総返却量を合計して評価する。

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

MCPには同じ実装の `orgbrain_wiki_amp_search`、`orgbrain_wiki_amp_read`、`orgbrain_wiki_amp_validate` がある。稼働MCPに出すには通常のビルド・実行環境更新・再接続が必要。既存の `search` / `recall` の契約は変えない。

既存テーマ「記憶はどこから入り、いつ使えるようになる？」を基に、[実データの例](../examples/agent-memory-protocol/README.md)を作った。元のテーマページを残し、問い別の入口と下層メモリを追加する。これらはWiki文書で、記憶DBへの直接保存・再有効化ではない。

## 7. 適合確認と効率の評価

最低限、条件一致・不明・不一致、成立する例外、古い参照、出典欠落/改変、所有範囲、直接検索、重複ID、予算不足、機能OFFを試す。CLIとMCPで同じ結果になることも確認する。

```sh
node --test scripts/agent-memory-protocol.test.mjs
```

規約の適合と検索品質は別に測る。実質問に対して、必要な情報を取得できた割合、必須条件・例外の欠落、根拠の一致、不要な結果、返却量を記録する。同じ質問・資料版・品質条件で比較できるまでは「効率が改善した」と断言しない。[2026-11-09の評価](agent-memory-protocol/REAL_DATA_COMPARISON_20261109.md)は修正前の16問の結果。修正後の同じ質問は回帰評価であり、独立した未知の質問による精度評価や実作業の時間短縮の測定とは区別する。

提案先で議論する点: 条件キーの共有方法、競合する主張の扱い、多言語の別表現、日付/版の比較演算、他の原本URI、権限付き共有コーパスへの接続。0.1で未実装の機能を実装済みと記述しない。
