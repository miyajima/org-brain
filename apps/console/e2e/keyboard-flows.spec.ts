import { expect, test } from "@playwright/test";
import { auditUrl } from "./route-audit-cases";

test.describe("keyboard-only administration flows", () => {
  test("skip link reaches the main content", async ({ page }) => {
    await page.goto(auditUrl("/overview"));
    await page.keyboard.press("Tab");
    await expect(page.locator(".op-skip")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  });

  test("a user invitation can be completed on one screen", async ({ page }) => {
    await page.goto(auditUrl("/users", "en"));
    const summary=page.getByText("Invite user",{exact:true});
    await summary.focus();await page.keyboard.press("Enter");
    const form=page.locator('[data-op-api-form][data-endpoint="/api/v1/users"]');
    await form.getByLabel("Email",{exact:true}).fill("new.member@example.com");
    await form.getByLabel("Display name").fill("New member");
    await form.getByLabel("Role",{exact:true}).selectOption("reader");
    await form.getByRole("button",{name:"Create invitation"}).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("button",{name:"Apply change"}).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({hasText:"Changes saved"})).toBeVisible();
  });

  test("a failed task exposes cause and replay in the same workspace", async ({ page }) => {
    await page.goto(auditUrl("/tasks/task-failed", "en"));
    await expect(page.getByRole("heading",{name:"Selected task"})).toBeVisible();
    const replay=page.getByRole("button",{name:"Replay task"});
    await expect(replay).toBeVisible();
    await replay.focus();await page.keyboard.press("Enter");
    await page.getByRole("dialog").getByRole("button",{name:"Apply change"}).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({hasText:"Changes saved"})).toBeVisible();
  });

  test("operations and scheduled processing remain keyboard reachable", async ({ page }) => {
    await page.goto(auditUrl("/settings", "en"));
    const operations=page.getByRole("navigation",{name:"Management sections"}).getByRole("link",{name:"Processing",exact:true});
    await operations.focus();await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/section=operations/u);
    expect(await page.evaluate(()=>document.documentElement.scrollHeight)).toBeLessThan(1900);
    await expect(page.getByRole("heading",{name:"Scheduled processing",exact:true})).toBeVisible();
    await expect(page.getByText("Update overdue",{exact:true}).first()).toBeVisible();
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
