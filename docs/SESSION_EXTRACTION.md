# セッションの共通再抽出

Claude / Cursor / Codex の Stop フックは、完了したターンを非公開のローカルキューへ渡す。フック内ではモデルを呼ばない。別プロセスの共通ワーカーが OpenRouter API を呼ぶため、Claude / Cursor だけの利用者も Codex CLI をインストールする必要はない。

## 設定と実行

既存の非公開 `~/.config/org-brain/hooks.env` に次を設定する。APIキーの値は既存設定を使い、リポジトリに書かない。

```dotenv
ORGBRAIN_LOCAL_HOOK_CAPTURE=true
ORGBRAIN_SESSION_EXTRACTION_MODE=on
# Stop後に別プロセスのワーカーを起動する（既定はfalse）
ORGBRAIN_SESSION_EXTRACTION_AUTORUN=true
ORGBRAIN_SESSION_EXTRACTION_PROJECTS=org-brain,consentside,socia,sfk-shinsa,jrg,factoreview,smart-block,tsugi,AIma
# OPENROUTER_API_KEY: 既存の秘密設定
# 必要なときだけ、取り込まない評価セッションのIDをカンマ区切りで指定
# ORGBRAIN_SESSION_EXTRACTION_EXCLUDE_SESSIONS=...
```

ワークスペースと project_id の既存マッピングも必要。allowlist のないプロジェクト、confirm モードの対話、無効なローカルフックは自動キュー投入しない。明示的な env ファイルを選択した場合、その先頭ファイルをモードと対象の境界として扱う。

```sh
orgbrain connector setup claude --mode extraction-hooks --scope user --execute --approve-hooks
orgbrain connector setup cursor --mode extraction-hooks --scope user --execute --approve-hooks
orgbrain memory extraction status --project-id org-brain
orgbrain memory extraction status --project-id org-brain --worker
orgbrain memory extraction run --project-id org-brain --execute
orgbrain memory extraction run --all-projects --execute
```

`extraction-hooks` は Stop ハンドラだけを設定し、既存の MCP、別用途のフック、認証情報、保存先の設定を保つ。バックアップを作る。Cursor のユーザーフックには対応バージョンが必要。クライアントの再起動・フックの信頼確認はクライアント側で行う。

手動の再取り込みも同じワーカーを使う。

```sh
orgbrain memory extraction enqueue --client claude --input /path/to/transcript.jsonl --workspace /path/to/project --project-id org-brain --execute
orgbrain memory extraction run --project-id org-brain --execute
```

`--client` は `codex` / `claude` / `cursor`。Claude の JSONL、Cursor の role/message JSONL またはその配列を読み、最新の完了ターンを選ぶ。Cursor の手動取り込みは操作者が完了した記録を指定する。Stop で transcript_path を受け取れない場合は、回答だけから全文を推測せず `complete_turn_unavailable` とする。Claudeでは実際の `user` / `assistant` レコードだけを読む。診断用の `api-request-blob`、思考ブロック・子エージェントの履歴は取り込まない。Claude の通常ツール結果は呼び出しIDとともに取り込み、成功の実測値がない結果を検証済みにはしない。`is_error` や失敗状態は、本文に終了コード0が含まれていても成功より優先する。

Cursorの通常Stopは単一の `workspace_roots` から対象を解決する。複数の異なるルートがある場合、明示的な作業場所なしにプロジェクトを推測しない。

## 稼働場所とタイミング

`ORGBRAIN_SESSION_EXTRACTION_AUTORUN=true` のとき、通常Stopがキュー投入を終えた後、同じNode.jsと導入済みCLIで別プロセスのワーカーを起動する。Stopは起動までを待ち、モデル応答は待たない。モードon・対象allowlist・ローカルフック有効が必要で、confirmモードや除外セッションからは起動しない。明示したhooks.envに自動起動設定が無ければ、親プロセスの値を継承して有効にはしない。

ワーカーはキュー・テナント・プロジェクト単位で排他し、手動実行やautonomyとも競合させない。1プロセス20ジョブまで処理し、終了時に排他解除と未処理確認を同じトランザクションで行う。残りがあれば後続を起動するため、終了直前のStopも取りこぼさない。重複Stopも、まだpendingの入力がある場合は起動を試みる。生存する所有プロセスを時間だけで追い出さず、死んだ所有者の排他だけ回収する。異常終了したrunningジョブは再送しない。

API失敗・予算切れ・ワーカー例外時は連続起動を止める。キュー投入、子プロセス起動、API成功、候補保存は別状態で、`status --worker` で実行中か、最終終了状態・処理数・保存数を確認する。起動失敗では元のpendingを保持し、次のStopまたは明示的な実行で処理できる。自動起動を止める場合はAUTORUNをfalseへ戻す（既に送信したAPI呼び出しを取消す設定ではない）。

ワーカーはローカル Node.js で動く。Cloudflare のジョブ、Claude/Codex の生成CLIは使わない。既存の `autonomy run --execute` も、上のモードが on のときに allowlist 内のキューを処理する。workspace のメンテナンスとは別の再抽出キューで、対象外のプロジェクトは処理しない。1回の処理上限は全対象合計20ジョブ。

このMacの既存 LaunchAgent は毎日03:17のローカル時刻にそのコマンドを呼ぶ。AUTORUNを有効にしたStop後の処理は、この予定時刻を待たない。LaunchAgent設定の存在は、その時刻の実行・常時稼働の証明ではない。Macやクライアントが停止している時間の即時処理も保証しない。

## モデル・予算・保存

- 共通経路: `anthropic/claude-haiku-5.5`、`reasoning.effort=medium`。提供先は確認済みの `google-vertex/global` に固定し、ZDR、データ収集拒否、別提供先へのフォールバック禁止を付ける。無料モデルではない。
- 既存のCodex比較・抽出ランナー v1.1 / v1.2: `gpt-6-luna` / `medium`。共通抽出ワーカーとは別。
- 1呼び出し: 入力はJSONスキーマ等を含むUTF-8バイト数の保守的上限2000、出力800トークン、候補最大3件。1ターン最大32呼び出し、1テナントの月間合計500,000トークン。上限はトークナイザーの実測値と混同しない。
- 理由・例外など関連する文をまとめて渡す。文の途中を切らない。収まらないまとまりは、本文を追加保存せずハッシュ・理由・文数を `input_holds` に記録し、`memory extraction status` で確認できる。耐久性の通常判定も残すため、すべての発言・テスト記録を記憶に変換する機能ではない。
- 出力は本文を繰り返させず、入力の文番号を選択させる。通常の共有検証器が原文への参照、理由・条件の保持、非空本文、成功ツールの同一呼び出しを確認する。
- assistantの検証報告は本文の `reported_verification` に保存し、状態は `unverified`。同じ呼び出しの成功ツール結果がない `observed_outcome` / `verified_outcome` は受理しない。
- 保存時の安全処理で本文が変わる候補は保留にする。自動生成した不透明なIDは電話番号と誤認して伏字にしない。
- 候補は既存の `memory_learning_candidates` の `quarantine` へ保存し、この経路では active 記憶にしない。`automatic_promotion=false` を既存の自律メンテナンスも尊重する。
- キューは既定で `~/.org-brain/session-extraction/queue.sqlite`。送信前に永続的にジョブを確保する。同一入力の再通知は重複投入せず、実行中・不明・保留を自動再送しない。ワーカー/契約の版が変わった未処理ジョブも保留にし、別の版として黙って送り直さない。

## 確認結果

[2026-10-19の実データ比較](../artifacts/shared-extraction-20261019/Report.md)に、固定入力、API実行、保存後の本文、未保持と未検証の範囲を記録した。過去のQwen比較は別の歴史的結果として保持する。

[実クライアントのStopから保存までの確認](../artifacts/shared-extraction-20261019/NativeClientVerification.md)では、CursorとClaude Codeの実セッション、通常キュー、Sonnet抽出、保存後の本文を段階別に確認した。

[Stop後の自動起動確認](../artifacts/shared-extraction-20261019/AutoStopVerification.md)では、手動ワーカーなしでClaude 6ジョブ・5候補、Cursor 3ジョブ・2候補の自動抽出・保存を確認した。全7候補で保存前後の意味本文が一致した。Cursorの送信操作は利用者が行い、モデル抽出は両クライアントとも別プロセスで自動実行した。

これらの実データ・実Stopの測定は切替前のSonnet 5.5 / lowによる結果。2026-10-19の利用者指定で、以後の共通抽出をHaiku 5.5 / medium、既存CodexランナーをLuna / mediumに変更した。過去の測定結果を新モデルの品質証明には使わない。
