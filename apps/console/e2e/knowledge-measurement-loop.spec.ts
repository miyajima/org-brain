import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("shows the post-onboarding measurement loop and its work locations", async ({ page }) => {
  await page.goto("/knowledge-dashboard?tenant_id=default&project_id=org-brain&lang=ja");
  await expect(page.getByRole("heading", { name: "判断と目標を、同じ場所で運用する" })).toBeVisible();
  await expect(page.getByText("Build成功率")).toBeVisible();
  await expect(page.getByText("91", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "ふりかえり" }).click();
  await expect(page.getByRole("heading", { name: "判断軸のふりかえり" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "定期実施を設定" })).toBeVisible();
  await expect(page.getByLabel("実施間隔")).toHaveValue("7");
  await expect(page.getByText(/14日ごと · active/)).toBeVisible();
  await page.getByRole("link", { name: /CI decision review/ }).click();
  await expect(page.getByText("Retry only infrastructure failures")).toBeVisible();
  await page.getByRole("radio", { name: "採用", exact: true }).check();
  await page.getByRole("button", { name: "この判断を保存" }).click();
  await expect(page.getByText("Retry only infrastructure failures")).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(accessibility.violations).toEqual([]);

  await page.goto("/improvement-actions?tenant_id=default&project_id=org-brain&lang=ja");
  await expect(page.getByRole("heading", { name: "改善アクション" })).toBeVisible();
  await expect(page.getByText("Stabilize CI")).toBeVisible();
  await expect(page.getByRole("link", { name: "外部Issueを開く ↗" })).toHaveAttribute("href", "https://github.com/example/repo/issues/1");
});
