# Codex／Claude Codeの再調査削減：事前検証と効果試算

2026-09-11。判定は「小規模な実エージェント比較に進む価値はある。ただし、現状の応答をそのまま作業コンテキストとして配る導入は見送る」。実エージェントでの時間・総トークン削減、同品質の維持は **inconclusive（未測定）**。

既存の検索・出典・ACLを使う方向は妥当だった。先に必要なのは、返却全体の量を制限すること、無関係な候補を使わないこと、古い結果の適用条件を確認することである。検索エンジンの作り直しやDBのミリ秒最適化を先行させる根拠は得られていない。

今回の作業は、引き継ぎとコードの読み取り、公式仕様の確認、新しい合成入力によるローカル診断、仮定に基づく試算に限定した。既存の測定を再実行・上書きせず、保存ブランチ・本番コード・ユーザーDB・クライアント設定を変更していない。実験用のモデル呼び出し、ライブOrgBrain API呼び出しは0回。STDIO/HTTPの実接続や認証は未検証。

確認した保存地点は次のとおり。

| 対象 | 今回確認した状態 |
| --- | --- |
| 現在の作業ツリー | `/Users/miyajimakazuhiro/.codex/worktrees/5d51/org-brain`、開始時は変更なし・detached HEAD |
| 現在のHEAD | `a616d2ab08afb6671d5878dcaffd77bc81e5dc22` |
| 保全作業ツリー | `/Users/miyajimakazuhiro/projects/localoud/.worktrees/orgbrain-inference-accelerator-pr1`、変更なし |
| 保全ブランチ／HEAD | `codex/orgbrain-inference-accelerator-pr4`／`006af0ae3f7360f6a709cebb30aa43515d5450cc` |
| ローカルCLI | Codex `0.153.4`、Claude Code `2.1.226`、Node `22.23.2`、RTK `0.48.0` |

引き継ぎ自体も「実エージェント比較は未実施」と明示している。[セッション引き継ぎ](/Users/miyajimakazuhiro/projects/localoud/.worktrees/orgbrain-inference-accelerator-pr1/docs/SESSION_HANDOFF_2026-09-11.md)と[実験提案](/Users/miyajimakazuhiro/projects/localoud/.worktrees/orgbrain-inference-accelerator-pr1/docs/AGENT_TASK_ACCELERATION_HANDOFF.md)を読んだ。single_recordやローカル推論の旧測定は、今回の効果推定に流用していない。

## ローカルで確認できたこと

保全作業ツリーの既存 `LocalMemoryStore` と `handleLocalMcpRequest` を直接呼んだ。ネットワーク生成モデル・dense embedding・Context Drafterを使わず、新規の一時SQLiteに合成記録25件を用意し、自然文5入力を各1回処理した。正解IDを検索入力に渡していない。終わった一時DBだけを削除し、入力・応答・ソースハッシュ・観測値を新しい結果ディレクトリに保存した。

共通指定は `top_k: 3`、`token_budget: 1200`、`search_mode: hybrid_v4`、明示したテナント・プロジェクト・principal。ログを長くした例は応答上限の診断用で、実運用の頻度や検索品質を推定する標本ではない。ノード内のMCPハンドラーを検証したもので、MCP通信の往復時間ではない。

| 新しい合成入力 | 検索結果／抜粋件数 | サーバーのestimated_tokens | 応答全体のUTF-8 bytes | 応答本文のo200k_baseトークン数 |
| --- | ---: | ---: | ---: | ---: |
| 短い過去判断がある修正 | 1／1 | 21 | 6,384 | 1,752 |
| 関連する長いログが20件ある修正 | 20／2 | 1,200 | 275,358 | 88,043 |
| 同じDBに無関係なフォント実装の相談 | 20／2 | 1,200 | 275,395 | 87,985 |
| 公開・権限制限・期限切れ記録の混在 | 1／1 | 7 | 5,833 | 1,623 |
| コード・Node・設定が変わった相談 | 1／1 | 20 | 7,448 | 2,064 |

最終列は `js-tiktoken 1.0.21 / o200k_base` で実際に文字列を符号化した数であり、**Codex／Claude Codeが受け取ったトークン数・課金usageではない**。クライアントによる切り詰め、ツール定義・会話履歴・推論の量は含まない。実モデルusageはunknown。応答サイズの問題を示すための診断値である。

入力と生の応答は [run-001](/Users/miyajimakazuhiro/.codex/worktrees/5d51/org-brain/artifacts/analysis/2026-09-11/agent-task-acceleration/run-001/observations.json)、再現用コードは [offline-probe.mjs](/Users/miyajimakazuhiro/.codex/worktrees/5d51/org-brain/artifacts/analysis/2026-09-11/agent-task-acceleration/offline-probe.mjs)。スクリプトは既存の結果ディレクトリを拒否する。

### 1. token_budgetは返却全体の上限になっていない

ローカルでは検索の既定limitが50のまま、`top_k`が絞るのは抜粋対象だけである。結果全件の `memory.content`、メタデータ、抜粋、current_stateなどが同じ返却値に入る。長文例では本文抜粋だけでもo200k_baseで3,813、evidence_bundle全体で16,987、応答全体で88,043だった。

本文予算が `token_budget * 4` 文字、表示値が `ceil(文字数 / 4)` なので、日本語を含む今回の入力でも実際の符号化数と一致しない。`evidence_bundle`だけを取り出しても十分に小さくなるとは限らず、`current_state`や`previous_values`も対象にする必要がある。

Remote APIにも、文字数で数える抜粋予算とは別に検索結果と補助情報を返す構造がある。ただし上表の数値はローカル経路の結果であり、Remote APIの応答サイズを測ったものではない。[ローカルの通常経路](/Users/miyajimakazuhiro/.codex/worktrees/5d51/org-brain/packages/orgbrain-cli/src/lib/local-memory-store.mjs:5475)、[APIの組み立て](/Users/miyajimakazuhiro/.codex/worktrees/5d51/org-brain/apps/api-gateway/src/memory-context-service.ts:192)。

### 2. 候補があることと、そのタスクに役立つことは別

DB接続の記録しか入っていないプロジェクトに、OpenTypeフォントの合字描画を相談しても20件返った。上位候補のlexicalは0で、結果は `degraded`、`missing_evidence: []`、`abstention_recommended: false`だった。これは今回のローカル構成における反例で、Remoteの誤採用率や本番全体の精度を示す値ではない。

現在のdispositionは件数・複数出典・競合・抽出状態などを見るが、返却された根拠と依頼の意味的な一致をそれだけで保証しない。件数があれば再利用可能とする接続は避ける。検索スコアの固定しきい値をこの1例だけで決めることも適切ではない。[判定処理](/Users/miyajimakazuhiro/.codex/worktrees/5d51/org-brain/packages/shared/src/evidence-disposition.mjs:19)。

### 3. 鮮度・条件はエージェント側でも確認が必要

明示principalを指定した今回の例では、権限外と `valid_until`期限切れのレコードは返らなかった。これは限定した1例の確認で、ACLの網羅検証やRemote認証の検証ではない。ローカルの通常経路はprincipal省略時に所有者側の読み取りを許す実装なので、実験ではprincipalを明示する。

一方、旧コード・Node 22・設定Aで成功した記録は、現在がNode 24・設定Bという相談でも候補として返った。候補提示は正当だが、現在も成功している証明には使えない。参照先が現在読めるか、作業ファイルの内容が一致するかの検証も、このretrieve_context自体では行っていない。メモリの `content_hash` は作業リポジトリのファイルハッシュではない。

### 4. 既存項目の利用と接続差の吸収で始められる

| 必要な情報 | 既存項目・今回の確認 | 最小の扱い |
| --- | --- | --- |
| 過去の判断と理由 | ローカルresultsのcontent、summary、rationale | 選択した根拠に対応する短い部分だけを使う |
| 適用条件 | reuse_rule、valid_from／valid_until、出典日時 | 抜粋時に落とさず、現在のファイル・環境と照合する |
| 関連ファイル／シンボル | source_reference、本文中の記載 | 記録にある範囲だけを返す。専用の検証済みシンボル表があるとは扱わない |
| 試行済みの方法 | 本文・理由・過去値に含まれ得る | 記録がなければunknown。大量のprevious_valuesを常時添付しない |
| 出典／不足／矛盾 | source_reference、source_span、missing_evidence、conflicts、degraded_reasons | 欠落時は追加取得・現行コード確認へ進む |

ローカルMCPの名前は `orgbrain_memory_retrieve_context`、入力は `query`。Remoteの登録名は **`orgbrain_memories_retrieve_context`**、入力は **`q`**。ローカルMCPの既定search_modeもストアの既定と異なるので、比較では `hybrid_v4`を明示する。[ローカル契約](/Users/miyajimakazuhiro/.codex/worktrees/5d51/org-brain/packages/orgbrain-cli/src/local-mcp.mjs:260)、[Remote契約](/Users/miyajimakazuhiro/.codex/worktrees/5d51/org-brain/apps/api-gateway/src/mcp.ts:1011)。実際に公開されているRemoteツール一覧・接続可否は未確認であり、別経路へ暗黙に切り替えていない。

また既存 `answer_guidance.instructions` は組織QA向けの回答形式を含む。コード修正時には参考情報として扱い、現在の依頼、現行コードからの根拠収集、ツール実行権限を制約する上位指示にしない。保存方法は [既存キャプチャ契約](/Users/miyajimakazuhiro/.codex/worktrees/5d51/org-brain/docs/MEMORY_CAPTURE_HARNESS_COMPATIBILITY.md)を維持する。

## 効果の試算

実測された短縮率はまだない。下記は、返却全体を小さく抑え、無関係な記憶を採用しない接続を用意できた場合の**仮定による感度分析**である。現在の大量応答をそのまま入れた構成には適用しない。実験用合成データの検索時間や文字数から、タスク短縮率を外挿していない。

計算は、時間と総トークンそれぞれについて次式を使う。

`改善率 = 通常構成に残る再調査の割合 × そのうち省ける割合 − 追加負担の割合`

追加負担には検索、追加のエージェント往復、原本確認、誤採用による手戻り、キャッシュ損失、準備・保存の配賦を含む。ベースラインの既存メモリ・スキル・RTK・通常キャッシュで既に省けている部分は含めない。

| 課題 | 時間の仮定：再調査割合×省略割合−追加負担 | 時間改善 | 総トークンの仮定 | 総トークン改善 |
| --- | --- | ---: | --- | ---: |
| 過去知識の適用条件が合う修正 | 35% × 55% − 5% | 14.25% | 45% × 60% − 5% | 22% |
| コードや環境条件が変わった修正 | 22% × 20% − 6% | −1.6% | 30% × 25% − 6% | 1.5% |
| 役立つ記憶がない新規課題 | 0% − 2.5% | −2.5% | 0% − 4% | −4% |

上から50%・30%・20%という**仮のベースライン費用配分**なら、中心試算は **時間6.15%・総トークン10.65%の改善**。仮に同じ時間・トークンのタスクなら課題件数の配分にも一致するが、実際には時間とトークンの重みを別々に集計する必要がある。

仮定の幅を広げると、混在作業で **時間は2.25%悪化〜15.75%改善、総トークンは3%増加〜22.5%減少**となった。これは信頼区間でも、予測確率を伴う範囲でもない。条件が合う修正だけなら今回の仮定幅は時間2〜28.5%、総トークン2〜39%改善であり、効果の偏りが大きい。[仮定と計算結果](/Users/miyajimakazuhiro/.codex/worktrees/5d51/org-brain/artifacts/analysis/2026-09-11/agent-task-acceleration/estimate.json)、[計算コード](/Users/miyajimakazuhiro/.codex/worktrees/5d51/org-brain/artifacts/analysis/2026-09-11/agent-task-acceleration/estimate.mjs)。

損益分岐も明確である。追加負担が5%、再調査を半分省けるなら、もともとの再調査がタスクの10%を超えていなければ改善しない。20分のタスクで追加30秒かかるなら、調査・推論の往復を30秒より多く削る必要がある。これはテスト実行そのものが支配的な課題には効きにくい理由でもある。

短いコンテキストを足しただけで、呼び出し回数や調査内容が変わらなければ入力は増える。例えば1,200トークンの追加が後続8リクエストに残れば、追加入力は概算9,600トークンになる。キャッシュされても総入力トークンには含まれ、時間・金額への影響は別になる。この数字も例示であり今回のusageではない。

実装準備の回収も別に考える。例えば導入準備が仮に2時間、1課題の純短縮が1.2分なら、準備費だけで約100課題が損益分岐になる。2時間は工数見積もりではない。初期導入費、各試行の準備費、継続時の保存費を分けて報告し、少数の初回試行だけで全費用を回収したとしない。

## 現行クライアントでの計測と比較条件

CodexはSTDIOとStreamable HTTPのMCP接続に対応する。通常設定を保った `codex exec --json` で、MCP呼び出しを含むイベントと、`turn.completed.usage`の入力・キャッシュ・出力・推論内訳を取得できる仕様を確認した。ただし、実際のCLI出力との照合は未実施であり、turn数やツール数をモデルAPIリクエスト数として数えてはいけない。[公式MCP仕様](https://learn.chatgpt.com/docs/extend/mcp)、[非対話実行仕様](https://learn.chatgpt.com/docs/non-interactive-mode)。

Claude Codeは構造化出力に加え、OpenTelemetryの `claude_code.api_request` でリクエスト時間、入出力、cache read／creation、query_sourceなどを取得できる仕様がある。補助処理・compactionなどを集計から除かない。失敗時の内部リトライが全件別イベントになるとは限らず、取得不能な試行やusageはunknownとする。ログ出力先の追加設定も今回はしていない。[プログラム実行](https://code.claude.com/docs/en/headless)、[使用量計測](https://code.claude.com/docs/en/monitoring-usage)。

集計時はAPIごとの意味を正規化する。OpenAIのcached inputやreasoning outputを、既にそれを含むinput／outputの合計へ二重加算しない。Anthropicでは入力の通常分・cache read・cache creationを別フィールドから合算する契約を使用前に確認する。同じrequestの途中フレームと最終usage、累積turn usageを重ねて足さない。課金換算や購読枠の削減率はこの試算では扱わない。

両社のキャッシュは共有するprefixの再利用が基本だが、クライアントが送る内容に依存する。Claude Codeの現行仕様では、遅延ロードされたMCPツールは追加コンテンツになり既存キャッシュを維持する場合があり、「MCPをつなぐと必ずキャッシュが失われる」という理解も誤り。履歴を毎回書き換えず、短い固定手順と追加のツール結果で構成し、実際のcache usageを観測する。[OpenAI入力キャッシュ](https://developers.openai.com/api/docs/guides/prompt-caching)、[Claude Code入力キャッシュ](https://code.claude.com/docs/en/prompt-caching)。

次の比較は、まず以下の小ささで足りる。

1. 本文だけでなく返却JSON全体を制限し、選択された根拠の理由・適用条件・出典・不足を残す。既存retrieve_contextの選択・検証を使い、検索時の生成LLMは追加しない。RTKへの二重投入で無理に小さくする方式は使わない。
2. 自然文の実課題を「過去知識が合う修正」「条件が変わった修正」「役立つ記憶がない課題」から2件ずつ固定する。今回診断した予算不具合・合成fixtureを、実作業の効果を証明する課題に使わない。対象6件の具体的な依頼・開始コミット・独立した受け入れ条件はライブ開始前に確定する。
3. 通常／作業コンテキスト利用を各1回、CodexとClaude Codeのそれぞれで行う。**6課題 × 2条件 × 2クライアント = 24タスク試行**。これは24モデルAPI呼び出しという意味ではない。利用アカウント、モデルと推論設定、1試行の時間・リクエスト数・入出力上限、合計予算、上限を守る計測方法が未確定なので、現時点では実行しない。
4. 通常構成のメモリ、スキル、RTK、MCP、権限を記録して維持する。ベースラインでOrgBrainが既に使われるなら禁止せず、その利用も記録する。両条件の差分には追加手順・ツール定義・起動時間を含める。
5. 原本・記憶は評価の回答を含まない時点で固定する。A/Bの出力・解答・保存候補が他方へ流れないようにし、既存キャプチャの承認を勝手に行わない。共有メモリの自動更新を隔離できなければ、そのペアの比較を開始しない。
6. 各クライアント内でAB／BAを3課題ずつに割り当てる。各試行は同じ開始ファイルと権限に戻し、順序、providerのcache read／write、ウォームアップ費を残す。新規セッションをcoldの証明にしない。cold／warmを制御・確認できない場合はunknownとして、確認できた条件内でだけ比較する。
7. 時間は準備・検索・実装・必要な検証・失敗・再試行を含む。期限内に受け入れ条件を満たさない試行を「高速」と数えず、完了率と打ち切りを別に記録する。再調査は既に得た同じ事実を新しい理由なく再取得した回数、手戻りは誤った変更・仮定を訂正した回数として原本イベントに紐付ける。鮮度確認に必要な再読は再調査の無駄に含めない。

24試行は構成の有効性と失敗様式を調べる小さなpilotである。各クライアント6ペアなので、一般的な改善率や品質の非劣性を確定するには不足する。例えば対差の標準偏差25%、検出したい改善15%、両側5%・検出力80%という仮定の正規近似でも約22独立ペア／クライアントが必要になる。実際の分散、課題の相関、失敗率をpilotで見て次の規模を決める。

導入の仮の目安は、受け入れ品質を維持したうえで、混在課題の全費用込み時間が約10%以上改善し、総トークンも減ること。新規課題の遅延は別に示す。無関係な記録の採用、適用条件を欠く短縮、期限切れ・権限外の根拠利用、計測欠落が確認されたら採用を止め、その原因だけを直して別の試行として記録する。小標本の平均だけで一般導入は決めない。

今回の検証から優先するのは **返却全体の量 → 関連性と適用条件 → 実タスク比較** の順である。新しい検索エンジン、保存機構、KV操作、モデル置き換えを先に入れる根拠はない。
