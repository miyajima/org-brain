export {};
const locale = document.documentElement.lang;
const text = (ja: string, en: string, zh: string) => locale === "en" ? en : locale === "zh" ? zh : ja;
const idempotency = new WeakMap<HTMLFormElement,{body:string;key:string}>();
document.addEventListener("keydown", event => {
  const tag = (event.target as HTMLElement)?.tagName;
  if (event.key !== "/" || event.metaKey || event.ctrlKey || ["INPUT", "TEXTAREA", "SELECT"].includes(tag) || (event.target as HTMLElement)?.isContentEditable) return;
  const input = document.querySelector<HTMLInputElement>("[data-knowledge-search]");
  if (input) { event.preventDefault(); input.focus(); }
});


for(const input of document.querySelectorAll<HTMLInputElement>("[data-op-csrf]")) {
 try { input.value=sessionStorage.getItem("orgbrain_csrf") || ""; } catch { input.value=""; }
}
for(const nativeForm of document.querySelectorAll<HTMLFormElement>("[data-op-native-confirm]")) {
 nativeForm.addEventListener("submit",async event=>{
  if(nativeForm.dataset.nativeApproved === "true")return;
  event.preventDefault();if(nativeForm.dataset.busy === "true")return;
  const submitter=(event as SubmitEvent).submitter as HTMLButtonElement|HTMLInputElement|null;
  nativeForm.dataset.busy="true";
  const dialog=document.querySelector<HTMLDialogElement>("[data-op-confirm]")!;
  dialog.querySelector("[data-confirm-description]")!.textContent=[nativeForm.dataset.opNativeConfirm,nativeForm.dataset.confirmRecovery].filter(Boolean).join("\n");
  dialog.returnValue="cancel";dialog.showModal();
  const approved=await new Promise<boolean>(resolve=>dialog.addEventListener("close",()=>resolve(dialog.returnValue==="apply"),{once:true}));
  nativeForm.dataset.busy="false";
  if(approved){nativeForm.dataset.nativeApproved="true";nativeForm.requestSubmit(submitter || undefined);}
 });
}

// Only positions are kept locally. Knowledge bodies and form values are never stored.
const list = document.querySelector<HTMLElement>("[data-knowledge-list]");
const positionKey = `${location.pathname}?${new URLSearchParams([...new URLSearchParams(location.search)].filter(([key]) => !["id", "type", "tab", "selected", "saved"].includes(key)).sort(([a],[b])=>a.localeCompare(b)))}`;
if (list) {
 const id=new URLSearchParams(location.search).get("id"), mobile=matchMedia("(max-width: 760px)").matches;
 const key=`op-window:${positionKey}:${mobile&&id?`detail:${id}`:"list"}`;
 const restore=()=>{try{const value=sessionStorage.getItem(key);if(value!==null)window.scrollTo(0,Number(value)||0);}catch{/* Optional position only. */}};
 requestAnimationFrame(()=>requestAnimationFrame(restore));
 window.addEventListener("pagehide",()=>{try{sessionStorage.setItem(key,String(scrollY));}catch{/* Optional position only. */}});
}
if (list) {
  try { list.scrollTop = Number(sessionStorage.getItem(`op-position:${positionKey}`)) || 0; } catch { /* Storage may be disabled. */ }
  list.addEventListener("scroll", () => { try { sessionStorage.setItem(`op-position:${positionKey}`, String(list.scrollTop)); } catch { /* Position persistence is optional. */ } }, { passive: true });
}

for (const form of document.querySelectorAll<HTMLFormElement>("[data-op-api-form]")) {
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (form.dataset.busy === "true") return;
    const output = form.querySelector<HTMLElement>("[data-form-status]");
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const endpoint = form.dataset.endpoint;
    if (!endpoint?.startsWith("/api/v1/")) return;
    form.dataset.busy = "true";
    let impactDigest = "";
    if (form.dataset.impactEndpoint) {
      try {
        if (!form.dataset.impactEndpoint.startsWith("/api/v1/")) throw new Error("Invalid preview target");
        const response = await fetch(form.dataset.impactEndpoint, { headers: {accept:"application/json"}, cache:"no-store" });
        const preview = await response.json() as {data?:{impact_digest?:string;impact?:{lost_count?:number;retained_count?:number}}};
        const impact = preview.data?.impact;
        if (!response.ok || !preview.data?.impact_digest || typeof impact?.lost_count !== "number" || typeof impact?.retained_count !== "number") throw new Error("Impact unavailable");
        impactDigest = preview.data.impact_digest;
        form.dataset.confirm = text(`このメンバーを外すと、${impact.lost_count}件へのアクセスを失い、${impact.retained_count}件は維持されます。`, `Removing this member loses access to ${impact.lost_count} items and retains access to ${impact.retained_count}.`, `移除此成员将失去 ${impact.lost_count} 项访问权限，保留 ${impact.retained_count} 项。`) + " " + text("同じユーザーを再追加して戻せます。", "You can add the same user again to restore membership.", "可以重新添加同一用户来恢复成员资格。");
      } catch {
        if(output) {output.textContent=text("影響を確認できないため、解除しませんでした。再試行してください。", "Removal was not performed because access impact could not be verified. Retry the preview.", "无法确认访问影响，未执行移除操作。请重试预览。");output.dataset.tone="error";}
        form.dataset.busy="false";return;
      }
    }
    if (form.dataset.confirm) {
      const dialog = document.querySelector<HTMLDialogElement>("[data-op-confirm]")!;
      const selectedValues=(form.dataset.confirmFields||"").split(",").filter(Boolean).map(name=>{
        const field=form.elements.namedItem(name) as HTMLInputElement|HTMLSelectElement|null;
        return field?.tagName === "SELECT" ? (field as HTMLSelectElement).selectedOptions[0]?.textContent || field.value : field?.value || "";
      }).filter(Boolean);
      dialog.querySelector("[data-confirm-description]")!.textContent = [form.dataset.confirm,selectedValues.join(" · "),form.dataset.confirmRecovery].filter(Boolean).join("\n");
      dialog.returnValue = "cancel";
      dialog.showModal();
      const approved = await new Promise<boolean>(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "apply"), { once: true }));
      if (!approved) { form.dataset.busy = "false"; return; }
    }
    if (button) button.disabled = true;
    form.setAttribute("aria-busy", "true");
    if (output) { output.textContent = text("保存しています…", "Saving…", "正在保存…"); output.dataset.tone = ""; }
    const body: Record<string, unknown> = {};
    for (const [key, value] of new FormData(form)) {
      const input = form.elements.namedItem(key) as HTMLInputElement | null;
      if (key.startsWith("_")) continue;
      const raw = String(value);
      body[key] = input?.dataset?.valueType === "json" ? JSON.parse(raw)
        : input?.dataset?.valueType === "subjects" ? raw.split(/\n/u).map(item => item.trim()).filter(Boolean).map(item => { const split = item.indexOf(":"); return { subject_type: item.slice(0,split), subject_id: item.slice(split+1) }; })
        : input?.dataset?.valueType === "array" ? raw.split(/[,\n]/u).map(item => item.trim()).filter(Boolean)
        : input?.dataset?.valueType === "boolean" ? raw === "true"
        : input?.dataset?.valueType === "number" ? Number(raw)
        : input?.dataset?.valueType === "nullable" && !raw ? null : raw;
    }
    for (const checkbox of form.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name]')) body[checkbox.name] = checkbox.checked;
    if(form.dataset.formKind === "loadout") {
      for(const key of Object.keys(body)) if(!["tenant_id","name"].includes(key)) delete body[key];
      body.bindings = [...form.querySelectorAll<HTMLElement>("[data-op-binding]")].flatMap(row=>{
        if(!row.querySelector<HTMLInputElement>('[name="enabled"]')?.checked)return [];
        const policy=row.querySelector<HTMLInputElement>('[name="version_policy"]')?.value || "latest_published";
        const original=JSON.parse(row.dataset.bindingOriginal || "null") as {pinned_version_id?:string;valid_until?:number}|null;
        return [{skill_asset_id:row.dataset.skillId,usage_mode:row.querySelector<HTMLInputElement>('[name="usage_mode"]')?.value || "auto",priority:Number(row.querySelector<HTMLInputElement>('[name="priority"]')?.value || 50),version_policy:policy==="pinned_current"?"pinned":policy,pinned_version_id:policy==="pinned_current"?row.dataset.publishedVersion:policy==="pinned"?original?.pinned_version_id:null,valid_until:original?.valid_until ?? null}];
      });
    }
    try {
      const headers = new Headers({ "content-type": "application/json" });
      const token = sessionStorage.getItem("orgbrain_csrf");
      if (token) headers.set("x-csrf-token", token);
      if(["skill-generation","idempotent"].includes(form.dataset.formKind||"")) {
        const serialized=JSON.stringify(body), previous=idempotency.get(form);
        const key=previous?.body===serialized?previous.key:crypto.randomUUID();
        idempotency.set(form,{body:serialized,key});headers.set("x-idempotency-key",key);if(form.dataset.formKind === "skill-generation")body.idempotency_key=key;
      }
      if(impactDigest) headers.set("if-match",impactDigest);
      const method=form.dataset.method || "POST";
      const response = await fetch(endpoint, { method, headers, ...(method === "DELETE" ? {} : {body: JSON.stringify(body)}) });
      const payload = (response.status === 204 ? { ok: true } : await response.json()) as { ok?: boolean; data?: Record<string, any> };
      if (!response.ok || payload?.ok === false) {
        if (output) { output.textContent = response.status === 409 ? text("ほかの変更と競合しました。入力を残したまま、最新の内容を別タブで確認してください。", "A newer change conflicts with this one. Your input is kept; check the latest version in another tab.", "与较新的更改冲突。已保留输入，请在其他标签页查看最新版本。") : text(`保存できません（HTTP ${response.status}）。入力内容と権限を確認して再試行してください。`, `Could not save (HTTP ${response.status}). Check your input and permissions, then retry.`, `无法保存（HTTP ${response.status}）。请检查输入和权限后重试。`); output.dataset.tone = "error"; }
      } else if (form.dataset.responseMode === "queued") {
        if(output)output.textContent=text("処理を受け付けました。完了は、画面を更新して状態を確認してください。", "Processing accepted. Refresh to check completion.", "已受理处理请求，请刷新查看完成状态。");
      } else if (form.dataset.responseMode === "enrollment") {
        const code = payload?.data?.enrollment_code;
        const expiry = payload?.data?.enrollment_expires_at;
        if (typeof code !== "string" || !code) throw new Error("Incomplete enrollment response");
        const result = form.querySelector<HTMLElement>("[data-enrollment-result]");
        const display = form.querySelector<HTMLElement>("[data-enrollment-code]");
        const expires = form.querySelector<HTMLElement>("[data-enrollment-expiry]");
        if (display) display.textContent = code;
        if (expires && typeof expiry === "number") expires.textContent = `${text("有効期限", "Expires", "有效期")}: ${new Date(expiry).toLocaleString(locale)}`;
        if (result) result.hidden = false;
        if (output) output.textContent = text("登録コードを発行しました。接続が完了するまでは未接続です。", "Enrollment code issued. The device remains unconnected until activation.", "已生成登记码。激活前设备仍未连接。");
      } else if(form.dataset.responseMode === "generation") {
        if(!payload.data?.task_id||!payload.data?.asset_id)throw new Error("Incomplete generation receipt");
        for(const [selector,section,id] of [["[data-generation-asset]","skills",payload.data.asset_id],["[data-generation-task]","operations",payload.data.task_id]]) {
          const link=form.querySelector<HTMLAnchorElement>(selector);if(link){const target=new URL(link.href);target.searchParams.set("section",section);target.searchParams.set("id",id);link.href=target.href;}
        }
        const result=form.querySelector<HTMLElement>("[data-generation-result]");if(result)result.hidden=false;
        if(output)output.textContent=text("生成処理を受け付けました。まだ公開されていません。", "Generation accepted. Nothing has been published.", "已受理生成请求，尚未发布。");
      } else if (form.dataset.responseMode === "preview") {
        if(!payload.data) throw new Error("Missing preview");
        for(const target of form.querySelectorAll<HTMLElement>("[data-preview-list]")) {
          target.replaceChildren();
          const items=payload.data[target.dataset.previewList || ""];
          if(!Array.isArray(items)) throw new Error("Incomplete preview");
          for(const item of items) {const li=document.createElement("li");li.textContent=[item.name||item.skill_asset_id,item.content||item.reason||item.handle].filter(Boolean).join(" · ");target.appendChild(li);}
          if(!items.length){const li=document.createElement("li");li.textContent=text("該当なし", "None", "无");target.appendChild(li);}
        }
        const result=form.querySelector<HTMLElement>("[data-preview-result]");if(result)result.hidden=false;
        if(output)output.textContent=payload.data.disabled?text("この機能は現在無効です。", "This feature is disabled.", "此功能当前已停用。"):text("現在の権限と配布構成で確認しました。", "Previewed using current permissions and settings.", "已根据当前权限与分配设置完成预览。");
      } else {
        const next = new URL(location.href);
        next.searchParams.set("saved", "1");
        location.assign(next.href);
      }
    } catch {
      if (output) { output.textContent = text("保存結果を確認できません。入力は保持しています。再送する前に最新の状態を確認してください。", "The save result is unknown. Your input is kept. Check the latest state before resubmitting.", "无法确认保存结果。已保留输入，请在重新提交前确认最新状态。"); output.dataset.tone = "error"; }
    } finally {
      form.dataset.busy = "false"; form.removeAttribute("aria-busy"); if (button) button.disabled = false;
    }
  });
}

if (matchMedia("(max-width: 760px)").matches && new URLSearchParams(location.search).has("id")) {
  document.querySelector<HTMLElement>("[data-knowledge-detail]")?.focus({ preventScroll: true });
}
