# 実クライアントのStopでどこまで確認した？

2026-10-19のCursor実クライアント試験の報告では、通常Stop後に2ジョブがpendingとなり、手動で通常ワーカーを実行して2ジョブ完了・1候補を隔離保存した。

根拠の種類: `reported_execution`。条件・例外・限界は以下の正本と一緒に読む。

[根拠1](source:3efac5f7-b9ec-499e-8ccd-f559d7818875@1#L1-L18)

```amp
{
  "protocol": "amp/0.1",
  "kind": "memory",
  "revision": 1,
  "status": "active",
  "basis": "reported_execution",
  "conditions": [
    {
      "key": "client",
      "equals": "Cursor"
    },
    {
      "key": "experiment_date",
      "equals": "2026-10-19"
    }
  ],
  "exceptions": [],
  "procedure": [
    "報告の試験条件を今回の説明対象と照合する。",
    "受付・手動処理・隔離保存までを区別して説明する。"
  ],
  "limitations": [
    "今回参照したのは版付きの検証報告。原履歴や実クライアントを再検証していない。",
    "自動起動・activeへの有効化・実作業での再利用効果はこの報告から証明できない。",
    "文書の3項目確認を3件の製品動作試験成功に置き換えない。"
  ],
  "id": "orgbrain-cursor-stop-report",
  "title": "実クライアントのStopでどこまで確認した？",
  "aliases": [
    "Cursor",
    "実セッション",
    "実測",
    "quarantine",
    "隔離",
    "2026-10-19"
  ],
  "claim": "2026-10-19のCursor実クライアント試験の報告では、通常Stop後に2ジョブがpendingとなり、手動で通常ワーカーを実行して2ジョブ完了・1候補を隔離保存した。",
  "rationale": "通常Stopでの受付と、その後の手動ワーカー処理の結果が分けて報告されているため。",
  "reuse_when": "この版・この試験が到達した段階を説明するとき。現在の自動運用の成否判定には使わない。",
  "event": {
    "date": "2026-10-19",
    "environment": "Cursor 3.25.6 / This Mac / org-brain。通常Stop、ワーカーは手動起動。利用者による入力操作補助あり。",
    "outcome": "2ジョブ完了、1候補をquarantine保存。activeへの有効化の証明ではない。"
  },
  "evidence": [
    {
      "ref": "source:3efac5f7-b9ec-499e-8ccd-f559d7818875@1#L1-L18",
      "sha256": "20c9fdc33186d8a1d17f42277ead97a61f4aa0d1e339398d91c27f256f7c4086"
    }
  ]
}
```

