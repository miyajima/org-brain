import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { diffLines } from "diff";
import {
  createIcons,
  FilePlus,
  PencilLine,
  Trash2,
  Upload,
  Save,
  X,
  PanelLeft,
  PanelRight,
} from "lucide";
import { apiStatus, request, showError } from "./api";

type Page = {
  page_id: string;
  path: string;
  title: string;
  display_title?: string;
  hash: string;
  content: string;
};
type Item = Record<string, any>;
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const icons = () =>
  createIcons({
    icons: {
      FilePlus,
      PencilLine,
      Trash2,
      Upload,
      Save,
      X,
      PanelLeft,
      PanelRight,
    },
  });
const displayTitle = (p: Item) => p.display_title || p.title;
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
let page: Page | null = null,
  editor: EditorView | null = null,
  pages: Page[] = [],
  side = "pages",
  rail = "links",
  loading = 0,
  dirty = false,
  renaming = false;
let selectedRevision: string | null = null;
let diffHash: string | null = null;
let selectedDraft: string | null = null;
let activeLinks: Item = { outlinks: [], citations: [] };
let sideGeneration = 0,
  railGeneration = 0;
function safe(task: () => Promise<unknown>) {
  return async () => {
    el("error").hidden = true;
    try {
      await task();
    } catch (error) {
      showError(error);
    }
  };
}
function button(
  title: string,
  description: string,
  action: () => Promise<unknown>,
) {
  const b = document.createElement("button");
  b.className = "list-item";
  b.title = description ? `${title}\n${description}` : title;
  const t = document.createElement("span");
  t.textContent = title;
  b.append(t);
  if (description) {
    const sub = document.createElement("small");
    sub.textContent = description;
    b.append(sub);
  }
  b.addEventListener("click", safe(action));
  return b;
}
function heading(parent: HTMLElement, text: string) {
  const h = document.createElement("h3");
  h.textContent = text;
  parent.append(h);
}
function note(parent: HTMLElement, text: string) {
  const p = document.createElement("p");
  p.className = "list-note";
  p.textContent = text;
  parent.append(p);
}
function confirmLeave() {
  return !dirty || window.confirm("未保存の変更を破棄しますか？");
}
function setDirty(value: boolean) {
  dirty = value;
  el("save-state").textContent = dirty ? "未保存" : "保存済み";
}
function mode(value: boolean) {
  el("editor").hidden = !value;
  el("preview").hidden = value;
  el("edit-mode").setAttribute("aria-pressed", String(value));
  el("preview-mode").setAttribute("aria-pressed", String(!value));
  el("save-page").hidden = !value;
  el("save-draft").hidden = !value;
}
function setPane(value: "pages" | "evidence" | null, restoreFocus = true) {
  const previous = document.body.dataset.pane;
  document.body.dataset.pane = value || "";
  el("pane-backdrop").hidden = !value;
  for (const name of ["pages", "evidence"]) {
    const b = el(`toggle-${name}`);
    const label = `${name === "pages" ? "ページ一覧" : "根拠ペイン"}を${value === name ? "閉じる" : "開く"}`;
    b.setAttribute("aria-expanded", String(value === name));
    b.setAttribute("aria-label", label);
    b.title = label;
  }
  if (!value && previous && restoreFocus)
    el(`toggle-${previous}`).focus({ preventScroll: true });
}
for (const name of ["pages", "evidence"] as const) {
  el(`toggle-${name}`).addEventListener("click", () =>
    setPane(document.body.dataset.pane === name ? null : name),
  );
}
el("pane-backdrop").addEventListener("click", () => setPane(null));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.querySelector("dialog[open]"))
    setPane(null);
});
window.addEventListener("resize", () => {
  if (
    innerWidth > 1100 ||
    (innerWidth > 650 && document.body.dataset.pane === "pages")
  )
    setPane(null, false);
});
function targetLink(href: string) {
  const base = href.split("#")[0];
  const linked = activeLinks.outlinks.find(
    (link: Item) =>
      link.target_text === base && link.target_id && !link.deleted,
  );
  if (linked) return `/wiki?page=${encodeURIComponent(linked.target_id)}`;
  const citation = activeLinks.citations.find((c: Item) => c.locator === href);
  if (citation)
    return `/wiki?source=${encodeURIComponent(citation.source_id)}&version=${citation.version}`;
  const source = /^source:([\w-]+)@(\d+)(?:#.*)?$/.exec(href);
  if (source)
    return `/wiki?source=${encodeURIComponent(source[1])}&version=${source[2]}`;
  if (href.startsWith("page:"))
    return `/wiki?page=${encodeURIComponent(href.slice(5).split("#")[0])}`;
  if (href.startsWith("#")) return href;
  if (!/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith("//"))
    return `/wiki?path=${encodeURIComponent(href)}`;
  return href;
}
marked.use({
  renderer: {
    link({ href, tokens }) {
      return `<a href="${escape(targetLink(href))}">${this.parser.parseInline(tokens)}</a>`;
    },
  },
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start(src) {
        return src.indexOf("[[");
      },
      tokenizer(src) {
        const match = /^\[\[([^\]\n]+)\]\]/.exec(src);
        if (match) {
          const [target, label] = match[1].split("|");
          return {
            type: "wikilink",
            raw: match[0],
            target,
            label: label || target,
          };
        }
      },
      renderer(token) {
        return `<a href="${escape(targetLink(token.target))}">${escape(token.label)}</a>`;
      },
    },
  ],
});
function preview(text: string) {
  el("preview").innerHTML = DOMPurify.sanitize(
    marked.parse(text, { async: false }) as string,
  );
}
async function fullPage(input: Item): Promise<Page> {
  let first: Item | null = null,
    content = "",
    offset = 0;
  for (let n = 0; n < 2000; n++) {
    const part = await request({
      op: "read",
      ...input,
      char_offset: offset,
      max_chars: 64000,
    });
    if (first && first.hash !== part.hash)
      throw new Error("page_conflict: 読取中にページが変更されました");
    first ||= part;
    content += part.content;
    if (!part.truncated) return { ...first, content } as Page;
    if (part.next_char_offset <= offset) throw new Error("invalid_read_cursor");
    offset = part.next_char_offset;
  }
  throw new Error("page_too_large");
}
async function listAll(op: string): Promise<Item[]> {
  const rows: Item[] = [];
  let offset = 0;
  for (let n = 0; n < 10000; n++) {
    const result = await request({ op, limit: 500, offset });
    rows.push(...result[op]);
    if (!result.truncated) return rows;
    if (result.next_offset <= offset) throw new Error("invalid_list_cursor");
    offset = result.next_offset;
  }
  throw new Error("list_too_large");
}
async function openPage(input: Item) {
  if (!confirmLeave()) return;
  const seq = ++loading;
  const loaded = await fullPage(input);
  const links = await request({ op: "links", page_id: loaded.page_id });
  if (seq !== loading) return;
  page = loaded;
  activeLinks = links;
  editor?.destroy();
  editor = new EditorView({
    doc: page.content,
    parent: el("editor"),
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) setDirty(true);
      }),
    ],
  });
  el("empty").hidden = true;
  el("document-content").hidden = false;
  el("page-title").textContent = displayTitle(page);
  el("page-title").title = displayTitle(page);
  el("page-path").textContent = page.path;
  el("page-path").title = page.path;
  preview(page.content);
  el("preview").scrollTop = 0;
  const wasOpen = !!document.body.dataset.pane;
  setPane(null, false);
  if (wasOpen) {
    el("page-title").tabIndex = -1;
    el("page-title").focus({ preventScroll: true });
  }
  setDirty(false);
  mode(false);
  history.replaceState(
    null,
    "",
    `/wiki?page=${encodeURIComponent(page.page_id)}`,
  );
  for (const item of el("page-list").querySelectorAll<HTMLElement>(
    "[data-page]",
  ))
    item.classList.toggle("selected", item.dataset.page === page.page_id);
  await refreshRail();
}
async function refreshPages() {
  pages = (await listAll("pages")) as Page[];
  const folder = (p: Page) =>
    p.path.slice(0, Math.max(0, p.path.lastIndexOf("/")));
  pages.sort(
    (a, b) =>
      folder(a).localeCompare(folder(b), "ja") ||
      displayTitle(a).localeCompare(displayTitle(b), "ja", { numeric: true }),
  );
  await refreshSide();
}
async function refreshSide() {
  const generation = ++sideGeneration;
  const list = document.createElement("div");
  for (const name of ["pages", "sources", "diagnose"])
    el(`${name}-tab`).setAttribute("aria-selected", String(side === name));
  if (side === "pages") {
    let folder = "";
    for (const p of pages) {
      const next = p.path.includes("/")
        ? p.path.slice(0, p.path.lastIndexOf("/"))
        : "";
      if (next !== folder) {
        folder = next;
        const h = document.createElement("div");
        h.className = "folder-label";
        h.textContent = folder.replace(/^wiki\/?/, "") || "Wiki";
        h.title = folder;
        list.append(h);
      }
      const b = button(displayTitle(p), "", () =>
        openPage({ page_id: p.page_id }),
      );
      b.title = `${displayTitle(p)}\n${p.path}`;
      b.dataset.page = p.page_id;
      b.classList.toggle("selected", page?.page_id === p.page_id);
      list.append(b);
    }
    if (!pages.length) note(list, "ページがありません");
  } else if (side === "sources") {
    const sources = await listAll("sources");
    for (const s of sources)
      list.append(
        button(s.name, `v${s.version} · ${s.extractor}`, () =>
          openSource(s.source_id, s.version),
        ),
      );
    if (!sources.length) note(list, "ソースがありません");
  } else {
    const { findings } = await request({ op: "diagnose" });
    const labels: Item = {
      stale_source: "ソースの新版あり",
      unpaged_source: "未引用のソース",
      unresolved_link: "未解決リンク",
      orphan_page: "孤立ページ",
      missing_anchor: "見出しが見つかりません",
      source_corrupt: "原本の検証エラー",
      invalid_citation: "引用の検証エラー",
    };
    const order = ["source_corrupt", "invalid_citation", "stale_source", "unresolved_link", "missing_anchor", "orphan_page", "unpaged_source"];
    const codes = [...new Set([...order, ...findings.map((f: Item) => f.code)])];
    for (const code of codes) {
      const group = findings.filter((f: Item) => f.code === code);
      if (!group.length) continue;
      heading(list, `${labels[code] || code} · ${group.length}`);
      for (const f of group) {
        const detail = f.details || f;
        const affected = pages.find((p) => p.page_id === (detail.page_id || detail.from_page));
        const pageTitle = affected ? displayTitle(affected) : detail.path || "ページ";
        const title = detail.name || pageTitle;
        const reason = code === "unpaged_source"
          ? `ページからの引用なし · v${detail.version}`
          : code === "stale_source"
            ? `${pageTitle} · 引用 v${detail.version} / 最新 v${detail.latest_version}`
            : code === "unresolved_link"
              ? `${detail.target_text} · リンク先が見つかりません`
              : code === "orphan_page"
                ? "他のページとのリンクなし"
                : code === "missing_anchor"
                  ? `${detail.anchor} · 見出しが見つかりません`
                  : detail.message || labels[code] || code;
        const b = button(title, reason, async () => {
          if (detail.page_id || detail.from_page)
            await openPage({ page_id: detail.page_id || detail.from_page });
          else if (detail.source_id)
            await openSource(detail.source_id, detail.version, reason);
        });
        b.dataset.finding = code;
        list.append(b);
      }
    }
    if (!findings.length) note(list, "確認事項はありません");
  }
  if (generation === sideGeneration)
    el("page-list").replaceChildren(...list.childNodes);
}
async function refreshRail() {
  const generation = ++railGeneration;
  const list = document.createElement("div");
  for (const name of ["links", "history", "drafts"])
    el(`${name}-tab`).setAttribute("aria-selected", String(rail === name));
  if (!page) {
    el("evidence-list").replaceChildren();
    return;
  }
  const id = page.page_id;
  if (rail === "links") {
    const result = await request({ op: "links", page_id: id });
    if (page?.page_id !== id) return;
    heading(list, "参照ソース");
    for (const c of result.citations)
      list.append(
        button(c.name, `v${c.version} · ${c.locator}`, () =>
          openSource(c.source_id, c.version),
        ),
      );
    if (!result.citations.length) note(list, "引用なし");
    heading(list, "リンク先");
    for (const l of result.outlinks)
      list.append(
        button(
          displayTitle(l) || l.target_text,
          l.deleted ? "削除済み" : l.target_id ? "" : "未解決",
          async () => {
            if (l.target_id && !l.deleted)
              await openPage({ page_id: l.target_id });
          },
        ),
      );
    heading(list, "バックリンク");
    for (const l of result.backlinks)
      list.append(
        button(displayTitle(l), "", () => openPage({ page_id: l.page_id })),
      );
    heading(list, "関連ページ");
    for (const l of result.neighbors)
      list.append(
        button(displayTitle(l), "", () => openPage({ page_id: l.page_id })),
      );
  } else if (rail === "history") {
    const result = await request({ op: "history", page_id: id });
    for (const r of result.revisions)
      list.append(
        button(
          new Date(r.created_at).toLocaleString("ja-JP"),
          r.hash.slice(0, 12),
          () => openDiff(r.revision_id),
        ),
      );
  } else {
    const drafts = await listAll("drafts");
    for (const d of drafts.filter((d: Item) => d.page_id === id))
      list.append(
        button(
          new Date(d.created_at).toLocaleString("ja-JP"),
          d.expected_hash === page?.hash ? "確認待ち" : "本文に変更あり",
          async () => {
            const draft = await request({
              op: "draft_read",
              draft_id: d.draft_id,
            });
            selectedDraft = d.draft_id;
            selectedRevision = null;
            diffHash = page!.hash;
            showDiff(page!.content, draft.content);
            el("restore-revision").textContent = "下書きを確定";
            el<HTMLDialogElement>("diff-dialog").showModal();
          },
        ),
      );
    if (!drafts.some((d: Item) => d.page_id === id))
      note(list, "下書きはありません");
  }
  if (generation === railGeneration && page?.page_id === id)
    el("evidence-list").replaceChildren(...list.childNodes);
}
async function openSource(id: string, version?: number, reviewReason = "") {
  const source = await request({ op: "source_read", source_id: id, version });
  el("source-title").textContent = source.name;
  el("source-version").textContent =
    `v${source.version} · SHA-256 ${source.hash}`;
  el("source-review-reason").textContent = reviewReason;
  el("source-review-reason").hidden = !reviewReason;
  el("source-text").textContent =
    source.text + (source.truncated ? "\n[以降省略]" : "");
  const link = el<HTMLAnchorElement>("source-download");
  link.href = `/api/v1/wiki/source/${encodeURIComponent(id)}?version=${source.version}&download=1`;
  link.download = source.name;
  el<HTMLDialogElement>("source-dialog").showModal();
}
async function openDiff(id: string) {
  const result = await request({ op: "diff", revision_id: id });
  selectedRevision = id;
  selectedDraft = null;
  diffHash = result.after_hash;
  el("restore-revision").textContent = "この版を復元";
  showDiff(result.before, result.after);
  el<HTMLDialogElement>("diff-dialog").showModal();
}
function showDiff(before: string, after: string) {
  const left = el("diff-before"),
    right = el("diff-after");
  left.replaceChildren();
  right.replaceChildren();
  const changes = diffLines(before, after, { timeout: 1000 });
  if (!changes) {
    left.textContent = before;
    right.textContent = after;
    return;
  }
  for (const part of changes) {
    const node = document.createElement("span");
    node.textContent = part.value;
    if (part.added) {
      node.className = "diff-added";
      node.title = "追加";
      right.append(node);
    } else if (part.removed) {
      node.className = "diff-removed";
      node.title = "削除";
      left.append(node);
    } else {
      left.append(node);
      right.append(node.cloneNode(true));
    }
  }
}
async function save(draft = false) {
  if (!page || !editor) return;
  const id = page.page_id,
    content = editor.state.doc.toString();
  const result = await request({
    op: draft ? "draft" : "put",
    page_id: id,
    expected_hash: page.hash,
    content,
  });
  if (draft) {
    el("save-state").textContent = "下書き保存済み";
    rail = "drafts";
    await refreshRail();
    return;
  }
  page = { ...page, content, hash: result.hash };
  activeLinks = await request({ op: "links", page_id: id });
  setDirty(false);
  preview(content);
  await refreshPages();
  await refreshRail();
}
el("initialize").addEventListener(
  "click",
  safe(async () => {
    await request({ op: "init" });
    el("initialize").hidden = true;
    await refreshPages();
  }),
);
el("new-page").addEventListener("click", () => {
  renaming = false;
  el("page-dialog-title").textContent = "新しいページ";
  el("page-submit").textContent = "作成";
  el<HTMLFormElement>("page-form").reset();
  el<HTMLDialogElement>("page-dialog").showModal();
});
el("rename-page").addEventListener("click", () => {
  if (!page) return;
  renaming = true;
  el("page-dialog-title").textContent = "名前を変更";
  el("page-submit").textContent = "変更";
  el<HTMLInputElement>("path-input").value = page.path;
  el<HTMLInputElement>("title-input").value = displayTitle(page);
  el<HTMLDialogElement>("page-dialog").showModal();
});
el("page-form").addEventListener("submit", (event) => {
  event.preventDefault();
  safe(async () => {
    if (!confirmLeave()) return;
    const path = el<HTMLInputElement>("path-input").value,
      title = el<HTMLInputElement>("title-input").value;
    const p = await request(
      renaming
        ? {
            op: "rename",
            page_id: page!.page_id,
            path,
            title,
            expected_hash: page!.hash,
          }
        : { op: "put", path, title, content: `# ${title}\n\n` },
    );
    el<HTMLDialogElement>("page-dialog").close();
    setDirty(false);
    await refreshPages();
    await openPage({ page_id: p.page_id });
    mode(!renaming);
  })();
});
el("close-page-dialog").addEventListener("click", () =>
  el<HTMLDialogElement>("page-dialog").close(),
);
el("delete-page").addEventListener(
  "click",
  safe(async () => {
    if (!page || !window.confirm(`「${displayTitle(page)}」を削除しますか？`))
      return;
    await request({
      op: "delete",
      page_id: page.page_id,
      expected_hash: page.hash,
    });
    page = null;
    editor?.destroy();
    editor = null;
    setDirty(false);
    el("document-content").hidden = true;
    el("empty").hidden = false;
    await refreshPages();
    await refreshRail();
  }),
);
el("edit-mode").addEventListener("click", () => {
  mode(true);
  editor?.focus();
});
el("preview-mode").addEventListener("click", () => {
  preview(editor?.state.doc.toString() || "");
  mode(false);
});
el("save-page").addEventListener(
  "click",
  safe(() => save()),
);
el("save-draft").addEventListener(
  "click",
  safe(() => save(true)),
);
el("close-source").addEventListener("click", () =>
  el<HTMLDialogElement>("source-dialog").close(),
);
el("close-diff").addEventListener("click", () =>
  el<HTMLDialogElement>("diff-dialog").close(),
);
el("restore-revision").addEventListener(
  "click",
  safe(async () => {
    if ((!selectedRevision && !selectedDraft) || !page || !confirmLeave())
      return;
    const id = page.page_id;
    await request(
      selectedDraft
        ? { op: "approve", draft_id: selectedDraft, expected_hash: diffHash }
        : {
            op: "restore_revision",
            revision_id: selectedRevision,
            expected_hash: diffHash,
          },
    );
    el<HTMLDialogElement>("diff-dialog").close();
    setDirty(false);
    await openPage({ page_id: id });
    await refreshPages();
  }),
);
for (const name of ["pages", "sources", "diagnose"])
  el(`${name}-tab`).addEventListener(
    "click",
    safe(async () => {
      side = name;
      await refreshSide();
    }),
  );
for (const name of ["links", "history", "drafts"])
  el(`${name}-tab`).addEventListener(
    "click",
    safe(async () => {
      rail = name;
      await refreshRail();
    }),
  );
el("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  safe(async () => {
    const query = el<HTMLInputElement>("search-query").value.trim();
    if (!query) {
      side = "pages";
      await refreshSide();
      return;
    }
    const result = await request({
      op: "search",
      query,
      mode: el<HTMLSelectElement>("search-mode").value,
      scope: "all",
    });
    const list = el("page-list");
    list.replaceChildren();
    for (const hit of result.hits)
      list.append(
        button(
          displayTitle(hit),
          `${hit.heading} · L${hit.start_line}–${hit.end_line}\n${hit.snippet}`,
          () =>
            hit.kind === "source"
              ? openSource(hit.owner_id, hit.version)
              : openPage({ page_id: hit.owner_id }),
        ),
      );
    if (!result.hits.length) note(list, "該当なし");
    if (result.truncated) note(list, "一部省略");
    if (result.fallback) note(list, "全文検索の結果");
  })();
});
el<HTMLInputElement>("source-upload").addEventListener(
  "change",
  safe(async () => {
    const input = el<HTMLInputElement>("source-upload");
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 8_000_000)
      throw new Error("source_too_large: CLIで取り込んでください");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await request({ op: "ingest", name: file.name, base64: btoa(binary) });
    input.value = "";
    side = "sources";
    await refreshSide();
  }),
);
el("preview").addEventListener("click", (event) => {
  const link = (event.target as HTMLElement).closest("a");
  if (!link) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin) return;
  if (url.pathname !== "/wiki") return;
  event.preventDefault();
  safe(async () => {
    if (url.searchParams.has("source")) {
      await openSource(
        url.searchParams.get("source")!,
        Number(url.searchParams.get("version")) || undefined,
      );
    } else if (url.searchParams.has("page"))
      await openPage({ page_id: url.searchParams.get("page") });
    else if (url.searchParams.has("path")) {
      const path = url.searchParams.get("path")!.split("#")[0];
      if (path.startsWith("raw/")) {
        const { sources } = await request({ op: "sources" });
        const s = sources.find((s: Item) => s.original_path === path);
        if (!s) throw new Error("source_not_found");
        await openSource(s.source_id, s.version);
      } else await openPage({ path });
    }
  })();
});
window.addEventListener("beforeunload", (event) => {
  if (dirty) event.preventDefault();
});
async function start() {
  const status = await apiStatus();
  if (!status.enabled) {
    location.replace("/settings");
    return;
  }
  el("wiki-nav").hidden = false;
  icons();
  try {
    await refreshPages();
    const params = new URLSearchParams(location.search);
    if (params.has("page")) await openPage({ page_id: params.get("page") });
    else if (params.has("path")) await openPage({ path: params.get("path") });
    else if (pages.length) await openPage({ page_id: pages[0].page_id });
    if (params.has("source"))
      await openSource(
        params.get("source")!,
        Number(params.get("version")) || undefined,
      );
  } catch (error) {
    if (error instanceof Error && error.message === "wiki_not_initialized")
      el("initialize").hidden = false;
    else throw error;
  }
}
start().catch(showError);
const featureCheck = setInterval(async () => {
  try {
    const status = await apiStatus();
    if (!status.enabled) {
      clearInterval(featureCheck);
      dirty = false;
      el("document-content").hidden = true;
      location.replace("/settings");
    }
  } catch {}
}, 1500);
window.addEventListener("pagehide", () => clearInterval(featureCheck));
