import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiService } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
import { createWikiHttpHandler } from "../packages/orgbrain-cli/src/lib/wiki-http.mjs";
import { setWikiFeature } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
const { chromium } = createRequire(
  new URL("../apps/console/package.json", import.meta.url),
)("@playwright/test");

test("Wiki desktop/mobile creation, search, editing, source preview, history and OFF isolation", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-ui-")));
  const service = new WikiService({
    config: join(home, "features.json"),
    root: join(home, "wiki"),
  });
  const handler = createWikiHttpHandler(service);
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      channel: process.env.WIKI_TEST_BROWSER || "chrome",
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/settings`);
    await page.getByRole("switch", { name: "LLM Wikiを有効にする" }).check();
    await page.getByRole("link", { name: "Wikiを開く" }).click();
    await page.getByRole("button", { name: "Wikiを初期化" }).click();
    await page.getByRole("button", { name: "新しいページ" }).click();
    await page.getByLabel("パス").fill("topics/test.md");
    await page.getByLabel("タイトル", { exact: true }).fill("検索テスト");
    await page.getByRole("button", { name: "作成", exact: true }).click();
    await page
      .locator(".cm-content")
      .fill("# 検索テスト\n\n## 日本語\n全文検索の根拠\n");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: "本文", exact: true }).click();
    await page.locator("#preview").getByText("全文検索の根拠").waitFor();
    await page.getByRole("searchbox").fill("検索");
    await page.getByRole("searchbox").press("Enter");
    await page.locator("#page-list button").first().click();
    await page.getByRole("button", { name: "履歴", exact: true }).click();
    await page.locator("#evidence-list button").nth(1).click();
    await page.locator("#diff-dialog[open]").waitFor();
    await page
      .locator("#diff-after .diff-added")
      .first()
      .waitFor({ timeout: 2000 });
    await page.locator("#close-diff").click();
    await page.locator("#source-upload").setInputFiles({
      name: "source.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("original\r\nsource\r\n"),
    });
    await page.getByRole("button", { name: "ソース", exact: true }).click();
    await page.locator("#page-list button").first().click();
    await page.locator("#source-dialog[open]").waitFor();
    assert.match(await page.locator("#source-text").textContent(), /original/);
    await page.locator("#close-source").click();
    await page.screenshot({ path: join(home, "desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: join(home, "mobile.png"), fullPage: true });
    const settings = await browser.newPage();
    await settings.goto(`${origin}/settings`);
    await settings
      .getByRole("switch", { name: "LLM Wikiを有効にする" })
      .uncheck();
    await settings
      .getByRole("link", { name: "Wikiを開く" })
      .waitFor({ state: "hidden" });
    await page.waitForURL(`${origin}/settings`, { timeout: 5000 });
    await settings.close();
    await page.goto(`${origin}/wiki`);
    assert.equal(new URL(page.url()).pathname, "/settings");
    assert.deepEqual(errors, []);
    console.log(`Wiki UI screenshots: ${home}`);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Long page lists use readable titles and keep navigation and reading inside one viewport", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-panes-")));
  const service = new WikiService({
    config: join(home, "features.json"),
    root: join(home, "wiki"),
  });
  await setWikiFeature(service.config, true);
  await service.request({ op: "init" });
  let last;
  const titles = [];
  for (let i = 0; i < 40; i++) {
    const title = `読みやすいタイトル ${String(i).padStart(2, "0")} ${"長いページ名でも一覧が揃う ".repeat(5).trim()}`;
    titles.push(title);
    last = await service.request({
      op: "put",
      path: `wiki/topics/machine-name-${String(i).padStart(2, "0")}.md`,
      content: `# ${title}\n\n${"読み取りの根拠を確認します。\n\n".repeat(400)}`,
    });
  }
  const handler = createWikiHttpHandler(service);
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.WIKI_TEST_BROWSER || "chrome",
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.goto(`${origin}/wiki`);
    await page.locator("#page-list [data-page]").last().waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= innerHeight,
      ),
      true,
    );
    const row = page.locator(`#page-list [data-page="${last.page_id}"]`);
    await row.scrollIntoViewIfNeeded();
    assert.equal(
      await row.locator("span").first().textContent(),
      titles.at(-1),
    );
    assert.equal(await row.locator("small").count(), 0);
    assert.match(await row.getAttribute("title"), /読みやすいタイトル 39/);
    assert.ok(
      await row.locator("span").evaluate((e) => e.scrollWidth > e.clientWidth),
    );
    assert.ok((await row.boundingBox()).height <= 40);
    await row.click();
    await page.waitForURL(`**?page=${last.page_id}`);
    assert.equal(
      await page.locator("#page-title").textContent(),
      titles.at(-1),
    );
    const top = (await page.locator("#page-title").boundingBox()).y;
    assert.ok(top < 160);
    await page.locator("#preview").evaluate((e) => {
      e.scrollTop = e.scrollHeight;
    });
    assert.ok(await page.locator("#preview").evaluate((e) => e.scrollTop > 0));
    assert.equal((await page.locator("#page-title").boundingBox()).y, top);
    assert.equal(await page.evaluate(() => scrollY), 0);
    await page.locator("#preview").evaluate((e) => {
      e.scrollTop = 0;
    });
    await page.screenshot({ path: join(home, "desktop-panes.png") });
    await page.setViewportSize({ width: 900, height: 700 });
    await page.getByRole("button", { name: "根拠ペインを開く" }).click();
    await page.locator(".evidence-sidebar").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator(".evidence-sidebar").waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "ページ一覧を開く" }).click();
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await page.locator(".page-sidebar").waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
      true,
    );
    assert.ok((await page.locator("#page-title").boundingBox()).y < 160);
    await page.screenshot({ path: join(home, "mobile-panes.png") });
    console.log(`Wiki pane screenshots: ${home}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Source and review tabs identify uncited originals, separate link issues and never re-import or modify evidence", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-review-")));
  const service = new WikiService({ config: join(home, "features.json"), root: join(home, "wiki") });
  await setWikiFeature(service.config, true);
  await service.request({ op: "init" });
  const unused = await service.request({ op: "ingest", name: "補助スクリプト.py", text: "print('original')\n" });
  const used = await service.request({ op: "ingest", name: "比較の根拠.md", text: "original evidence\n" });
  const stored = await service.request({ op: "put", path: "topics/comparison.md", content: `# 読みやすい比較\n\n[source](source:${used.source_id}@1#L1-L1)\n\n[[topics/missing.md|見つからないページ]]\n` });
  await service.request({ op: "put", path: "topics/isolated.md", content: "# 孤立した解説\n" });
  const handler = createWikiHttpHandler(service);
  const server = createServer(async (req, res) => { if (!(await handler(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, channel: process.env.WIKI_TEST_BROWSER || "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/wiki?page=${stored.page_id}`);
    await page.getByRole("button", { name: "ソース", exact: true }).click();
    assert.equal(await page.locator("#page-list button").count(), 2);
    await page.getByRole("button", { name: "要確認", exact: true }).click();
    await page.locator("#page-list h3").filter({ hasText: "未引用のソース" }).waitFor();
    const groups = await page.locator("#page-list h3").allTextContents();
    assert.deepEqual(groups, ["未解決リンク · 1", "孤立ページ · 1", "未引用のソース · 1"]);
    const row = page.locator("#page-list button").filter({ hasText: "補助スクリプト.py" });
    assert.match(await row.textContent(), /ページからの引用なし/);
    assert.doesNotMatch(await page.locator("#page-list").textContent(), new RegExp(unused.source_id));
    assert.doesNotMatch(await page.locator("#page-list").textContent(), /未整理の資料/);
    await row.click();
    await page.locator("#source-dialog[open]").waitFor();
    assert.equal(await page.locator("#source-title").textContent(), "補助スクリプト.py");
    assert.equal(await page.locator("#source-text").textContent(), "print('original')\n");
    assert.match(await page.locator("#source-review-reason").textContent(), /ページからの引用なし/);
    await page.screenshot({ path: join(home, "review-source.png") });
    await page.locator("#close-source").click();
    await page.locator("#page-list button").filter({ hasText: "topics/missing.md" }).click();
    assert.equal(await page.locator("#page-title").textContent(), "読みやすい比較");
    await page.getByRole("button", { name: "ソース", exact: true }).click();
    await page.locator("#page-list button").filter({ hasText: "比較の根拠.md" }).click();
    await page.locator("#source-dialog[open]").waitFor();
    assert.equal(await page.locator("#source-review-reason").isVisible(), false);
    await page.locator("#close-source").click();
    await page.getByRole("button", { name: "要確認", exact: true }).click();
    await page.locator("#page-list h3").filter({ hasText: "未引用のソース" }).waitFor();
    await page.screenshot({ path: join(home, "review-list.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "ページ一覧を開く" }).click();
    await row.click();
    await page.locator("#source-dialog[open]").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
    assert.equal(await page.locator("#source-version").evaluate((e) => e.scrollWidth <= e.clientWidth), true);
    await page.screenshot({ path: join(home, "review-mobile.png") });
    assert.equal((await service.request({ op: "read", page_id: stored.page_id })).hash, stored.hash);
    assert.equal((await service.request({ op: "source_read", source_id: unused.source_id, version: 1 })).text, "print('original')\n");
    assert.equal((await service.request({ op: "sources" })).sources.length, 2);
    console.log(`Wiki review screenshots: ${home}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
