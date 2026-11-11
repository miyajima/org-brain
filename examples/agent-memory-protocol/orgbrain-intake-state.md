# 受付・起動・有効化はどう区別する？

memory_intake.queued は受付、worker.started は起動要求の結果。有効化の確認は保存されたrunとmemoryの状態を照合する。

根拠の種類: `implementation`。条件・例外・限界は以下の正本と一緒に読む。

[根拠1](source:2bb57177-a377-4359-b14d-8219231cca01@1#L6-L11)

```amp
{
  "protocol": "amp/0.1",
  "kind": "memory",
  "revision": 1,
  "status": "active",
  "basis": "implementation",
  "conditions": [
    {
      "key": "runtime",
      "equals": "local"
    }
  ],
  "exceptions": [],
  "procedure": [
    "キューIDと受付結果を確認する。",
    "対象プロジェクトの pipeline status を読み、保存された記憶ID・版・active状態を照合する。"
  ],
  "limitations": [
    "実装の根拠はチェックアウト8f5dc131f933の保存版。稼働中クライアントの設定・成功を保証しない。",
    "activeや検索での返却だけでは、内容の正しさ・実作業での利用・効果を証明しない。"
  ],
  "id": "orgbrain-intake-state",
  "title": "受付・起動・有効化はどう区別する？",
  "aliases": [
    "queued",
    "worker.started",
    "キュー",
    "起動",
    "有効化",
    "いつ使える"
  ],
  "claim": "memory_intake.queued は受付、worker.started は起動要求の結果。有効化の確認は保存されたrunとmemoryの状態を照合する。",
  "rationale": "起動要求が成功しても、その後の抽出・保存が完了したとは限らないため。",
  "reuse_when": "ローカルWikiからの記憶投入結果を説明するとき。",
  "evidence": [
    {
      "ref": "source:2bb57177-a377-4359-b14d-8219231cca01@1#L6-L11",
      "sha256": "9d3dcd02027e489d9de4dc8b2d84924ffad45d5de205015c888e5930abef2478"
    }
  ]
}
```

