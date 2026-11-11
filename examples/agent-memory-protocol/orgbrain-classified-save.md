# 分類による自動保存は何を保証する？

分類自動保存はコード上の既定で有効。出典処理では分類が明確な候補の審査モデル判定を省略できるが、保存状態activeと検証状態unverifiedを併記する。

根拠の種類: `implementation`。条件・例外・限界は以下の正本と一緒に読む。

[根拠1](source:eda317c6-89c2-4b09-a745-044e6ad226f4@1#L22-L23) / [根拠2](source:954e4da4-d4e8-4d94-8c60-7951da977098@1#L61-L93)

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
      "key": "classified_auto_save",
      "equals": true
    }
  ],
  "exceptions": [
    {
      "when": [
        {
          "key": "source_changed",
          "equals": true
        }
      ],
      "reason": "抽出後に出典hashが変われば、その入力での有効化を止める。"
    }
  ],
  "procedure": [
    "設定が文字列falseになっていないか確認する。",
    "runの状態と保存された記憶のverification_stateを別々に読む。"
  ],
  "limitations": [
    "実装の根拠はチェックアウト8f5dc131f933の保存版。稼働中クライアントの設定・成功を保証しない。",
    "曖昧な分類はreviewingへ進む。機密情報や根拠の検査など、別の保存条件もある。",
    "設定falseでは従来の出典審査経路になり、この自動保存ルールを適用しない。"
  ],
  "id": "orgbrain-classified-save",
  "title": "分類による自動保存は何を保証する？",
  "aliases": [
    "審査",
    "active",
    "自動保存",
    "検証済み",
    "ORGBRAIN_MEMORY_AUTO_SAVE_CLASSIFIED"
  ],
  "claim": "分類自動保存はコード上の既定で有効。出典処理では分類が明確な候補の審査モデル判定を省略できるが、保存状態activeと検証状態unverifiedを併記する。",
  "rationale": "保存可能な分類と、根拠の審査や過去の実行確認は別の判定だから。",
  "reuse_when": "分類保存された記憶の意味や、従来の審査経路との違いを説明するとき。",
  "evidence": [
    {
      "ref": "source:eda317c6-89c2-4b09-a745-044e6ad226f4@1#L22-L23",
      "sha256": "e1cb03c223b804abd7e0b90ad05a725b69de59ed910396912f2416ebee5c1883"
    },
    {
      "ref": "source:954e4da4-d4e8-4d94-8c60-7951da977098@1#L61-L93",
      "sha256": "ede40ba553e349421ca523b80614b261b2a9e647c8e518ef623653e815a2af08"
    }
  ]
}
```

