import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("shows the post-onboarding measurement loop and its work locations", async ({ page }) => {
  await page.goto("/knowledge-dashboard?tenant_id=default&project_id=org-brain&lang=ja");
  await expect(page).toHaveURL(/\/dashboard\/knowledge\?/u);
  await expect(page.getByRole("heading", { name: "判断と目標を、同じ場所で運用する" })).toBeVisible();
  await expect(page.getByText("Build成功率")).toBeVisible();
  await expect(page.getByText("91", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "ふりかえり" }).click();
  await expect(page.getByRole("heading", { name: "判断軸のふりかえり" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "定期実施を有効化" })).toBeVisible();
  await expect(page.getByLabel("実施間隔")).toHaveValue("7");
  await expect(page.getByText(/14 · 有効/)).toBeVisible();
  await page.getByRole("link", { name: /CI decision review/ }).click();
  await expect(page.getByText("Retry only infrastructure failures")).toBeVisible();
  await expect(page.getByRole("link", { name: /https:\/\/example.com\/evidence/ })).toHaveAttribute("href", "https://example.com/evidence");
  await expect(page.getByText("internal:evidence")).not.toHaveAttribute("href");
  await page.getByRole("radio", { name: "採用", exact: true }).check();
  await page.getByRole("button", { name: "この判断を保存" }).click();
  await expect(page.getByText("Retry only infrastructure failures")).toBeVisible();
  await page.getByRole("link", { name: "管理者として確定" }).click();
  await expect(page.getByText("回答済み").first()).toBeVisible();
  await page.getByLabel("結果を選択").selectOption("not_adopted");
  await page.getByLabel("未回答が残る状態で確定することを確認しました").check();
  await page.getByRole("button", { name: "結果を確定して閉じる" }).click();
  await expect(page).toHaveURL(/\/retrospectives\/retro-e2e\?/);
  await expect(page.getByText("Retry only infrastructure failures")).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(accessibility.violations).toEqual([]);

  await page.goto("/improvement-actions?tenant_id=default&project_id=org-brain&lang=ja");
  await expect(page.getByRole("heading", { name: "改善アクション" })).toBeVisible();
  await expect(page.getByText("Stabilize CI")).toBeVisible();
  await expect(page.getByText("基準値")).toBeVisible();
  await expect(page.getByRole("link", { name: "外部Issueを開く ↗" })).toHaveAttribute("href", "https://github.com/example/repo/issues/1");
});

test("keeps participant and admin retrospective controls hidden in read-only preview", async ({ page }) => {
  for (const suffix of ["", "/admin"]) {
    await page.goto(`/retrospectives/retro-e2e${suffix}?tenant_id=preview-readonly&lang=ja`);
    await expect(page.getByText("Retry only infrastructure failures")).toBeVisible();
    await expect(page.locator('button[type="submit"], input[type="radio"], select[name^="result:"], input[name="acknowledge_unanswered"]')).toHaveCount(0);
  }
});

test("keeps the Knowledge Loop usable at 390px in ja, en, and zh", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [lang, heading] of [
    ["ja", "判断と目標を、同じ場所で運用する"],
    ["en", "Operate decisions and goals in one place"],
    ["zh", "在同一处运营决策与目标"]
  ] as const) {
    await page.goto(`/dashboard/knowledge?tenant_id=default&project_id=org-brain&lang=${lang}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(accessibility.violations).toEqual([]);
  }
});


test("hides disabled features and explains direct access", async ({ page }) => {
  await page.goto("/profile?tenant_id=features-off&lang=en");
  await expect(page.locator('a[href*="/dashboard/knowledge"]')).toHaveCount(0);
  const response = await page.goto("/dashboard/knowledge?tenant_id=features-off&lang=en");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Feature unavailable" })).toBeVisible();
});

test("does not turn a failed dashboard into zero counts", async ({ page }) => {
  await page.goto("/dashboard/knowledge?tenant_id=dashboard-unavailable&lang=en");
  await expect(page.getByText("Dashboard unavailable", { exact: true })).toBeVisible();
  await expect(page.locator("article")).toHaveCount(0);
});
