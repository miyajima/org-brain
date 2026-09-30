import { mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  WikiService,
  setWikiFeature,
} from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-search-eval-")));
const config = join(home, "features.json");
await setWikiFeature(config, true);
const wiki = new WikiService({ config, root: join(home, "wiki") });
await wiki.request({ op: "init" });
const corpus = [
  [
    "originals.md",
    "原本保管",
    "# 原本保管\n資料の元のバイト列を変更せず保管する。SHA-256で同一性と破損を確認する。Original evidence files are immutable and verified by cryptographic checksums.",
  ],
  [
    "history.md",
    "編集履歴",
    "# 編集履歴\nページの過去の版を保持し、以前の内容へ復元できる。編集時には読取時のハッシュで競合を検出する。Version history supports undoing edits and restoring earlier page content.",
  ],
  [
    "search.md",
    "日本語検索",
    "# 日本語検索\nSQLiteの全文索引で見出し単位の全文検索を行う。短語にはn-gram索引を使う。Full text search uses heading-level indexed chunks.",
  ],
  [
    "travel.md",
    "出張",
    "# 出張\n空港から宿泊施設へ電車で移動する。Travel itinerary and hotel reservations.",
  ],
];
for (const [path, title, content] of corpus)
  await wiki.request({ op: "put", path, title, content });
const results = [];
for (const [query, expected] of [
  ["日本語検索", "日本語検索"],
  ["FULL TEXT", "日本語検索"],
  ["短語", "日本語検索"],
  ["SHA-256", "原本保管"],
  ["zzzxxyy_not_in_corpus", null],
]) {
  const r = await wiki.search({ query });
  assert.equal(r.hits[0]?.title || null, expected);
  results.push({
    query,
    mode: "lexical",
    expected,
    actual: r.hits[0]?.title || null,
  });
}
if (process.env.WIKI_LIVE_OLLAMA === "1") {
  process.env.ORGBRAIN_WIKI_EMBEDDING_PROVIDER = "qwen-ollama";
  const indexed = await wiki.reindexEmbeddings();
  for (const [query, expected] of [
    ["Keep evidence untouched and detect file damage", "原本保管"],
    ["古い編集状態へ戻すには", "編集履歴"],
  ]) {
    const r = await wiki.search({ query, mode: "hybrid" });
    assert.equal(r.mode, "hybrid");
    assert.equal(r.fallback, null);
    assert.equal(r.hits[0]?.title, expected);
    results.push({ query, mode: r.mode, expected, actual: r.hits[0]?.title });
  }
  assert.equal((await wiki.reindexEmbeddings()).indexed, 0);
  console.log(
    JSON.stringify(
      {
        embedding_model:
          process.env.ORGBRAIN_LOCAL_EMBEDDING_MODEL || "qwen3-embedding:0.6b",
        model_key: indexed.model,
        indexed: indexed.indexed,
        reused_on_second_run: true,
        results,
      },
      null,
      2,
    ),
  );
} else
  console.log(
    JSON.stringify(
      {
        results,
        semantic_evaluation: "not_run; explicit WIKI_LIVE_OLLAMA=1 required",
      },
      null,
      2,
    ),
  );
