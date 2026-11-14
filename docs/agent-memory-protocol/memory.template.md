---
amp: '0.4'
name: memory-id
description: この記憶で判断できること
status: draft
basis: implementation
tags:
  - 別の検索表現
reuse_when: 今回の問題とどんな条件が一致すると使えるか。
conditions:
  runtime: local
exceptions:
  - when:
      disabled: true
    reason: 無効ならこの手順を適用しない。
sources:
  - ref: source:REPLACE@1#L1-L3
---
# この記憶で判断できること

特定の条件で成立する1つの主張。

## Rationale

原本から説明できる理由。

## Procedure

- 必要な確認または操作。

## Limitations

- まだ確認していない範囲。
- これは記述用のひな形。仮の出典と本文を原本に基づいて置き換え、保存時に出典を照合する。
