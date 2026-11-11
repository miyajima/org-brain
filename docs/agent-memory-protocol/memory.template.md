# 下層メモリのテンプレート

仮の参照と本文を原本に基づいて置き換える。条件のキーは検索時に渡すfactsと揃える。実行について書くときはbasisを区別し、eventを追加する。確認前はdraftにする。

```amp
{
  "protocol": "amp/0.1",
  "kind": "memory",
  "id": "memory-id",
  "revision": 1,
  "title": "この記憶で判断できること",
  "aliases": ["別の検索表現"],
  "status": "draft",
  "basis": "implementation",
  "claim": "特定の条件で成立する1つの主張。",
  "rationale": "原本から説明できる理由。",
  "reuse_when": "今回の問題とどんな条件が一致すると使えるか。",
  "conditions": [{"key": "runtime", "equals": "local"}],
  "exceptions": [{"when": [{"key": "disabled", "equals": true}], "reason": "無効ならこの手順を適用しない。"}],
  "procedure": ["必要な確認または操作。"],
  "limitations": ["まだ確認していない範囲。"],
  "evidence": [{"ref": "source:REPLACE@1#L1-L3", "sha256": "0000000000000000000000000000000000000000000000000000000000000000"}]
}
```
