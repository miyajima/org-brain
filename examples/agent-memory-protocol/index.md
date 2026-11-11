# 記憶はどこから入り、いつ使える？ — AMPインデックス

入口の実装条件と、過去の実行報告を分けて読む。受付・起動・有効化の確認は最初のメモリへ進む。

| 調べる問い | 根拠の種類 |
|---|---|
| [受付・起動・有効化はどう区別する？](page:1877a4dc-dd48-4778-906e-115ee521f5b6) | 実装 |
| [Stopから共通抽出に入る条件は？](page:4849916b-a19d-4012-96e9-a44e9705f0b7) | 実装 |
| [分類による自動保存は何を保証する？](page:868d63a9-abd8-487a-b299-15cb8a893a9d) | 実装 |
| [Wikiを保存すれば記憶のキューに入る？](page:56d6a1a2-07fe-494a-9d3b-a4edcba6c9a4) | 実装 |
| [実クライアントのStopでどこまで確認した？](page:12f4e4f3-70ed-4194-9976-b62e4551ab59) | 実行報告 |

元の詳しい説明: [[topics/orgbrain-memory-intake-and-availability.md]]。以下の正本をAMP検索が使う。上の案内だけで実行判断をせず、下層の条件・例外・版付き根拠を読む。

```amp
{
  "protocol": "amp/0.1",
  "kind": "index",
  "id": "orgbrain-memory-intake",
  "revision": 1,
  "title": "記憶はどこから入り、いつ使える？ — AMPインデックス",
  "aliases": [
    "記憶の入口",
    "保存",
    "検索できる",
    "取り込み",
    "有効化"
  ],
  "question": "どの入力が、どの条件で、使える状態まで進むか？",
  "summary": "入口の実装条件と、過去の実行報告を分けて読む。受付・起動・有効化の確認は最初のメモリへ進む。",
  "entries": [
    {
      "question": "受付・起動・有効化はどう区別する？",
      "aliases": [
        "queued",
        "worker.started",
        "キュー",
        "起動",
        "有効化"
      ],
      "summary": "保存版の実装を基に、適用条件と例外を読む。",
      "memory": {
        "id": "orgbrain-intake-state",
        "path": "amp/memories/orgbrain-intake-state.md",
        "hash": "f646de051ae834808a68242a4a84edd711fefe8e54700c3d8d60babdbff2deeb"
      }
    },
    {
      "question": "Stopから共通抽出に入る条件は？",
      "aliases": [
        "会話終了",
        "Codex",
        "Claude",
        "Cursor",
        "取り込み"
      ],
      "summary": "保存版の実装を基に、適用条件と例外を読む。",
      "memory": {
        "id": "orgbrain-stop-intake",
        "path": "amp/memories/orgbrain-stop-intake.md",
        "hash": "75a666cf384c23a14c0f2bc706e37d567f0e6653fd52e2bd9068d183ad919f10"
      }
    },
    {
      "question": "分類による自動保存は何を保証する？",
      "aliases": [
        "審査",
        "active",
        "自動保存",
        "検証済み",
        "ORGBRAIN_MEMORY_AUTO_SAVE_CLASSIFIED"
      ],
      "summary": "保存版の実装を基に、適用条件と例外を読む。",
      "memory": {
        "id": "orgbrain-classified-save",
        "path": "amp/memories/orgbrain-classified-save.md",
        "hash": "3fa6edd7a7d5b4d7849af131d125194b9a990b5fe9560bcdb3428dbdeb024b12"
      }
    },
    {
      "question": "Wikiを保存すれば記憶のキューに入る？",
      "aliases": [
        "個人Wiki",
        "ページ",
        "改版",
        "hash",
        "project_id"
      ],
      "summary": "保存版の実装を基に、適用条件と例外を読む。",
      "memory": {
        "id": "orgbrain-wiki-intake",
        "path": "amp/memories/orgbrain-wiki-intake.md",
        "hash": "102c7d7b66ab47ced57e3241f16b801eccac23b9c5a553f0e7b7aa9908871926"
      }
    },
    {
      "question": "実クライアントのStopでどこまで確認した？",
      "aliases": [
        "Cursor",
        "実セッション",
        "実測",
        "quarantine",
        "隔離"
      ],
      "summary": "実セッションの報告。到達段階と未確認点を読む。",
      "memory": {
        "id": "orgbrain-cursor-stop-report",
        "path": "amp/memories/orgbrain-cursor-stop-report.md",
        "hash": "aac3546d8d10225e676096277f7f39f1515bb78bccf654a1a517205786c5e51f"
      }
    }
  ]
}
```

