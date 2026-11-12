# 他のメモリ層との形式比較（2026-11-12）

AMP 0.3 の形式を決めるために、既存のメモリ層ツールとエージェント用ファイル規約の公開資料を調べた。2026-11-12 に公式文書・README・ソースを確認した。宣伝目的の評価値は各社の自己申告で、ツール間で比較できない。未確認の点は末尾にまとめた。

## 結論

- **誰でもすでに読める形は「1記憶1ファイルの Markdown＋YAML frontmatter」。** 次のツールが読める。
  - Claude Code の自動メモリ（`type`、`MEMORY.md` の1行索引）と `.claude/rules`
  - Cursor rules（`description`、`globs`）
  - Basic Memory（`title`、`type`、`tags`）
  - Obsidian の Properties
  - MIF と gbrain
  - AGENTS.md（形式の指定はないが、約20のツールが読む）
- **API 型のメモリ層に共通する項目は少ない。** 本文、安定した ID、スコープ（user・agent・session・namespace）、自由なメタデータ、作成・更新日時、タグにとどまる。
- **再利用の正しさに効く項目は、一部のツールにしかない。**
  - 有効期間：Graphiti/Zep の `valid_at`/`invalid_at`、Mnemosyne の `valid_until`
  - 根拠の参照：Graphiti の edge の `episodes`、agentmemory の引用、gbrain
  - 置き換え：agentmemory の版の連鎖、Supermemory の `updates`
  - 適用範囲：Cursor の `globs`、Claude Code の `paths`
  - 条件・例外を、主張と一緒に機械判定できる形で持つツールは見つからなかった。
- **ファイル形式の公開標準はまだない。** 次の提案があるが、普及していない。
  - MacPaw Portable Memory（JSONL の束、有効期間と削除記録）
  - MIF（Markdown＋frontmatter、PROV 由来の provenance）
  - 同名の Agent Memory Protocol 草案（github.com/agentmemoryprotocol）

## AMP 0.3 の方針

1. **土台は普通の Markdown ノート。** 本文の最初の段落を主張とする。frontmatter に `amp: "0.3"` を書くと、記憶として扱う。その他のキー（`globs`、`permalink` など）は読み飛ばす。
2. **他ツールで慣習的なキーをそのまま使う。** `name`（ID）、`description`（選ぶための1行説明）、`type`、`tags`、`created`、`modified` を読む。Claude Code のメモリファイルは、`amp_save` の `markdown` 入力で変換なしに取り込める。
3. **精度に効く項目は任意の追加にする。** 次のものを書けば、検索と適用判定に使う。
   - `basis`、`conditions`、`sources`（＋`source_hashes`）
   - `valid_from`／`valid_until`、`supersedes`
   - 本文の「Exceptions」「Limitations」「Procedure」「Rationale」の各節
4. **値は JSON で書く。** frontmatter の値は JSON か単純な値にする。JSON は YAML の部分集合なので、YAML として読むツールでもそのまま読める。依存パッケージも増えない。

## 各ツールとの対応

| ツール | 記憶の単位と主な項目 | AMP 0.3 との対応 |
|---|---|---|
| Mem0 | `memory`（本文）、`id`、`user_id`/`agent_id`/`run_id`、`metadata`、`created_at`/`updated_at`、`expiration_date` | `memory`→本文、`expiration_date`→`valid_until`、スコープ→`tags` または保存先パス |
| Graphiti/Zep | edge `fact`、`valid_at`/`invalid_at`/`expired_at`、`episodes`（出典）、`group_id` | `fact`→本文、`valid_at`/`invalid_at`→`valid_from`/`valid_until`、`episodes`→`sources` |
| Letta | block `label`/`value`/`description`/`limit`、archival passage `content`/`tags`/`timestamp` | `label`→`name`、`value`→本文、`description`→`description` |
| LangGraph Store/LangMem | `namespace`、`key`、`value`、`created_at`/`updated_at` | `key`→`name`、`namespace`→保存先パス |
| MCP memory server | entity `name`/`entityType`/`observations[]`、relation | observation→本文、`entityType`→`type`、entity→`tags` |
| Claude Code 自動メモリ | frontmatter `name`/`description`/`type`、本文、`MEMORY.md` の1行索引 | そのまま取り込める |
| Basic Memory | frontmatter `title`/`type`/`tags`、`- [category] text`、`[[link]]` | `title`/`type`/`tags` はそのまま。観察行は本文として残る |
| Cursor rules | `description`、`globs`、`alwaysApply` | `description` は共通。`globs` は読み飛ばす |
| agentmemory | 記憶の版の連鎖、出典の引用、`concepts`、TTL | 版の連鎖→`supersedes`、引用→`sources` |

## 出典

- Mem0: https://docs.mem0.ai/api-reference/memory/add-memories , https://docs.mem0.ai/api-reference/memory/search-memories
- Graphiti: https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/edges.py , https://help.getzep.com/concepts.md
- Letta: https://docs.letta.com/api-reference/blocks/create , https://docs.letta.com/guides/agents/agent-file
- LangGraph/LangMem: https://reference.langchain.com/python/langgraph.store/base , https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- Hindsight: https://github.com/vectorize-io/hindsight ; gbrain: https://github.com/garrytan/gbrain ; agentmemory: https://github.com/rohitg00/agentmemory ; Mnemosyne: https://github.com/mnemosyne-oss/mnemosyne
- Claude memory tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool ; Claude Code memory: https://code.claude.com/docs/en/memory.md
- AGENTS.md: https://agents.md/ ; Cursor rules: https://cursor.com/docs/context/rules
- MCP memory server: https://github.com/modelcontextprotocol/servers/tree/main/src/memory ; Basic Memory: https://github.com/basicmachines-co/basic-memory
- Karpathy LLM wiki: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f ; Obsidian Properties: https://obsidian.md/help/Editing+and+formatting/Properties
- MacPaw Portable Memory: https://github.com/MacPaw/portable-memory ; MIF: https://github.com/zircote/MIF ; 同名の AMP 草案: https://github.com/agentmemoryprotocol/agentmemoryprotocol

## 未確認

- Mem0 のホスト版の履歴 API（ページが 404）とライセンス
- Cognee のデータモデルの項目
- Supermemory v5 の応答項目
- Hindsight の時刻項目の名前
- Basic Memory の生の README の文法
- Cursor が未知の frontmatter キーをどう扱うか
- Codex の AGENTS.md のサイズ制限
- W3C の Community Group の詳細
