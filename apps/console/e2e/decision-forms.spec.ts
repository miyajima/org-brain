import { expect, test } from "@playwright/test";

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
