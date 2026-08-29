import { expect, test } from "@playwright/test";
import { auditUrl } from "./route-audit-cases";

test.describe("keyboard-only administration flows", () => {
  test("skip link reaches the main content", async ({ page }) => {
    await page.goto(auditUrl("/overview"));
    await page.keyboard.press("Tab");
    await expect(page.locator(".console-skip-link")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#console-main")).toBeFocused();
  });

  test("a user invitation can be completed on one screen", async ({ page }) => {
    await page.goto(auditUrl("/users", "en"));
    const form = page.locator("#invite-user-title").locator("xpath=following::form[1]");
    await form.locator('input[name="email"]').fill("new.member@example.com");
    await form.locator('input[name="display_name"]').fill("New member");
    await form.locator('select[name="role"]').selectOption("reader");
    await form.locator('button[type="submit"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Confirm this change" })).toBeVisible();
    await page.getByRole("button", { name: "Apply change" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Invitation created.")).toBeVisible();
  });

  test("a failed task exposes cause, replay, and operations without a dead end", async ({ page }) => {
    await page.goto(auditUrl("/tasks/task-failed", "en"));
    await expect(page.locator("#replay-task")).toBeVisible();
    await expect(page.getByRole("link", { name: /operations/i })).toBeVisible();
    await page.locator("#replay-task").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#replay-result")).toContainText(/replayed|task/i);
  });

  test("secondary operations stay compact and remain keyboard reachable", async ({ page }) => {
    await page.goto(auditUrl("/operations", "en"));
    const details = page.locator("[data-operations-secondary]");
    const summary = details.locator(":scope > summary");
    await expect(details).not.toHaveAttribute("open", "");
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(1900);
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await expect(page.getByRole("heading", { name: "Scheduled jobs", exact: true })).toBeVisible();
    await summary.focus();
    await page.keyboard.press("Enter");
    const staleAction = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Scheduled jobs delayed" }) }).getByRole("link", { name: "Review details" });
    await staleAction.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#scheduled-jobs$/);
    await expect(details).toHaveAttribute("open", "");
    await expect(page.getByRole("heading", { name: "Scheduled jobs", exact: true })).toBeVisible();
  });

  test("history exposes current content, evidence, and comparison before analysis", async ({ page }) => {
    await page.goto(auditUrl("/decisions/history", "en"));
    const actions = page.locator(".history-primary-actions");
    await expect(actions.getByRole("link", { name: "Open current content" })).toBeVisible();
    await expect(actions.getByRole("link", { name: "Inspect evidence" })).toHaveAttribute("href", "#history-evidence");
    await expect(actions.getByRole("link", { name: "Compare revisions" })).toHaveAttribute("href", "#revision-history-title");
  });

  test("node search, selection, URL, and decision trace stay synchronized", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(auditUrl("/memories/constellation", "en"));
    const search = page.locator("[data-map-accessible-search]");
    await search.fill("decision");
    const node = page.locator("[data-map-accessible-node-id]").first();
    await node.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-map-search]")).toBeFocused();
    await expect(page.locator("[data-map-search-results]")).toBeHidden();
    await expect(page.locator("[data-map-selection-status]")).not.toBeEmpty();
    await expect(page.locator("[data-map-view-trace]")).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("selected")).not.toBeNull();
  });
});
