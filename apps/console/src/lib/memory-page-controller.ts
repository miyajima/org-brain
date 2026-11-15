const pendingAssessments = new WeakMap<HTMLFormElement, { id: string; serialized: string }>();

export function mountMemoryPage(root: HTMLElement): () => void {
  const events = new AbortController();
  const frames = new Set<number>();
  const pendingButtons = new Set<HTMLButtonElement>();
  let disposed = false;
  const scheduleFrame = (callback: FrameRequestCallback) => {
    const id = window.requestAnimationFrame((time) => { frames.delete(id); if (!disposed) callback(time); });
    frames.add(id);
    return id;
  };
  const memorySelectionScrollKey = "org-brain:memory-selection-scroll";
  const mutationHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    try {
      const token = sessionStorage.getItem("orgbrain_csrf");
      if (token) headers["x-csrf-token"] = token;
    } catch {
      // Storage can be unavailable for API-key or Access-authenticated users.
    }
    return headers;
  };

  for (const link of root.querySelectorAll<HTMLAnchorElement>("a.memory-list-row[href*='selected=']")) {
    link.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const destination = new URL(link.href, window.location.href);
      const selected = destination.searchParams.get("selected");
      if (destination.origin !== window.location.origin || destination.pathname !== window.location.pathname || !selected) return;
      try {
        window.sessionStorage.setItem(memorySelectionScrollKey, JSON.stringify({
          selected,
          scrollY: window.scrollY,
          savedAt: Date.now()
        }));
      } catch {
        // Selection still works when storage is unavailable; only scroll restoration is skipped.
      }
    }, { signal: events.signal });
  }

  try {
    const stored = window.sessionStorage.getItem(memorySelectionScrollKey);
    const currentSelected = new URLSearchParams(window.location.search).get("selected");
    if (stored && currentSelected) {
      const saved = JSON.parse(stored) as { selected?: string; scrollY?: number; savedAt?: number };
      window.sessionStorage.removeItem(memorySelectionScrollKey);
      const isFresh = typeof saved.savedAt === "number" && Date.now() - saved.savedAt < 30_000;
      if (saved.selected === currentSelected && typeof saved.scrollY === "number" && isFresh) {
        const restoreScroll = () => window.scrollTo({ top: saved.scrollY, behavior: "instant" });
        scheduleFrame(() => scheduleFrame(restoreScroll));
        window.addEventListener("load", restoreScroll, { ...({ once: true }), signal: events.signal });
      }
    }
  } catch {
    try {
      window.sessionStorage.removeItem(memorySelectionScrollKey);
    } catch {
      // Storage can be disabled by browser privacy settings.
    }
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-memory-action]")) {
    button.addEventListener("click", async () => {
      const action = button.dataset.memoryAction;
      const memoryId = button.dataset.memoryId;
      const tenantId = button.dataset.tenantId || "default";
      const status = root.querySelector<HTMLElement>("[data-memory-action-status]");
      if (!action || !memoryId) return;
      if ((action === "suppress" || action === "trash") && !window.confirm(action === "trash" ? "このメモリをゴミ箱へ移動しますか？" : "Suppress this memory from normal retrieval?")) return;
      if (action === "permanent-delete" && window.prompt(`完全削除するにはメモリIDを入力してください: ${memoryId}`) !== memoryId) return;
      button.disabled = true;
      pendingButtons.add(button);
      if (status) status.textContent = `${action} running...`;
      const route = action === "refresh"
        ? "/api/v1/memories/refresh"
        : action === "suppress"
          ? "/api/v1/memories/suppress"
          : action === "trash"
            ? `/api/v1/memories/${encodeURIComponent(memoryId)}/trash`
            : action === "restore"
              ? `/api/v1/memories/${encodeURIComponent(memoryId)}/restore`
              : `/api/v1/memories/${encodeURIComponent(memoryId)}?tenant_id=${encodeURIComponent(tenantId)}`;
      const body = action === "refresh"
        ? { tenant_id: tenantId, memory_id: memoryId }
        : action === "suppress"
          ? { tenant_id: tenantId, memory_id: memoryId, reason: "suppressed from console" }
          : { tenant_id: tenantId, memory_id: memoryId, reason: "moved to trash from console" };
      try {
        const response = await fetch(route, {
          method: action === "permanent-delete" ? "DELETE" : "POST",
          headers: mutationHeaders(),
          ...(action === "permanent-delete" ? {} : { body: JSON.stringify(body) })
        });
        if (disposed) return;
        if (status) status.textContent = response.ok ? `${action} complete. Reloading...` : `${action} failed.`;
        if (response.ok) window.location.reload();
      } catch {
        if (!disposed && status) status.textContent = `${action} failed.`;
      } finally {
        if (!disposed) button.disabled = false;
        pendingButtons.delete(button);
      }
    }, { signal: events.signal });
  }

  for (const form of root.querySelectorAll<HTMLFormElement>("[data-use-feedback]")) {
    form.addEventListener("submit",async event=>{
      event.preventDefault();
      const values=new FormData(form);
      const status=form.querySelector<HTMLElement>("[data-use-feedback-status]");
      const button=form.querySelector<HTMLButtonElement>('button[type="submit"]');
      const body={tenant_id:values.get('tenant_id'),context_id:values.get('context_id'),supersedes_id:values.get('supersedes_id')||null,
        feedback:{contribution:values.get('contribution'),statement:String(values.get('statement')||'').trim()}};
      const serialized=JSON.stringify(body);
      let submitted=pendingAssessments.get(form);
      if(!submitted||submitted.serialized!==serialized) {
        submitted={id:crypto.randomUUID(),serialized};
        pendingAssessments.set(form,submitted);
      }
      if(button) { button.disabled=true; pendingButtons.add(button); }
      try {
        const response=await fetch('/api/v1/memory-use-evaluations',{method:'POST',headers:mutationHeaders(),body:JSON.stringify({...body,id:submitted.id})});
        if(disposed || pendingAssessments.get(form)!==submitted) return;
        if(!response.ok) throw new Error('assessment_failed');
        const receipt=await response.json() as {data?:{verification_state?:string}};
        if(disposed || pendingAssessments.get(form)!==submitted) return;
        if(status) status.textContent=receipt.data?.verification_state==='verified' ? (form.dataset.locale==='ja'?'評価を記録しました。':'Assessment recorded.') : (form.dataset.locale==='ja'?'評価を記録しました。行動・結果の証拠が不足するため順位補正はありません。':'Recorded; action or outcome evidence is insufficient for ranking.');
        const previous=form.elements.namedItem('supersedes_id') as HTMLInputElement;
        previous.value=submitted.id;pendingAssessments.delete(form);
      } catch {
        if(!disposed && pendingAssessments.get(form)===submitted && status) status.textContent=form.dataset.locale==='ja'?'保存を確認できませんでした。再送は同じIDで処理します。':'Save could not be confirmed. Retry uses the same ID.';
      } finally {if(button && (!pendingAssessments.has(form) || pendingAssessments.get(form)===submitted)) { if(!disposed) button.disabled=false; pendingButtons.delete(button); }}
    }, { signal: events.signal });
  }

  const editForm = root.querySelector<HTMLFormElement>("[data-memory-edit-form]");
  editForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(editForm);
    const status = editForm.querySelector<HTMLElement>("[data-memory-edit-status]");
    const saveButton = editForm.querySelector<HTMLButtonElement>("[data-memory-save]");
    const content = String(form.get("content") || "").trim();
    const summary = String(form.get("summary") || "").trim();
    const projectId = String(form.get("project_id") || "").trim();
    const tags = String(form.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean);
    if (!content) {
      if (status) status.textContent = "本文は空にできません。";
      return;
    }
    if (saveButton) { saveButton.disabled = true; pendingButtons.add(saveButton); }
    if (status) status.textContent = "saving...";
    try {
      const response = await fetch("/api/v1/memories/revise", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          tenant_id: form.get("tenant_id"),
          memory_id: form.get("memory_id"),
          content,
          summary: summary || null,
          project_id: projectId || null,
          tags
        })
      });
      if (disposed) return;
      if (status) status.textContent = response.ok ? "Saved. Reloading..." : "保存に失敗しました。権限と本文を確認してください。";
      if (response.ok) window.location.reload();
    } catch {
      if (!disposed && status) status.textContent = "保存に失敗しました。権限と本文を確認してください。";
    } finally {
      if (saveButton) { if (!disposed) saveButton.disabled = false; pendingButtons.delete(saveButton); }
    }
  }, { signal: events.signal });

  window.addEventListener("pagehide", (event) => { if (!event.persisted) dispose(); }, { signal: events.signal });
  function dispose() {
    if (disposed) return;
    disposed = true;
    events.abort();
    for (const button of pendingButtons) button.disabled = false;
    pendingButtons.clear();
    for (const id of frames) window.cancelAnimationFrame(id);
    frames.clear();
  }
  return dispose;
}
