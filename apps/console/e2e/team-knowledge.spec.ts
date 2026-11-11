import { expect, test } from "@playwright/test";

test.skip(process.env.CONSOLE_E2E_TEAM_KNOWLEDGE !== "1", "Run with the team-knowledge API fixture");

test("an approved All result can be opened and watched from ordinary knowledge search", async ({ page }) => {
  await page.goto("/?lang=ja&tenant_id=default");
  await expect(page.getByRole("heading", { name:"変更の受信箱" })).toBeVisible();
  await page.getByRole("link", { name:"知識", exact:true }).first().click();
  await page.getByLabel("知識を検索").fill("チーム戦略");
  await page.getByRole("button", { name:"検索", exact:true }).click();
  await page.getByRole("link", { name:/公開済みのチーム戦略/ }).click();
  await expect(page.getByText("全社公開された版")).toBeVisible();
  await expect(page.getByText("承認済みの本文")).toBeVisible();
  await page.getByRole("button", { name:"ウォッチする" }).click();
  await expect(page.getByRole("button", { name:"ウォッチを解除" })).toBeVisible();
});
