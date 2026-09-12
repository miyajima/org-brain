import { test, expect } from '@playwright/test';

const record = {
  id: '01K00000000000000000000000', candidate_id: 'candidate', candidate_hash: 'a'.repeat(64),
  label: 'accepted', answer: '保存する', save_state: 'saved', source_references: [{ ref: 'turn:1', role: 'user' }],
  original: { memory: { content: '元の方針', summary: '<img src=x onerror=alert(1)>', project_id: 'org-brain', external_key: null, tags: [] }, rationale: { conclusion: '元の方針', reason_summary: '未確認' } }, correction: null
};

test('review history renders text safely and recovers a lost save receipt without duplicate submission', async ({ page }) => {
  let proposals = 0; let confirmations = 0;
  await page.route('**/api/v1/memory-reviews?**', route => route.fulfill({ json: { ok: true, data: { items: [record], next_cursor: null } } }));
  await page.route('**/api/v1/memories/propose', route => {
    proposals++;
    expect(route.request().postDataJSON().item.external_key).toBe(`confirmation:${record.id}`);
    return route.fulfill({ json: { ok: true, data: { confirmation_token: 'token' } } });
  });
  await page.route('**/api/v1/memories/confirm', route => {
    confirmations++;
    const body = route.request().postDataJSON();
    expect(body.corrected_content).toBe('新しい方針\n理由: 互換性を維持するため');
    expect(body.review_answer).toMatch(/^修正: /);
    return route.abort('failed');
  });
  await page.route('**/api/v1/memories/confirmation-status', route => route.fulfill({ json: { ok: true, data: { saved: true, memory_id: 'memory' } } }));
  await page.goto('/reviews?tenant_id=default&project_id=org-brain&lang=ja');
  const root = page.locator('#memory-review-history');
  await expect(root.getByRole('heading', { name: '<img src=x onerror=alert(1)>' })).toBeVisible();
  await expect(root.locator('img')).toHaveCount(0);
  await root.getByRole('textbox').fill('新しい方針\n理由: 互換性を維持するため');
  await root.getByRole('button', { name: '訂正して保存' }).click();
  await expect(root.locator('#review-status')).not.toBeEmpty();
  await root.getByRole('button', { name: '訂正して保存' }).click();
  await expect(root.getByRole('textbox')).toBeDisabled();
  expect(proposals).toBe(1); expect(confirmations).toBe(1);
  await page.screenshot({ path: '/private/tmp/orgbrain-memory-review-history.png', fullPage: true });
});

test('export follows all review pages', async ({ page }) => {
  await page.route('**/api/v1/memory-reviews?**', route => route.fulfill({ json: { ok: true, data: new URL(route.request().url()).searchParams.has('cursor')
    ? { items: [{ ...record, id: 'second' }], next_cursor: null } : { items: [record], next_cursor: '1:01K00000000000000000000000' } } }));
  await page.goto('/reviews?tenant_id=default&project_id=org-brain&lang=ja');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '評価用JSONを出力' }).click();
  const stream = await (await download).createReadStream();
  const chunks = []; for await (const chunk of stream!) chunks.push(chunk);
  expect(JSON.parse(Buffer.concat(chunks).toString()).items).toHaveLength(2);
});
