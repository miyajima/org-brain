# Wikiを保存すれば記憶のキューに入る？

Wikiから記憶への投入は、保存後のページIDとhashを読み戻して照合し、保存済みproject_idがあることを確認して進む。ページの保存だけではキュー受付を保証しない。

根拠の種類: `implementation`。条件・例外・限界は以下の正本と一緒に読む。

[根拠1](source:6c9f4f10-bdd9-4180-a3c3-b391f2824966@1#L143-L186)

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
      "key": "route",
      "equals": "wiki_mcp"
    }
  ],
  "exceptions": [
    {
      "when": [
        {
          "key": "saved_project_present",
          "equals": false
        }
      ],
      "reason": "projectがないページはwiki_project_scope_missingとなる。"
    },
    {
      "when": [
        {
          "key": "hash_matches",
          "equals": false
        }
      ],
      "reason": "改版などで保存後のhashが違えば投入しない。"
    }
  ],
  "procedure": [
    "ページ保存の成功を確認する。",
    "memory_intake.queuedとreasonを読み、保存したページとprojectの一致を確認する。"
  ],
  "limitations": [
    "実装の根拠はチェックアウト8f5dc131f933の保存版。稼働中クライアントの設定・成功を保証しない。",
    "呼び出し側が指定したprojectとの不一致も投入を止める。",
    "重複・パイプライン無効など、新規投入されない条件は別途ある。"
  ],
  "id": "orgbrain-wiki-intake",
  "title": "Wikiを保存すれば記憶のキューに入る？",
  "aliases": [
    "個人Wiki",
    "ページ",
    "改版",
    "hash",
    "project_id"
  ],
  "claim": "Wikiから記憶への投入は、保存後のページIDとhashを読み戻して照合し、保存済みproject_idがあることを確認して進む。ページの保存だけではキュー受付を保証しない。",
  "rationale": "保存したページと別の版・範囲を記憶の原本にしないため。",
  "reuse_when": "Wiki保存後にmemory_intakeの結果を確認するとき。",
  "evidence": [
    {
      "ref": "source:6c9f4f10-bdd9-4180-a3c3-b391f2824966@1#L143-L186",
      "sha256": "cf654bd2b3e9cd877cf0f3c0747a641bef27c65c29dda6565fe9d2af5b15454f"
    }
  ]
}
```

