import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const createUrl = "/decisions?tenant_id=default&project_id=org-brain&lang=en&mode=create&view=editor&advanced=1";
const editUrl = "/decisions?tenant_id=default&project_id=org-brain&lang=en&selected=decision-e2e&view=editor&advanced=1";

for (const action of ["create", "revise", "confirm"] as const) {
  test(`sends the session CSRF token with decision ${action}`, async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem("orgbrain_csrf", "test-csrf"));
    const path = action === "create" ? "decision-memories" : `decision-memories/decision-e2e/${action}`;
    await page.route(`**/api/v1/${path}*`, (route) => route.fulfill({ status: 403, json: { ok: false, error: { message: "rejected" } } }));
    await page.goto(action === "create" ? createUrl : editUrl);
    await expect(page).toHaveURL(/\/decisions\?/u);
    const form = page.locator(`#decision-${action}-form`);
    await expect(form).toBeVisible();
    if (action === "create") {
      await form.locator('[name="title"]').fill("A decision");
      await form.locator('[name="decision"]').fill("Choose this option");
      await form.locator('[name="rationale"]').fill("It is verified");
    }
    const request = page.waitForRequest(`**/api/v1/${path}*`);
    await form.locator('button[type="submit"]').click();
    expect((await request).headers()["x-csrf-token"]).toBe("test-csrf");
  });
}

test("creates a decision with structured references and opens its editor", async ({ page }) => {
  await page.goto(createUrl);
  await expect(page).toHaveURL(/\/decisions\?/u);
  const form = page.locator("#decision-create-form");
  await form.locator('[name="title"]').fill("New decision");
  await form.locator('[name="decision"]').fill("Use a tested route");
  await form.locator('[name="rationale"]').fill("It preserves the contract");
  await expect(form.locator("[data-form-status]")).toHaveAttribute("data-tone", "pending");
  const source = form.locator('[data-ref-list="sourceRefs"] [data-ref-row]').first();
  await source.locator('[data-ref-field="id"]').fill("doc-1");
  await source.locator('[data-ref-field="url"]').fill("https://example.com/evidence");
  await source.locator('[data-ref-field="updatedAt"]').fill("2024-02-29");
  const requestPromise = page.waitForRequest("**/api/v1/decision-memories");
  await page.route("**/api/v1/decision-memories", (route) => route.fulfill({ json: { ok: true, data: { decisionMemory: { id: "decision-e2e", tenantId: "default", projectId: "org-brain" } } } }));
  await form.locator('button[type="submit"]').click();
  const body = (await requestPromise).postDataJSON();
  expect(body).toMatchObject({ title: "New decision", decision: "Use a tested route", sourceRefs: [{ id: "doc-1", url: "https://example.com/evidence", updatedAt: "2024-02-29" }] });
  await expect(page).toHaveURL(/selected=decision-e2e/u);
  expect(new URL(page.url()).searchParams.get("view")).toBe("editor");
  await expect(page.locator("#decision-revise-form")).toBeVisible();
});

test("revises Tokyo local dates and reloads the same decision URL", async ({ page }) => {
  await page.goto(editUrl);
  const form = page.locator("#decision-revise-form");
  await expect(form).toBeVisible();
  await form.locator('[name="validFrom"]').fill("2024-02-29T12:30");
  await form.locator('[name="validUntil"]').fill("2024-03-01T00:00");
  await expect(form.locator("[data-form-status]")).toHaveAttribute("data-tone", "pending");
  await page.route("**/api/v1/decision-memories/decision-e2e/revise?**", (route) => route.fulfill({ json: { ok: true } }));
  const request = page.waitForRequest("**/api/v1/decision-memories/decision-e2e/revise?**");
  const reload = page.waitForEvent("load");
  await form.locator('button[type="submit"]').click();
  expect((await request).postDataJSON()).toMatchObject({ validFrom: "2024-02-29T03:30:00.000Z", validUntil: "2024-02-29T15:00:00.000Z" });
  await reload;
  await expect(page).toHaveURL(/selected=decision-e2e.*view=editor/u);
  await expect(page.locator("#decision-revise-form")).toBeVisible();
});

test("confirms a decision and reloads the same decision URL", async ({ page }) => {
  await page.goto(editUrl);
  const form = page.locator("#decision-confirm-form");
  await expect(form).toBeVisible();
  await form.locator('[name="confirmationNote"]').fill("Reviewed against the evidence");
  await expect(form.locator("[data-form-status]")).toHaveAttribute("data-tone", "pending");
  await page.route("**/api/v1/decision-memories/decision-e2e/confirm?**", (route) => route.fulfill({ json: { ok: true } }));
  const request = page.waitForRequest("**/api/v1/decision-memories/decision-e2e/confirm?**");
  const reload = page.waitForEvent("load");
  await form.locator('button[type="submit"]').click();
  expect((await request).postDataJSON()).toMatchObject({ confirmationNote: "Reviewed against the evidence" });
  await reload;
  await expect(page).toHaveURL(/selected=decision-e2e.*view=editor/u);
  await expect(page.locator("#decision-confirm-form")).toBeVisible();
});

test("validates and adds, removes, and resets source references", async ({ page }) => {
  await page.goto(createUrl);
  const form = page.locator("#decision-create-form");
  await form.locator('[name="title"]').fill("Title");
  await form.locator('[name="decision"]').fill("Decision");
  await form.locator('[name="rationale"]').fill("Reason");
  const list = form.locator('[data-ref-list="sourceRefs"]');
  const rows = list.locator("[data-ref-row]");
  await rows.first().locator('[data-ref-field="url"]').fill("not a URL");
  await form.locator('button[type="submit"]').click();
  await expect(rows.first().locator("[data-row-error]")).toHaveText("Enter a valid URL.");
  await form.locator('[data-add-row="sourceRefs"]').click();
  await expect(rows).toHaveCount(2);
  await rows.last().locator('[data-ref-field="id"]').fill("new-source");
  await rows.last().locator("[data-remove-row]").click();
  await expect(rows).toHaveCount(1);
  await rows.first().locator("[data-remove-row]").click();
  await expect(rows.first().locator('[data-ref-field="url"]')).toHaveValue("");
  await expect(rows.first().locator("[data-row-error]")).toHaveText("");
});

test("marks a revision dirty when reference rows are added or reset", async ({ page }) => {
  await page.goto(editUrl);
  let form = page.locator("#decision-revise-form");
  await form.locator('[data-add-row="sourceRefs"]').click();
  await expect(form.locator("[data-form-status]")).toHaveText("Unsaved changes.");
  await page.reload();
  form = page.locator("#decision-revise-form");
  const row = form.locator('[data-ref-list="sourceRefs"] [data-ref-row]').first();
  await expect(row.locator('[data-ref-field="id"]')).toHaveValue("resource-e2e");
  await row.locator("[data-remove-row]").click();
  await expect(row.locator('[data-ref-field="id"]')).toHaveValue("");
  await expect(form.locator("[data-form-status]")).toHaveText("Unsaved changes.");
});

test("does not apply a late revision response after the page exits", async ({ page }) => {
  let release!: () => void;
  let intercepted!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { intercepted = resolve; });
  await page.route("**/api/v1/decision-memories/decision-e2e/revise?**", async (route) => {
    intercepted();
    await pending;
    await route.fulfill({ json: { ok: false, error: { message: "late response" } } });
  });
  await page.goto(editUrl);
  const form = page.locator("#decision-revise-form");
  await form.locator('button[type="submit"]').click();
  await started;
  await expect(form.locator("[data-form-status]")).toHaveText("Saving revision.");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
  await expect(form.locator('button[type="submit"]')).toBeEnabled();
  const response = page.waitForResponse("**/api/v1/decision-memories/decision-e2e/revise?**");
  release();
  await response;
  await page.waitForTimeout(100);
  await expect(form.locator("[data-form-status]")).toHaveText("Saving revision.");
});

test("recovers the pending button when a revision fails", async ({ page }) => {
  let release!: () => void;
  let intercepted!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { intercepted = resolve; });
  await page.route("**/api/v1/decision-memories/decision-e2e/revise?**", async (route) => {
    intercepted();
    await pending;
    await route.fulfill({ status: 503, json: { ok: false, error: { message: "Unavailable" } } });
  });
  await page.goto(editUrl);
  const form = page.locator("#decision-revise-form");
  const button = form.locator('button[type="submit"]');
  await button.click();
  await started;
  await expect(button).toBeDisabled();
  await expect(form.locator("[data-form-status]")).toHaveText("Saving revision.");
  release();
  await expect(form.locator("[data-form-status]")).toHaveText("Unavailable");
  await expect(form.locator("[data-form-status]")).toHaveAttribute("data-tone", "error");
  await expect(button).toBeEnabled();
});

test("remounts once and retains controls after a cached-page return", async ({ page }) => {
  await page.goto(createUrl);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
  const mount = () => page.evaluateHandle(async () => {
    const moduleUrl = "/src/lib/decision-page-controller.ts";
    const { mountDecisionPage } = await import(/* @vite-ignore */ moduleUrl);
    return mountDecisionPage(document.querySelector<HTMLElement>("[data-decision-page]")!);
  });
  const first = await mount();
  await first.evaluate((dispose: () => void) => { dispose(); dispose(); });
  const second = await mount();
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  const form = page.locator("#decision-create-form");
  await form.locator('[data-add-row="sourceRefs"]').click();
  await expect(form.locator('[data-ref-list="sourceRefs"] [data-ref-row]')).toHaveCount(2);
  await second.evaluate((dispose: () => void) => dispose());
});

for (const width of [320, 390, 768]) {
  test(`keeps legacy decision forms keyboard usable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(createUrl);
    await expect(page).toHaveURL(/\/decisions\?/u);
    const create = page.locator("#decision-create-form");
    await expect(create).toBeVisible();
    const overflow = await page.evaluate(() => ({
      amount: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      elements: [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map((element) => ({ tag: element.tagName, className: element.className, text: element.textContent?.trim().slice(0, 60), right: element.getBoundingClientRect().right }))
    }));
    expect(overflow.amount, JSON.stringify(overflow.elements.slice(0, 12))).toBe(0);
    const title = create.locator('[name="title"]');
    await title.focus();
    await page.keyboard.type("Keyboard decision");
    await expect(title).toHaveValue("Keyboard decision");
    await page.keyboard.press("Tab");
    await expect(create.locator('[name="confidence"]')).toBeFocused();
    await page.goto(editUrl);
    for (const id of ["revise", "confirm"]) {
      const form = page.locator(`#decision-${id}-form`);
      await expect(form).toBeVisible();
      expect(await form.locator('button[type="submit"]').evaluate((button) => button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      const outside = await form.locator('input:not([type="hidden"]), select, textarea, .structured-list, [data-form-status]').evaluateAll((elements) => elements.flatMap((element) => {
        const box = element.getBoundingClientRect();
        const card = element.closest(".card")?.getBoundingClientRect();
        if (!card || box.width === 0 || box.height === 0 || (box.left >= card.left - 1 && box.right <= card.right + 1)) return [];
        return [{ tag: element.tagName, name: element.getAttribute("name"), className: element.className, left: box.left, right: box.right, cardLeft: card.left, cardRight: card.right }];
      }));
      const geometry = await form.evaluate((element) => {
        const card = element.closest(".card")!;
        const style = getComputedStyle(element);
        return { form: element.getBoundingClientRect().toJSON(), card: card.getBoundingClientRect().toJSON(), minWidth: style.minWidth, grid: style.gridTemplateColumns };
      });
      expect(outside, JSON.stringify(geometry)).toEqual([]);
      const note = form.locator(id === "revise" ? '[name="note"]' : '[name="confirmationNote"]');
      await note.focus();
      await page.keyboard.type("Keyboard review");
      await page.keyboard.press("Tab");
      await expect(form.locator('button[type="submit"]')).toBeFocused();
    }
    const editOverflow = await page.evaluate(() => ({
      amount: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      elements: [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map((element) => ({ tag: element.tagName, className: element.className, text: element.textContent?.trim().slice(0, 60), right: element.getBoundingClientRect().right }))
    }));
    expect(editOverflow.amount, JSON.stringify(editOverflow.elements.slice(0, 12))).toBe(0);
    if (width === 320) await page.screenshot({ path: testInfo.outputPath("decision-editor-320.png"), fullPage: true });
  });
}

for (const [name, url] of [["create", createUrl], ["editor", editUrl]] as const) {
  for (const locale of ["en", "ja", "zh"]) test(`audits the actual legacy decision ${name} page in ${locale}`, async ({ page }) => {
    await page.goto(url.replace("lang=en", `lang=${locale}`));
    await expect(page).toHaveURL(/\/decisions\?/u);
    await expect(page.locator(name === "create" ? "#decision-create-form" : "#decision-revise-form")).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) }))).toEqual([]);
  });
}
