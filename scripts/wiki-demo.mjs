import { mkdtemp, realpath, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  WikiService,
  setWikiFeature,
} from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
const home = await realpath(
  await mkdtemp(join(tmpdir(), "orgbrain-wiki-demo-")),
);
const config = join(home, "features.json"),
  root = join(home, "wiki");
await setWikiFeature(config, true);
const wiki = new WikiService({ config, root });
await wiki.request({ op: "init" });
const source = await wiki.request({
  op: "ingest",
  file: resolve("docs/LOCAL_KNOWLEDGE_WIKI.md"),
  name: "LOCAL_KNOWLEDGE_WIKI.md",
});
await wiki.request({
  op: "put",
  path: "OrgBrain/Knowledge Wiki.md",
  title: "Knowledge Wiki",
  content: `# Knowledge Wiki\n\n## 保存基盤\nWiki本文、引用、リンク、履歴はSQLite、原本は変更しないファイルとして保存します。OrgBrainの記憶とは別のDBです。\n\n## 操作面\nローカルのWeb UI、CLI、MCPは同じRustエンジンを使います。生成・意味的判断は既存エージェントが担当します。\n\n## 根拠\n[実装手順](source:${source.source_id}@${source.version})\n`,
});
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", resolve);
});
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const log = await open(join(home, "server.log"), "w", 0o600);
const child = spawn(
  process.execPath,
  [
    resolve("packages/orgbrain-cli/src/local-memory.mjs"),
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    env: {
      ...process.env,
      ORGBRAIN_FEATURES_FILE: config,
      ORGBRAIN_WIKI_ROOT: root,
      ORGBRAIN_LOCAL_DB: join(home, "memory.sqlite"),
      ORGBRAIN_AUTO_BACKUP: "false",
    },
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  },
);
child.unref();
await log.close();
for (let n = 0; n < 50; n++) {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/features/llm-wiki`,
    );
    if (response.ok) {
      console.log(
        JSON.stringify({
          url: `http://127.0.0.1:${port}/wiki`,
          pid: child.pid,
          temporary_state: home,
          actual_user_configuration_changed: false,
        }),
      );
      process.exit(0);
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
throw new Error(`demo_start_failed: inspect ${home}/server.log`);
