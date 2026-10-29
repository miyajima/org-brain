import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

test("three destinations lead from overview to a scoped knowledge record", async ({ page }) => {
  await page.goto("/?lang=ja&tenant_id=default&project_id=org-brain");
  const navigation = page.getByRole("navigation", { name: "メインナビゲーション" });
  await expect(navigation.getByRole("link")).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "知識の状態を、ひと目で。" })).toBeVisible();
  await navigation.getByRole("link", { name: "知識", exact: true }).click();
  await expect(page).toHaveURL(/project_id=org-brain/);
  await page.getByLabel("知識を検索").fill("Cloudflare");
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await page.locator("[data-knowledge-row]").first().click();
  await expect(page.locator("[data-knowledge-detail]")).toBeVisible();
  await expect(page.getByRole("link", { name: "根拠", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "活用履歴", exact: true }).click();
  await expect(page.getByRole("heading", { name: "活用履歴", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("知識を検索")).toHaveValue("Cloudflare");
});

test("failed statistics remain unavailable and do not conceal usable sections", async ({ page }) => {
  await page.goto("/?lang=ja&project_id=e2e-analytics-error");
  await expect(page.locator("[data-usage-metrics]")).toContainText("取得できません");
  await expect(page.getByRole("heading", { name: "最近の動き" })).toBeVisible();
});

test("management and knowledge remain usable on mobile and with a keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings?lang=ja");
  await expect(page.getByRole("heading", { name: "管理", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "ユーザー", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ユーザー", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter(v => ["critical", "serious"].includes(v.impact ?? ""))).toEqual([]);
});

test("a conflicting edit keeps input and never changes verification implicitly", async ({ page }) => {
  let submissions = 0;
  await page.route("**/api/v1/memories/revise", async route => {
    submissions++;
    expect(route.request().postDataJSON()).not.toHaveProperty("verification_state");
    await route.fulfill({ status: 409, json: { ok:false } });
  });
  await page.goto("/knowledge?lang=ja&kind=memory&id=mem_auth_group_acl");
  await page.getByText("内容を修正", {exact:true}).click();
  await page.getByLabel("本文", {exact:true}).fill("Reviewed input stays here.");
  await page.getByRole("button", { name: "変更を保存", exact:true }).click();
  await expect(page.locator('[data-op-api-form][data-endpoint="/api/v1/memories/revise"] [data-form-status]')).toContainText("競合");
  await expect(page.getByLabel("本文", {exact:true})).toHaveValue("Reviewed input stays here.");
  expect(submissions).toBe(1);
});

test("confirmation requires a fresh explicit approval on every change", async ({page}) => {
  let writes=0;
  await page.route("**/api/v1/users/**", async route => { writes++; await route.fulfill({status:409,json:{ok:false}}); });
  await page.goto("/settings?section=users&lang=ja");
  await page.locator("details.op-disclosure").first().locator("summary").click();
  const first = page.locator("[data-op-api-form]").first();
  await first.getByRole("button",{name:"変更を保存"}).click();
  await page.getByRole("dialog").getByRole("button",{name:"変更を適用"}).click();
  await expect(first.locator("[data-form-status]")).toContainText("競合");
  await first.getByRole("button",{name:"変更を保存"}).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(writes).toBe(1);
});

test("usage stages are reported individually, and legacy bookmarks retain the record", async ({page}) => {
  await page.goto("/memories?selected=mem_auth_group_acl&tenant_id=default&lang=ja");
  await expect(page).toHaveURL(/\/knowledge\?/);
  await page.getByRole("link",{name:"活用履歴",exact:true}).click();
  await expect(page.locator(".op-stages")).toContainText("採用: 記録あり");
  await expect(page.locator(".op-stages")).toContainText("実行: 未確認");
  await expect(page.locator(".op-stages")).toContainText("結果確認: 未確認");
});

test("group removal verifies impact before an explicit change", async ({page}) => {
  let changes=0;
  await page.route("**/api/v1/groups/group-e2e/members/user%3Amember?**", async route=>{
    expect(route.request().headers()["if-match"]).toBe("e2e-impact-digest");
    changes++; await route.fulfill({json:{ok:true,data:{updated:true}}});
  });
  await page.goto("/settings?section=groups&id=group-e2e&lang=ja");
  const owner=page.locator("details.op-disclosure").filter({has:page.locator("summary",{hasText:"E2E Login User"})});
  await owner.locator(":scope > summary").click();
  await expect(owner.getByRole("button")).toHaveCount(0);
  const member=page.locator("details.op-disclosure").filter({has:page.locator("summary",{hasText:"E2E Member"})});
  await member.locator(":scope > summary").click();
  await member.getByRole("button",{name:"削除の影響を確認"}).click();
  await expect(page.getByRole("dialog")).toContainText("2件へのアクセスを失い");
  expect(changes).toBe(0);
  await page.getByRole("dialog").getByRole("button",{name:"変更を適用"}).click();
  await expect(page.getByRole("status").first()).toContainText("保存しました");
  expect(changes).toBe(1);
});

test("agent context preview does not record use",async({page})=>{
  let previews=0;
  await page.route("**/api/v1/agents/agent-e2e/context-preview?**",async route=>{
    expect(route.request().postDataJSON().record_usage).toBe(false);previews++;
    await route.fulfill({json:{ok:true,data:{injected_skills:[{name:"Reviewed skill",content:"Reviewed content"}],on_demand_skills:[],omitted:[],disabled:false}}});
  });
  await page.goto("/settings?section=agents&id=agent-e2e&lang=ja");
  await page.getByText("AIに渡される内容を事前確認",{exact:true}).click();
  await page.getByLabel("実行する仕事の内容",{exact:true}).fill("Review release");
  await page.getByRole("button",{name:"渡される内容を確認"}).click();
  await expect(page.locator("[data-preview-result]")).toContainText("Reviewed content");
  expect(previews).toBe(1);
});

test("read-only identity exposes no mutations, including through a direct link",async({page})=>{
  await page.goto("/knowledge?tenant_id=reader-e2e&kind=memory&id=mem_auth_group_acl&lang=ja");
  await expect(page.getByRole("heading",{name:"内容",exact:true})).toBeVisible();
  await expect(page.locator("[data-op-api-form]")).toHaveCount(0);
  await page.goto("/settings?tenant_id=reader-e2e&section=users&lang=ja");
  await expect(page.getByRole("alert")).toContainText("利用できません");
  await expect(page.locator("[data-op-api-form]")).toHaveCount(0);
});

test("inventory pagination and direct bookmarks reach records beyond the first page",async({page})=>{
 await page.goto("/settings?tenant_id=inventory-e2e&section=agents&lang=en");
 await expect(page.getByRole("link",{name:/Agent 26/u})).toHaveCount(0);
 await page.getByRole("navigation",{name:"Inventory pages"}).getByRole("link",{name:"Next",exact:true}).click();
 await page.getByRole("link",{name:/Agent 26/u}).click();
 await expect(page.getByRole("heading",{name:"Agent 26",exact:true})).toBeVisible();
 await page.goto("/settings?tenant_id=inventory-e2e&section=skills&id=skill-31&lang=en");
 await expect(page.getByRole("heading",{name:"Skill 31",exact:true})).toBeVisible();
 await expect(page.getByRole("link",{name:"Export skill"})).toHaveAttribute("href",/\/api\/v1\/skills\/skill-31\/export/u);
 await page.getByText("Skill access",{exact:true}).click();
 await expect(page.getByLabel("Access scope",{exact:true})).toBeVisible();
});

test("loadout save preserves bindings outside the catalog, their pinned versions and expiry",async({page})=>{
 let payload:Record<string,any>|null=null;
 await page.route("**/api/v1/agents/agent-e2e/loadouts/loadout-e2e?**",async route=>{payload=route.request().postDataJSON();await route.fulfill({status:409,json:{ok:false}});});
 await page.goto("/settings?tenant_id=loadout-preservation-e2e&section=agents&id=agent-e2e&lang=en");
 await page.getByText("Edit assigned skills and priority",{exact:true}).click();
 await page.getByLabel("Loadout name",{exact:true}).fill("Renamed only");
 await page.getByRole("button",{name:"Save delivery settings",exact:true}).click();
 await expect(page.locator('[data-form-kind="loadout"] [data-form-status]')).toContainText("conflicts");
 expect(payload).toMatchObject({name:"Renamed only",bindings:expect.arrayContaining([{skill_asset_id:"skill-outside-catalog",usage_mode:"on_demand",priority:17,version_policy:"pinned",pinned_version_id:"older-pinned-version",valid_until:7000000000000}])});
 expect((payload as any).bindings).toHaveLength(2);
 await page.goto("/settings?tenant_id=partial-bindings-e2e&section=agents&id=agent-e2e&lang=en");
 await expect(page.locator('[data-form-kind="loadout"]')).toHaveCount(0);
 await expect(page.getByText(/Replacement is unavailable/u)).toBeVisible();
});

test("skill generation keeps the same idempotency key for a retry and reports acceptance only",async({page})=>{
 const keys:string[]=[];
 await page.route("**/api/v1/skills/generate",async route=>{
   const body=route.request().postDataJSON();
   expect(body.sources).toEqual([{source_type:"decision_memory",source_id:"decision-console-e2e",version_hash:"e2e-source-hash"}]);
   keys.push(route.request().headers()["x-idempotency-key"]);
   expect(body.idempotency_key).toBe(keys.at(-1));
   await route.fulfill(keys.length===1?{status:503,json:{ok:false}}:{status:202,json:{ok:true,data:{task_id:"task-e2e",asset_id:"skill-e2e"}}});
 });
 await page.goto("/settings?section=skills&decision_id=decision-console-e2e&lang=ja");
 await page.getByLabel("作業手順に含める内容",{exact:true}).fill("Use only the selected decision.");
 await page.getByLabel("利用するモデル",{exact:true}).fill("fixture-model");
 const button=page.getByRole("button",{name:"非公開の下書きを生成"});
 await button.click();
 await expect(page.locator("[data-form-status]").first()).toContainText("503");
 await button.click();
 await expect(page.locator("[data-generation-result]")).toBeVisible();
 await expect(page.locator("[data-form-status]").first()).toContainText("受け付けました");
 expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);
});

test("goal observations preserve fractional values, scope and retry identity",async({page})=>{
 const bodies:Record<string,unknown>[]=[],keys:string[]=[];
 await page.route("**/api/v1/dashboard/organization/knowledge-packs/installation-e2e/goals/goal-link-e2e/snapshots",async route=>{
   bodies.push(route.request().postDataJSON());keys.push(route.request().headers()["x-idempotency-key"]);
   await route.fulfill({status:503,json:{ok:false}});
 });
 await page.goto("/?lang=en&tenant_id=default&project_id=org-brain");
 const goal=page.locator("#goal-goal-link-e2e");
 await expect(goal).toContainText("91");
 await goal.getByText("Record an observation",{exact:true}).click();
 await goal.getByLabel("Observed value",{exact:true}).fill("91.25");
 await goal.getByRole("button",{name:"Save observation"}).click();
 await expect(goal.locator("[data-form-status]")).toContainText("503");
 await expect(goal.getByLabel("Observed value",{exact:true})).toHaveValue("91.25");
 await goal.getByRole("button",{name:"Save observation"}).click();
 await expect.poll(()=>bodies.length).toBe(2);
 expect(bodies[0]).toMatchObject({tenant_id:"default",value:91.25,evidence_ref:null});
 expect(keys[0]).toBeTruthy();expect(keys[1]).toBe(keys[0]);
 await page.goto("/?lang=en&tenant_id=preview-readonly&project_id=org-brain");
 await expect(page.locator("#goal-goal-link-e2e [data-op-api-form]")).toHaveCount(0);
});

test("new screens render at supported sizes and preserve locale",async({page})=>{
  const directory=path.resolve("../../.impeccable/review");await mkdir(directory,{recursive:true});
  const captures=[
    ["desktop",1440,900,"/?lang=ja"],["mobile",390,844,"/?lang=ja"],
    ["knowledge-desktop",1440,900,"/knowledge?lang=ja&kind=memory&id=mem_auth_group_acl&tab=evidence"],
    ["knowledge-mobile",390,844,"/knowledge?lang=ja&kind=memory&id=mem_auth_group_acl"],
    ["settings-desktop",1440,900,"/settings?lang=ja&section=users"],
    ["settings-mobile",390,844,"/settings?lang=ja&section=users"],
    ["agent-desktop",1440,900,"/settings?lang=ja&section=agents&id=agent-e2e&tenant_id=loadout-preservation-e2e"],
    ["agent-mobile",390,844,"/settings?lang=ja&section=agents&id=agent-e2e&tenant_id=loadout-preservation-e2e"],
    ["goals-desktop",1440,900,"/?lang=ja&project_id=org-brain"],
    ["packs-desktop",1440,900,"/settings?lang=ja&section=packs&project_id=org-brain"],
    ["metrics-desktop",1440,900,"/settings?lang=ja&section=metrics&project_id=org-brain"],
    ["retrospectives-desktop",1440,900,"/settings?lang=ja&section=retrospectives&id=retro-e2e&project_id=org-brain"],
    ["retrospectives-mobile",390,844,"/settings?lang=ja&section=retrospectives&id=retro-e2e&project_id=org-brain"],
    ["improvements-desktop",1440,900,"/settings?lang=ja&section=improvements&project_id=org-brain"],
    ["domain-workspace-desktop",1440,900,"/domain-workspaces/function.build-engineering?tenant_id=workspace-demo&lang=ja"],
    ["domain-workspace-mobile",375,844,"/domain-workspaces/function.build-engineering?tenant_id=workspace-demo&lang=ja"],
    ["graph-desktop",1440,900,"/memories/constellation?lang=ja&project_id=org-brain&advanced=1"],
    ["history-desktop",1440,900,"/decisions/history?lang=ja&project_id=org-brain&advanced=1"],
    ["compact",1280,720,"/knowledge?lang=ja&kind=memory&id=mem_auth_group_acl"],
    ["narrow",320,844,"/knowledge?lang=ja&kind=memory&id=mem_auth_group_acl"]
  ] as const;
  for(const[name,width,height,url]of captures){
    await page.setViewportSize({width,height});await page.goto(url);
    if(url.includes("section=agents")) await page.getByText("渡すスキルと優先度を編集",{exact:true}).click();
    await expect(page.locator("main#main h1")).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const audit=await new AxeBuilder({page}).analyze();expect(audit.violations.filter(v=>["critical","serious"].includes(v.impact??""))).toEqual([]);
    await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo(0,0);});
    await page.screenshot({path:path.join(directory,`${name}.png`),fullPage:true,animations:"disabled"});
  }
  for(const lang of["en","zh"]){for(const route of["/","/knowledge","/settings"]){await page.goto(`${route}?lang=${lang}`);await expect(page.locator("html")).toHaveAttribute("lang",lang);await expect(page.getByRole("navigation",{name:lang==="en"?"Main navigation":"主导航"}).getByRole("link")).toHaveCount(3);}}
});
