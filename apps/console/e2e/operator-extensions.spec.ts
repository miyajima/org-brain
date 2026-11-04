import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const settings = (section: string, extra = "") => `/settings?tenant_id=default&project_id=org-brain&lang=ja&section=${section}${extra}`;

test("management previews and applies packs without leaving the workspace", async ({ page }) => {
  await page.goto(settings("packs"));
  await page.getByRole("button", { name: "導入差分を確認" }).click();
  await expect(page.locator("[data-pack-plan]")).toBeVisible();
  await page.getByRole("button", { name: "選択したパックを適用" }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  await expect(page).toHaveURL(/\/settings\?/);
});

test("management creates a derived metric and adds it to a dashboard", async ({ page }) => {
  await page.goto(settings("metrics"));
  await page.getByLabel("指標キー", { exact: true }).fill("operator_quality_rate");
  await page.getByLabel("表示名", { exact: true }).fill("Operator quality rate");
  await page.getByLabel("データの取得方法").selectOption("derived");
  await page.getByLabel("計算に使う指標キー（カンマ区切り）").fill("qualified_activated_users,new_users");
  await page.getByRole("button", { name: "カスタム指標を作成" }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  await expect(page.getByText("operator_quality_rate", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Dashboardへ追加" }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
});

test("retrospective participation and finalization stay in management", async ({ page }) => {
  await page.goto(settings("retrospectives"));
  await page.getByRole("link", { name: /CI decision review/ }).click();
  await expect(page.getByText("Retry only infrastructure failures", { exact: true }).first()).toBeVisible();
  await page.getByRole("radio", { name: "採用", exact: true }).check();
  await page.getByRole("button", { name: "この判断を保存" }).click();
  await expect(page.getByRole("status")).toContainText("保存");
  await page.getByLabel("結果を選択").selectOption("not_adopted");
  await page.getByLabel("未回答が残る状態で確定することを確認しました").check();
  await page.getByRole("button", { name: "結果を確定して閉じる" }).click();
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible()) await dialog.getByRole("button", { name: "変更を適用" }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  await expect(page).toHaveURL(/section=retrospectives/);
});

test("improvements preserve allowed transitions and creation", async ({ page }) => {
  await page.goto(settings("improvements"));
  await expect(page.getByText("Stabilize CI", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "最新値で改善を判定" })).toHaveCount(0);
  await page.getByLabel("改善内容", { exact: true }).fill("Operator improvement");
  await page.getByRole("button", { name: "アクションを追加" }).click();
  await expect(page.getByRole("status")).toBeVisible();
  await page.getByRole("button", { name: "実装完了・再計測待ち" }).click();
  await expect(page.getByRole("status")).toBeVisible();
});

test("read-only retrospective and improvement panels do not expose writes", async ({ page }) => {
  for (const section of ["retrospectives", "improvements"]) {
    await page.goto(`/settings?tenant_id=preview-readonly&lang=en&section=${section}${section === "retrospectives" ? "&id=retro-e2e" : ""}`);
    await expect(page.locator("[data-extension-workspace] form[method=post]")).toHaveCount(0);
  }
});

test("retrospective scheduling and creation keep their scoped workflow", async ({ page }) => {
  const submissions: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && request.url().includes("/settings?")) submissions.push(new URLSearchParams(request.postData() ?? "").get("action") ?? "");
  });
  await page.goto(settings("retrospectives"));
  const schedule = page.locator("form", { has: page.locator('[name="action"][value="schedule"]') });
  await schedule.getByLabel("実施間隔").selectOption("14");
  await schedule.getByRole("button").click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  await page.reload();
  expect(submissions.filter(action => action === "schedule")).toHaveLength(1);
  const start = page.locator("form", { has: page.locator('[name="action"][value="start"]') });
  await start.getByLabel("タイトル", { exact: true }).fill("Scoped review");
  await start.getByRole("button").click();
  await expect(page.getByText("Retry only infrastructure failures", { exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(/project_id=org-brain/);
  await page.reload();
  expect(submissions.filter(action => action === "start")).toHaveLength(1);
});

test("finalization retries reuse the same key until the result changes", async ({ page }) => {
  const keys: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && request.url().includes("/settings?")) {
      const body = new URLSearchParams(request.postData() ?? "");
      if (body.get("action") === "close") keys.push(body.get("idempotency_key") ?? "");
    }
  });
  await page.goto(settings("retrospectives", "&id=retro-e2e"));
  for (const decision of ["adopted", "adopted", "deferred"]) {
    await page.getByLabel("結果を選択").selectOption(decision);
    await page.getByLabel("未回答が残る状態で確定することを確認しました").check();
    await page.getByRole("button", { name: "結果を確定して閉じる" }).click();
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.getByRole("dialog").getByRole("button", { name: "変更を適用" }).click()
    ]);
    await expect(page.getByRole("status")).toContainText("保存しました");
  }
  expect(keys).toHaveLength(3);
  expect(keys[0]).not.toBe("");
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[1]);
});

test("extension workspaces remain readable at 390px in every supported language", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const lang of ["ja", "en", "zh"]) {
    for (const section of ["packs", "metrics", "retrospectives", "improvements"]) {
      await page.goto(`/settings?tenant_id=default&project_id=org-brain&lang=${lang}&section=${section}`);
      await expect(page.locator(`[data-extension-workspace="${section}"]`)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const result = await new AxeBuilder({ page }).include("[data-extension-workspace]").analyze();
      expect(result.violations.filter(item => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
    }
  }
});

const scopedSettings = (section:string, project = "org-brain", extra = "") => `/settings?tenant_id=operator-scope&project_id=${project}&lang=ja&section=${section}${extra}`;

test("project scope filters sessions, schedules, and improvements while organization scope shows both projects", async ({page}) => {
  await page.goto(scopedSettings("retrospectives"));
  await expect(page.getByRole("link", {name:"CI decision review"})).toBeVisible();
  await expect(page.getByRole("link", {name:"Other project review"})).toHaveCount(0);
  await expect(page.locator("[data-extension-workspace] p", {hasText:/^7 · 有効/})).toHaveCount(0);
  await page.goto(scopedSettings("improvements"));
  await expect(page.getByRole("heading", {name:"Stabilize CI",exact:true})).toBeVisible();
  await expect(page.getByRole("heading", {name:"Other project action",exact:true})).toHaveCount(0);
  await page.goto(scopedSettings("retrospectives", ""));
  await expect(page.getByRole("link", {name:"Other project review"})).toBeVisible();
  await page.goto(scopedSettings("improvements", ""));
  await expect(page.getByRole("heading", {name:"Other project action",exact:true})).toBeVisible();
});

test("direct selections from another project do not reveal detail or mutation controls", async ({page}) => {
  await page.goto(scopedSettings("retrospectives", "org-brain", "&id=retro-other"));
  await expect(page.getByRole("alert")).toContainText("選択中のプロジェクトの対象ではありません");
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByLabel("結果を選択")).toHaveCount(0);
  await page.goto(scopedSettings("improvements", "org-brain", "&id=action-other"));
  await expect(page.getByRole("alert")).toContainText("選択中のプロジェクトの対象ではありません");
  await expect(page.getByRole("heading", {name:"Other project action",exact:true})).toHaveCount(0);
  await page.goto(scopedSettings("improvements", "org-brain", "&retrospective_session_id=retro-other&retrospective_item_id=retro-item-e2e"));
  await expect(page.getByRole("alert")).toContainText("選択中のプロジェクトの対象ではありません");
  await expect(page.getByRole("button", {name:"アクションを追加"})).toHaveCount(0);
});

test("cross-project native POST targets are rejected before mutation", async ({page}) => {
  for (const [section,fields] of [
    ["improvements",{action:"status",id:"action-other",status:"awaiting_verification"}],
    ["improvements",{action:"verify",id:"action-other"}],
    ["improvements",{action:"create",title:"Foreign source",retrospective_session_id:"retro-other",retrospective_item_id:"retro-item-e2e"}],
    ["retrospectives",{action:"response",session_id:"retro-other",item_id:"retro-item-e2e",decision:"adopt",note:"wrong scope"}],
    ["retrospectives",{action:"close",session_id:"retro-other",idempotency_key:"scope-test", "result:retro-item-e2e":"adopted",acknowledge_unanswered:"on"}]
  ] as const) {
    await page.goto(scopedSettings(section));
    await Promise.all([
      page.waitForNavigation({waitUntil:"domcontentloaded"}),
      page.evaluate(fields=>{
        const form=document.createElement("form");form.method="post";
        for(const [name,value] of Object.entries({...fields,csrf_token:sessionStorage.getItem("orgbrain_csrf") ?? ""})) {
          const input=document.createElement("input");input.type="hidden";input.name=name;input.value=value;form.append(input);
        }
        document.body.append(form);form.submit();
      }, fields)
    ]);
    await expect(page.getByRole("alert")).toContainText("選択中のプロジェクトの対象ではありません");
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page).not.toHaveURL(/saved=1/);
  }
});
