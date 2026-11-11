# インデックスのテンプレート

以下の値を実データに置き換える。`hash`は下層ページを保存して読み戻した状態hashを使う。このテンプレートの仮の参照は原本検査に通らない。

```amp
{
  "protocol": "amp/0.1",
  "kind": "index",
  "id": "topic-id",
  "revision": 1,
  "title": "繰り返し答えたい問いは？",
  "aliases": ["同じ問いの別表現"],
  "question": "このページを使って何を判断するか？",
  "summary": "対象と下層の読み先を短く案内する。",
  "entries": [
    {
      "question": "この項目が答える問いは？",
      "aliases": ["検索に使う語"],
      "summary": "どんな条件の判断へ進めるか。",
      "memory": {
        "id": "memory-id",
        "path": "amp/memories/example.md",
        "hash": "0000000000000000000000000000000000000000000000000000000000000000"
      }
    }
  ]
}
```
