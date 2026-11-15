import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const fixture of [
  { selected: "corpus-row", title: "Corpus title", preview: "Corpus content", tag: "auth" },
  { selected: "search-row", title: "Search title", preview: "Search content", tag: "profile-enrichment" },
  { selected: "profile-row", title: "Profile title", preview: "Profile content", tag: "auth" },
  { selected: "detail-row", title: "Detail title", preview: "Detail content", tag: "auth" }
]) {
  test(`uses the expected detail source for ${fixture.selected}`, async ({ page }) => {
    await page.goto(`/memories?tenant_id=default&project_id=r8b-detail-fixture&q=example&selected=${fixture.selected}&lang=en&advanced=1`);
    await expect(page).toHaveURL(/\/memories\?/u);
    await expect(page.locator(".memory-detail-title")).toHaveText(fixture.title);
    await expect(page.locator(".memory-detail-preview")).toHaveText(fixture.preview);
    await expect(page.locator("[data-memory-edit-form] input[name=tags]")).toHaveValue(new RegExp(fixture.tag, "u"));
  });
}

test("leaves detail empty when no candidate or usable detail exists", async ({ page }) => {
  await page.goto("/memories?tenant_id=default&project_id=r8b-detail-fixture&q=example&selected=missing-row&lang=en&advanced=1");
  await expect(page).toHaveURL(/\/memories\?/u);
  await expect(page.locator("[data-memory-edit-form]")).toHaveCount(0);
  await expect(page.locator(".memory-detail-preview")).toHaveCount(0);
});

test("restores scroll when a memory selection reloads the actual page", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 420 });
  await page.goto("/memories?tenant_id=default&project_id=org-brain&lang=en&advanced=1&view=all");
  await expect(page).toHaveURL(/\/memories\?/u);
  const link = page.locator("a.memory-list-row[href*='selected=']").first();
  await link.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 120));
  await page.evaluate(() => document.addEventListener("click", () => sessionStorage.setItem("r8b-test-click-scroll", String(scrollY)), { capture: true, once: true }));
  await link.click();
  await expect(page).toHaveURL(/selected=/u);
  const before = await page.evaluate(() => Number(sessionStorage.getItem("r8b-test-click-scroll")));
  expect(before).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(before);
});

for (const [width, locale] of [[320, "en"], [320, "ja"], [320, "zh"], [390, "en"], [768, "en"], [768, "ja"], [768, "zh"]] as const) {
  test(`keeps the actual detail page usable at ${width}px in ${locale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/memories?tenant_id=default&project_id=org-brain&selected=mem_auth_group_acl&lang=${locale}&advanced=1`);
    await expect(page).toHaveURL(/\/memories\?/u);
    await expect(page.locator("[data-memory-save]")).toBeVisible();
    const overflow = await page.evaluate(() => ({
      amount: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      elements: [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map((element) => ({ tag: element.tagName, className: element.className, text: element.textContent?.trim().slice(0, 100), parent: element.parentElement?.className, right: element.getBoundingClientRect().right }))
    }));
    expect(overflow.amount, JSON.stringify(overflow.elements.slice(0, 12))).toBe(0);
    expect(await page.locator("[data-memory-save]").evaluate((button) => button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    const nav = page.locator(".op-sidebar nav a");
    await expect(nav).toHaveCount(3);
    for (const link of await nav.all()) {
      await expect(link).toBeVisible();
      expect(await link.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    }
    await nav.first().focus();
    await page.keyboard.press("Tab");
    await expect(nav.nth(1)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(nav.nth(2)).toBeFocused();
    const editor = page.locator('[data-memory-edit-form] textarea[name="content"]');
    await editor.focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("[data-memory-save]")).toBeFocused();
    if (width === 320 && locale === "en") await page.screenshot({ path: testInfo.outputPath("memory-detail-320.png"), fullPage: true });
  });
}

for (const locale of ["en", "ja", "zh"]) {
  test(`audits the actual memory detail page in ${locale}`, async ({ page }) => {
    await page.goto(`/memories?tenant_id=default&project_id=org-brain&selected=mem_auth_group_acl&lang=${locale}&advanced=1`);
    await expect(page).toHaveURL(/\/memories\?/u);
    await expect(page.locator("[data-memory-edit-form]")).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) }))).toEqual([]);
  });
}
