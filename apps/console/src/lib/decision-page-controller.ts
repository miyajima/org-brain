import { compactOwnerRefs, compactSourceRefs } from "./decision-ui";
import { decisionEditorHref, optionalDateTime, optionalText, parseLines, sourceRowError } from "./decision-form-values";


export function mountDecisionPage(root: HTMLElement): () => void {
    const events = new AbortController();
    const pendingButtons = new Set<HTMLButtonElement>();
    let disposed = false;
    type StructuredRowValue = Record<string, string>;
    type ClientLocale = "en" | "ja" | "zh";

    const CLIENT_COPY: Record<ClientLocale, Record<string, string>> = {
      en: {
        invalidUrl: "Enter a valid URL.",
        invalidDate: "Enter an updated date that can be parsed.",
        invalidFields: "Check the highlighted fields.",
        saveFailed: "The request could not be saved.",
        createDirty: "Unsaved new decision changes.",
        createPending: "Creating decision.",
        createSuccess: "Decision created.",
        createFailed: "Could not create the decision.",
        reviseDirty: "Unsaved changes.",
        revisePending: "Saving revision.",
        reviseSuccess: "Revision saved.",
        reviseFailed: "Could not save the revision.",
        confirmDirty: "Unconfirmed changes.",
        confirmPending: "Confirming decision.",
        confirmSuccess: "Decision confirmed.",
        confirmFailed: "Could not confirm the decision."
      },
      ja: {
        invalidUrl: "URL形式で入力してください。",
        invalidDate: "更新日は日付として解釈できる形式で入力してください。",
        invalidFields: "入力内容を確認してください。",
        saveFailed: "保存できませんでした。",
        createDirty: "未作成の変更があります。",
        createPending: "作成しています。",
        createSuccess: "判断を作成しました。",
        createFailed: "作成できませんでした。",
        reviseDirty: "未保存の変更があります。",
        revisePending: "保存しています。",
        reviseSuccess: "改訂を保存しました。",
        reviseFailed: "保存できませんでした。",
        confirmDirty: "未確認の変更があります。",
        confirmPending: "確認しています。",
        confirmSuccess: "判断を確認しました。",
        confirmFailed: "確認できませんでした。"
      },
      zh: {
        invalidUrl: "请输入有效URL。",
        invalidDate: "请输入可解析的更新日期。",
        invalidFields: "请检查高亮字段。",
        saveFailed: "无法保存。",
        createDirty: "新决策有未保存更改。",
        createPending: "正在创建决策。",
        createSuccess: "决策已创建。",
        createFailed: "无法创建决策。",
        reviseDirty: "有未保存更改。",
        revisePending: "正在保存修订。",
        reviseSuccess: "修订已保存。",
        reviseFailed: "无法保存修订。",
        confirmDirty: "有未确认更改。",
        confirmPending: "正在确认决策。",
        confirmSuccess: "决策已确认。",
        confirmFailed: "无法确认决策。"
      }
    };

    const pageLocale = document.documentElement.lang === "ja" || document.documentElement.lang === "zh" ? document.documentElement.lang : "en";
    const clientCopy = CLIENT_COPY[pageLocale];

    function mutationHeaders(): Record<string, string> {
      const headers: Record<string, string> = { "content-type": "application/json" };
      try {
        const token = sessionStorage.getItem("orgbrain_csrf");
        if (token) headers["x-csrf-token"] = token;
      } catch {
        // Storage can be unavailable for API-key or Access-authenticated users.
      }
      return headers;
    }

    function collectRows(form: HTMLFormElement, listName: string): StructuredRowValue[] {
      const list = form.querySelector(`[data-ref-list="${listName}"]`);
      if (!list) return [];
      return Array.from(list.querySelectorAll<HTMLElement>("[data-ref-row]")).map((row) => {
        const value: StructuredRowValue = {};
        row.querySelectorAll<HTMLInputElement>("[data-ref-field]").forEach((input) => {
          value[String(input.dataset.refField)] = input.value;
        });
        return value;
      });
    }

    function clearRowErrors(form: HTMLFormElement) {
      form.querySelectorAll<HTMLElement>("[data-row-error]").forEach((error) => {
        error.textContent = "";
      });
    }

    function setRowError(row: HTMLElement, message: string) {
      const error = row.querySelector<HTMLElement>("[data-row-error]");
      if (error) error.textContent = message;
    }

    function validateStructuredRows(form: HTMLFormElement) {
      clearRowErrors(form);
      let valid = true;
      form.querySelectorAll<HTMLElement>('[data-ref-list="sourceRefs"] [data-ref-row]').forEach((row) => {
        const url = row.querySelector<HTMLInputElement>('[data-ref-field="url"]')?.value.trim() ?? "";
        const updatedAt = row.querySelector<HTMLInputElement>('[data-ref-field="updatedAt"]')?.value.trim() ?? "";
        const hasContent = Array.from(row.querySelectorAll<HTMLInputElement>("[data-ref-field]")).some((input) => input.dataset.refField !== "type" && input.value.trim());
        const error = sourceRowError(url, updatedAt, hasContent);
        if (error) {
          setRowError(row, clientCopy[error]);
          valid = false;
        }
      });
      if (!valid) throw new Error(clientCopy.invalidFields);
    }

    function setStatus(form: HTMLFormElement, text: string, tone: "idle" | "pending" | "success" | "error" = "idle") {
      const status = form.querySelector<HTMLElement>("[data-form-status]");
      if (!status) return;
      status.textContent = text;
      status.dataset.tone = tone;
    }

    function setPending(form: HTMLFormElement, pending: boolean) {
      const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (button) {
        button.disabled = pending;
        if (pending) pendingButtons.add(button);
        else pendingButtons.delete(button);
      }
    }

    function responseMessage(json: { ok?: boolean; error?: { message?: string } }, successText: string) {
      if (json.ok) return successText;
      return json.error?.message ?? clientCopy.saveFailed;
    }

    function wireStructuredRows() {
      root.querySelectorAll<HTMLButtonElement>("[data-add-row]").forEach((button) => {
        button.addEventListener("click", () => {
          const listName = button.dataset.addRow;
          const list = listName ? root.querySelector<HTMLElement>(`[data-ref-list="${listName}"]`) : null;
          const source = list?.querySelector<HTMLElement>("[data-ref-row]");
          if (!list || !source) return;
          const clone = source.cloneNode(true) as HTMLElement;
          clone.querySelectorAll<HTMLInputElement>("[data-ref-field]").forEach((input) => {
            input.value = input.dataset.refField === "type" ? button.dataset.defaultType ?? "" : "";
          });
          const error = clone.querySelector<HTMLElement>("[data-row-error]");
          if (error) error.textContent = "";
          list.appendChild(clone);
          list.closest("form")?.dispatchEvent(new Event("input", { bubbles: true }));
        }, { signal: events.signal });
      });

      root.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || !target.matches("[data-remove-row]")) return;
        const row = target.closest<HTMLElement>("[data-ref-row]");
        const list = row?.parentElement;
        if (!row || !list) return;
        if (list.querySelectorAll("[data-ref-row]").length <= 1) {
          const changed = Array.from(row.querySelectorAll<HTMLInputElement>("[data-ref-field]")).some((input) => input.dataset.refField !== "type" && input.value !== "");
          row.querySelectorAll<HTMLInputElement>("[data-ref-field]").forEach((input) => {
            input.value = input.dataset.refField === "type" ? input.value : "";
          });
          const error = row.querySelector<HTMLElement>("[data-row-error]");
          if (error) error.textContent = "";
          if (changed) list.closest("form")?.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
        row.remove();
        list.closest("form")?.dispatchEvent(new Event("input", { bubbles: true }));
      }, { signal: events.signal });
    }

    function wireDirtyState(form: HTMLFormElement, text: string) {
      form.addEventListener("input", () => setStatus(form, text, "pending"), { signal: events.signal });
    }

    const createForm = root.querySelector<HTMLFormElement>("#decision-create-form");
    if (createForm) {
      wireDirtyState(createForm, clientCopy.createDirty);
      createForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const formData = new FormData(createForm);
        try {
          validateStructuredRows(createForm);
          setPending(createForm, true);
          setStatus(createForm, clientCopy.createPending, "pending");
          const tenant = createForm.dataset.tenant ?? "default";
          const project = createForm.dataset.project || null;
          const body = {
            tenant_id: tenant,
            project_id: project,
            title: optionalText(formData, "title"),
            decision: optionalText(formData, "decision"),
            rationale: optionalText(formData, "rationale"),
            constraints: parseLines(formData.get("constraints")),
            knownPitfalls: parseLines(formData.get("knownPitfalls")),
            status: optionalText(formData, "status") ?? "active",
            confirmationState: optionalText(formData, "confirmationState") ?? "draft",
            confidence: Number(formData.get("confidence") ?? 0.5),
            ownerRefs: compactOwnerRefs(collectRows(createForm, "ownerRefs")),
            reviewerRefs: compactOwnerRefs(collectRows(createForm, "reviewerRefs")),
            sourceRefs: compactSourceRefs(collectRows(createForm, "sourceRefs"))
          };
          const response = await fetch("/api/v1/decision-memories", {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify(body)
          });
          const json = await response.json() as { ok?: boolean; data?: { decisionMemory?: { id?: string; tenantId?: string; projectId?: string | null } }; error?: { message?: string } };
          if (disposed) return;
          setStatus(createForm, responseMessage(json, clientCopy.createSuccess), json.ok ? "success" : "error");
          if (json.ok && json.data?.decisionMemory?.id) {
            window.location.href = decisionEditorHref(new URL(window.location.href), json.data.decisionMemory.id, json.data.decisionMemory.tenantId ?? tenant, json.data.decisionMemory.projectId ?? project);
          }
        } catch (error) {
          if (!disposed) setStatus(createForm, error instanceof Error ? error.message : clientCopy.createFailed, "error");
        } finally {
          if (!disposed) setPending(createForm, false);
        }
      }, { signal: events.signal });
    }

    const reviseForm = root.querySelector<HTMLFormElement>("#decision-revise-form");
    if (reviseForm) {
      wireDirtyState(reviseForm, clientCopy.reviseDirty);
      reviseForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const formData = new FormData(reviseForm);
        try {
          validateStructuredRows(reviseForm);
          setPending(reviseForm, true);
          setStatus(reviseForm, clientCopy.revisePending, "pending");
          const id = reviseForm.dataset.id;
          const tenant = reviseForm.dataset.tenant;
          const body = {
            title: optionalText(formData, "title"),
            decision: optionalText(formData, "decision"),
            rationale: optionalText(formData, "rationale"),
            constraints: parseLines(formData.get("constraints")),
            knownPitfalls: parseLines(formData.get("knownPitfalls")),
            status: optionalText(formData, "status"),
            confidence: Number(formData.get("confidence")),
            confirmationState: optionalText(formData, "confirmationState"),
            validFrom: optionalDateTime(formData, "validFrom"),
            validUntil: optionalDateTime(formData, "validUntil"),
            ownerRefs: compactOwnerRefs(collectRows(reviseForm, "ownerRefs")),
            reviewerRefs: compactOwnerRefs(collectRows(reviseForm, "reviewerRefs")),
            sourceRefs: compactSourceRefs(collectRows(reviseForm, "sourceRefs")),
            note: optionalText(formData, "note")
          };
          const response = await fetch(`/api/v1/decision-memories/${id}/revise?tenant_id=${encodeURIComponent(String(tenant ?? ""))}`, {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify(body)
          });
          const json = await response.json() as { ok?: boolean; error?: { message?: string } };
          if (disposed) return;
          setStatus(reviseForm, responseMessage(json, clientCopy.reviseSuccess), json.ok ? "success" : "error");
          if (json.ok) window.location.reload();
        } catch (error) {
          if (!disposed) setStatus(reviseForm, error instanceof Error ? error.message : clientCopy.reviseFailed, "error");
        } finally {
          if (!disposed) setPending(reviseForm, false);
        }
      }, { signal: events.signal });
    }

    const confirmForm = root.querySelector<HTMLFormElement>("#decision-confirm-form");
    if (confirmForm) {
      wireDirtyState(confirmForm, clientCopy.confirmDirty);
      confirmForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const formData = new FormData(confirmForm);
        try {
          setPending(confirmForm, true);
          setStatus(confirmForm, clientCopy.confirmPending, "pending");
          const id = confirmForm.dataset.id;
          const tenant = confirmForm.dataset.tenant;
          const body = {
            reviewerRefs: compactOwnerRefs(collectRows(confirmForm, "confirmReviewerRefs")),
            confirmationState: optionalText(formData, "confirmationState"),
            confirmationNote: optionalText(formData, "confirmationNote"),
            confidenceDelta: Number(formData.get("confidenceDelta")),
            validUntil: optionalDateTime(formData, "validUntil")
          };
          const response = await fetch(`/api/v1/decision-memories/${id}/confirm?tenant_id=${encodeURIComponent(String(tenant ?? ""))}`, {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify(body)
          });
          const json = await response.json() as { ok?: boolean; error?: { message?: string } };
          if (disposed) return;
          setStatus(confirmForm, responseMessage(json, clientCopy.confirmSuccess), json.ok ? "success" : "error");
          if (json.ok) window.location.reload();
        } catch (error) {
          if (!disposed) setStatus(confirmForm, error instanceof Error ? error.message : clientCopy.confirmFailed, "error");
        } finally {
          if (!disposed) setPending(confirmForm, false);
        }
      }, { signal: events.signal });
    }

    wireStructuredRows();

    window.addEventListener("pagehide", (event) => { if (!event.persisted) dispose(); }, { signal: events.signal });
    function dispose() {
      if (disposed) return;
      disposed = true;
      events.abort();
      for (const button of pendingButtons) button.disabled = false;
      pendingButtons.clear();
    }
    return dispose;
}
