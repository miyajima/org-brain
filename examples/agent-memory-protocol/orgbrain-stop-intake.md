# Stopから共通抽出に入る条件は？

対象クライアントのStopで、共通抽出モードon・ローカル取込が無効でない・学習モードconfirm以外の場合に完了ターンを読んで抽出キューへ登録する。

根拠の種類: `implementation`。条件・例外・限界は以下の正本と一緒に読む。

[根拠1](source:05aecc74-6cb0-4d52-8974-d299dc2d5464@1#L2154-L2195)

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
    },
    {
      "key": "session_extraction_mode",
      "equals": "on"
    },
    {
      "key": "local_hook_capture",
      "equals": true
    }
  ],
  "exceptions": [
    {
      "when": [
        {
          "key": "learning_mode",
          "equals": "off"
        }
      ],
      "reason": "学習offでは早期終了する。"
    },
    {
      "when": [
        {
          "key": "learning_mode",
          "equals": "confirm"
        }
      ],
      "reason": "confirmでは共通抽出の分岐に入らない。"
    },
    {
      "when": [
        {
          "key": "completed_turn_available",
          "equals": false
        }
      ],
      "reason": "完了ターンがなければ新しい共通抽出ジョブを作らない。"
    }
  ],
  "procedure": [
    "空入力でないこと、学習モード、共通抽出設定を確認する。",
    "完了ターンが取得されたかとsessionExtraction.statusを確認する。"
  ],
  "limitations": [
    "実装の根拠はチェックアウト8f5dc131f933の保存版。稼働中クライアントの設定・成功を保証しない。",
    "この記憶は共通抽出の入口を説明する。ほかの保存経路や抽出後の有効化まで成立したとは言えない。",
    "ワーカー自動起動には別のautorun設定とジョブ状態の条件がある。"
  ],
  "id": "orgbrain-stop-intake",
  "title": "Stopから共通抽出に入る条件は？",
  "aliases": [
    "会話終了",
    "Codex",
    "Claude",
    "Cursor",
    "取り込み",
    "入力"
  ],
  "claim": "対象クライアントのStopで、共通抽出モードon・ローカル取込が無効でない・学習モードconfirm以外の場合に完了ターンを読んで抽出キューへ登録する。",
  "rationale": "Stopの入口は学習モードと設定を確認し、完了ターンがあるときだけ共通抽出へ渡すため。",
  "reuse_when": "共通抽出キューに会話が入らない原因を調べるとき。",
  "evidence": [
    {
      "ref": "source:05aecc74-6cb0-4d52-8974-d299dc2d5464@1#L2154-L2195",
      "sha256": "0a871b4eea11e71ffa5b7bc8fa15a3c9f37d0f2708e394b28a37a1a49f1573a4"
    }
  ]
}
```

