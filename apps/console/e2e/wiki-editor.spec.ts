import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WikiService } from '../../../packages/orgbrain-cli/src/lib/wiki-service.mjs';
import { createWikiHttpHandler } from '../../../packages/orgbrain-cli/src/lib/wiki-http.mjs';

let home: string, origin: string, server: Server, oldEngine: string | undefined;
let csrf: string;
async function api(input: object) {
  const r = await fetch(`${origin}/api/v1/wiki/request`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-wiki-csrf': csrf }, body: JSON.stringify(input) });
  const value = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(value));
  return value;
}
test.beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'orgbrain-wiki-e2e-')));
  const binary = resolve(`../../packages/orgbrain-cli/bin/${process.platform}-${process.arch}/orgbrain-wiki-engine${process.platform === 'win32' ? '.exe' : ''}`);
  oldEngine = process.env.ORGBRAIN_WIKI_ENGINE;
  process.env.ORGBRAIN_WIKI_ENGINE = binary;
  const service = new WikiService({ config: join(home, 'features.json'), root: join(home, 'wiki'), binary });
  const handler = createWikiHttpHandler(service, { assets: resolve('../../packages/orgbrain-cli/assets/wiki') });
  server = createServer(async (req, res) => { if (!(await handler(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  csrf = (await (await fetch(`${origin}/api/v1/features/llm-wiki`)).json()).csrf;
  const enabled = await fetch(`${origin}/api/v1/features/llm-wiki`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-wiki-csrf': csrf }, body: JSON.stringify({ enabled: true }) });
  expect(enabled.ok).toBeTruthy();
  await api({ op: 'init' });
});
test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close((err) => err ? reject(err) : done()));
  if (oldEngine === undefined) delete process.env.ORGBRAIN_WIKI_ENGINE; else process.env.ORGBRAIN_WIKI_ENGINE = oldEngine;
  await rm(home, { recursive: true, force: true });
});

test('polling resumes after a cached page is restored', async ({ page }) => {
  await api({ op: 'put', path: 'a.md', title: 'A', content: '# A\n' });
  let polls = 0;
  page.on('request', req => { if (req.url().endsWith('/api/v1/features/llm-wiki')) polls++; });
  await page.goto(`${origin}/wiki`);
  await expect(page.locator('#page-title')).toHaveText('A');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  const paused = polls;
  await page.waitForTimeout(1800);
  expect(polls).toBe(paused);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => polls, { timeout: 4000 }).toBeGreaterThan(paused);
});

test('a late page response cannot replace the newer selection', async ({ page }) => {
  const a = await api({ op: 'put', path: 'a.md', title: 'A', content: '# A\n' });
  await api({ op: 'put', path: 'b.md', title: 'B', content: '# B\n' });
  await page.goto(`${origin}/wiki`);
  await expect(page.locator('#page-title')).toHaveText('A');
  let release!: () => void, signal!: () => void;
  const waiting = new Promise<void>(r => { release = r; });
  const seen = new Promise<void>(r => { signal = r; });
  await page.route('**/api/v1/wiki/request', async route => {
    const body = route.request().postDataJSON();
    if (body.op === 'read' && body.page_id === a.page_id) {
      const response = await route.fetch(); signal(); await waiting; await route.fulfill({ response });
    } else await route.continue();
  });
  await page.locator('[data-page]').filter({ hasText: 'A' }).click();
  await seen;
  await page.locator('[data-page]').filter({ hasText: 'B' }).click();
  await expect(page.locator('#page-title')).toHaveText('B');
  const delayed = page.waitForResponse(response => response.url().endsWith('/api/v1/wiki/request') && response.request().postDataJSON()?.op === 'read' && response.request().postDataJSON()?.page_id === a.page_id);
  release();
  await delayed;
  await page.waitForTimeout(100);
  await expect(page.locator('#page-title')).toHaveText('B');
});

test('unsaved changes can be kept or discarded and conflicts retain the draft', async ({ page }) => {
  const a = await api({ op: 'put', path: 'a.md', title: 'A', content: '# A\n' });
  await api({ op: 'put', path: 'b.md', title: 'B', content: '# B\n' });
  await page.goto(`${origin}/wiki`);
  await expect(page.locator('#page-title')).toHaveText('A');
  await page.locator('#edit-mode').click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('draft text');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('[data-page]').filter({ hasText: 'B' }).click();
  await expect(page.locator('#page-title')).toHaveText('A');
  await api({ op: 'put', page_id: a.page_id, expected_hash: a.hash, content: '# External\n' });
  await page.locator('#save-page').click();
  await expect(page.locator('#error')).toContainText('conflict');
  await expect(page.locator('.cm-content')).toContainText('draft text');
  await expect(page.locator('#save-state')).toHaveText('未保存');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-page]').filter({ hasText: 'B' }).click();
  await expect(page.locator('#page-title')).toHaveText('B');
});

test('reads all chunks of a long page and handles keyboard pane controls', async ({ page }) => {
  const content = '# Long\n' + 'long text '.repeat(9000) + 'THE END';
  await api({ op: 'put', path: 'long.md', title: 'Long', content });
  await page.goto(`${origin}/wiki`);
  await expect(page.locator('#preview')).toContainText('THE END');
  await page.setViewportSize({ width: 500, height: 800 });
  await page.locator('#toggle-pages').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#toggle-pages')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#toggle-pages')).toHaveAttribute('aria-expanded', 'false');
});

test('disabling the feature leaves the Wiki screen', async ({ page }) => {
  await api({ op: 'put', path: 'a.md', title: 'A', content: '# A\n' });
  await page.goto(`${origin}/wiki`);
  await expect(page.locator('#page-title')).toHaveText('A');
  const response = await fetch(`${origin}/api/v1/features/llm-wiki`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-wiki-csrf': csrf }, body: JSON.stringify({ enabled: false }) });
  expect(response.ok).toBeTruthy();
  await expect(page).toHaveURL(`${origin}/settings`, { timeout: 6000 });
});

test('an edit typed during save remains unsaved', async ({ page }) => {
  await api({ op: 'put', path: 'a.md', title: 'A', content: '# A\n' });
  await page.goto(`${origin}/wiki`);
  await expect(page.locator('#page-title')).toHaveText('A');
  await page.locator('#edit-mode').click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('first');
  let release!: () => void, signal!: () => void;
  const waiting = new Promise<void>(r => { release = r; });
  const seen = new Promise<void>(r => { signal = r; });
  await page.route('**/api/v1/wiki/request', async route => {
    if (route.request().postDataJSON().op === 'put') {
      const response = await route.fetch(); signal(); await waiting; await route.fulfill({ response });
    } else await route.continue();
  });
  await page.locator('#save-page').click();
  await seen;
  await page.locator('.cm-content').click();
  await page.keyboard.type('later');
  const completed = page.waitForResponse(response => response.url().endsWith('/api/v1/wiki/request') && response.request().postDataJSON()?.op === 'links');
  release();
  await completed;
  await expect(page.locator('#save-state')).toHaveText('未保存');
  await expect(page.locator('.cm-content')).toContainText('later');
});

test('non-cached pagehide stops polls and pending save callbacks', async ({ page }) => {
  await api({ op: 'put', path: 'a.md', title: 'A', content: '# A\n' });
  let polls = 0;
  page.on('request', req => { if (req.url().endsWith('/api/v1/features/llm-wiki')) polls++; });
  await page.goto(`${origin}/wiki`);
  await expect(page.locator('#page-title')).toHaveText('A');
  await page.locator('#edit-mode').click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('draft');
  let release!: () => void, signal!: () => void;
  const waiting = new Promise<void>(r => { release = r; });
  const seen = new Promise<void>(r => { signal = r; });
  await page.route('**/api/v1/wiki/request', async route => {
    if (route.request().postDataJSON().op === 'put') {
      const response = await route.fetch(); signal(); await waiting; await route.fulfill({ response });
    } else await route.continue();
  });
  await page.locator('#save-page').click();
  await seen;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
  const stopped = polls;
  release();
  await page.waitForTimeout(1800);
  expect(polls).toBe(stopped);
  await expect(page.locator('#save-state')).toHaveText('未保存');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForTimeout(1800);
  expect(polls).toBe(stopped);
});

test('hidden pages pause polling and becoming visible resumes only one timer', async ({ page }) => {
  await api({ op: 'put', path: 'a.md', title: 'A', content: '# A\n' });
  let polls = 0;
  page.on('request', req => { if (req.url().endsWith('/api/v1/features/llm-wiki')) polls++; });
  await page.goto(`${origin}/wiki`);
  await expect(page.locator('#page-title')).toHaveText('A');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const paused = polls;
  await page.waitForTimeout(1800);
  expect(polls).toBe(paused);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect.poll(() => polls, { timeout: 3000 }).toBe(paused + 1);
  await page.waitForTimeout(1700);
  expect(polls).toBe(paused + 2);
});

test('navigation away stops the Wiki polling loop', async ({ page }) => {
  await api({ op: 'put', path: 'a.md', title: 'A', content: '# A\n' });
  let polls = 0;
  page.on('request', req => { if (req.url().endsWith('/api/v1/features/llm-wiki')) polls++; });
  await page.goto(`${origin}/wiki`);
  await expect(page.locator('#page-title')).toHaveText('A');
  await page.goto(`${origin}/settings`);
  await expect(page).toHaveURL(`${origin}/settings`);
  await page.waitForLoadState('networkidle');
  const stopped = polls;
  await page.waitForTimeout(1800);
  expect(polls).toBe(stopped);
});

test('disabling while editing keeps the unsaved text available', async ({ page }) => {
  let polls = 0;
  page.on('request', req => { if (req.url().endsWith('/api/v1/features/llm-wiki')) polls++; });
  await api({ op: 'put', path: 'a.md', title: 'A', content: '# A\n' });
  await page.goto(`${origin}/wiki`);
  await expect(page.locator('#page-title')).toHaveText('A');
  await page.locator('#edit-mode').click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('unsaved work');
  const response = await fetch(`${origin}/api/v1/features/llm-wiki`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-wiki-csrf': csrf }, body: JSON.stringify({ enabled: false }) });
  expect(response.ok).toBeTruthy();
  await expect(page.locator('#error')).toContainText('無効', { timeout: 6000 });
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('unsaved work');
  await expect(page.locator('#save-page')).toBeDisabled();
  const stopped = polls;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForTimeout(1800);
  expect(polls).toBe(stopped);
});
