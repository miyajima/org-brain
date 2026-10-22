# Wiki更新後の記憶処理

OrgBrainの個人Wikiでは、記憶パイプラインを有効にしたtenant/projectの更新だけを処理する。設定は `orgbrain pipeline configure`、処理結果の確認は `orgbrain pipeline status` を使う。

ネイティブMCPの `put`、`patch`、`approve`、`restore_revision` が成功したら、返されたページIDとハッシュを使って保存済みページを読み直す。ページID・ハッシュ・保存済みprojectの一致を確認してから候補をキューへ入れる。呼び出し側がprojectを省略しても、保存済みの範囲を使う。範囲やハッシュが一致しなければ処理を保留する。

新しいキュー行が作られたときだけ、独立したワーカーを直ちに起動する。更新を受けたMCPプロセス自体では抽出・審査のモデルを呼ばない。ワーカーに必要なキーが環境にない場合は、既存の許可済み設定の読み込みを遅延実行する。重複や無効な取り込みでは起動しない。

応答の `memory_intake.queued` は受付、`memory_intake.worker.started` は起動要求の結果を表す。有効化済みという意味ではない。起動できなくてもキューIDを残し、安全な理由だけを返す。最終的な有効化・棄却・保留は `pipeline status` で確認する。保留や結果不明のモデル呼び出しを自動で再試行しない。

原本は `packages/orgbrain-cli/src/lib/wiki-mcp.mjs` と `packages/orgbrain-cli/src/lib/memory-pipeline.mjs`。`scripts/wiki-memory-pipeline-intake.test.mjs` は、読み直し後の正しい範囲での受付と起動、重複・無効・不一致の場合の不起動、起動失敗時のキュー維持を検証する。実際の有効化確認では、MCP受付の後に手動でワーカーを起動せず、保存済みのrunとmemoryを読み取る。
