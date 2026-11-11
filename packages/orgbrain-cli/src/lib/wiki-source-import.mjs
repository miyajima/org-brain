import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "parse5";

const run = promisify(execFile);
const maxBytes = 8_000_000;
const privateNetworks = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
]) privateNetworks.addSubnet(address, prefix, "ipv4");

const ignored = new Set(["head", "script", "style", "noscript", "template", "nav", "svg", "canvas", "iframe", "footer", "form"]);
const blocks = new Set(["article", "main", "section", "div", "p", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr"]);

export function extractWikiHtml(html) {
  const pieces = [];
  const pending = [parse(html)];
  while (pending.length) {
    const node = pending.pop();
    if (node === null) {
      pieces.push("\n");
    } else if (node.nodeName === "#text") {
      pieces.push(node.value.replace(/\s+/gu, " "));
    } else if (!ignored.has(node.tagName) && !node.attrs?.some(attr => attr.name === "hidden" || (attr.name === "aria-hidden" && attr.value === "true"))) {
      if (blocks.has(node.tagName)) { pieces.push("\n"); pending.push(null); }
      for (let i = (node.childNodes?.length ?? 0) - 1; i >= 0; i--) pending.push(node.childNodes[i]);
    }
  }
  return pieces.join("").split("\n").map(line => line.trim()).filter(Boolean).join("\n");
}

async function publicHtml(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("public_https_required"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || isIP(url.hostname) ||
      !url.hostname.includes(".") || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local") ||
      url.hostname.endsWith(".internal")) throw new Error("public_https_required");
  url.hash = "";
  let timer;
  try {
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true, family: 4 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("url_dns_timeout")), 4_000); }),
    ]);
    if (!addresses.length || addresses.some(({ address }) => privateNetworks.check(address, "ipv4"))) {
      throw new Error("public_https_required");
    }
    const { address } = addresses[0];
    const response = await new Promise((resolve, reject) => {
      const req = request(url, {
        agent: false, family: 4, autoSelectFamily: false,
        lookup: (_, _options, callback) => callback(null, address, 4),
        headers: { accept: "text/html, text/plain", "accept-encoding": "identity" },
        signal: AbortSignal.timeout(12_000),
      }, resolve);
      req.once("error", reject);
      req.end();
    });
    try {
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error("url_fetch_failed");
      const type = String(response.headers["content-type"] || "");
      if (!/^text\/(html|plain)\b/iu.test(type) || ![undefined, "identity"].includes(response.headers["content-encoding"])) {
        throw new Error("unsupported_url_content");
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > maxBytes) throw new Error("source_too_large");
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const charset = type.match(/charset\s*=\s*"?([\w-]+)/iu)?.[1] ?? "utf-8";
      const decoded = new TextDecoder(charset).decode(bytes);
      const html = /^text\/html\b/iu.test(type);
      return { bytes, url: url.href, name: `${url.hostname}${html ? ".html" : ".txt"}`,
        text: html ? extractWikiHtml(decoded) : decoded.trim(), extractor: html ? "parse5-8.0.0-body-v1" : "http-text-v1", pages: 0 };
    } finally {
      response.destroy();
    }
  } finally {
    clearTimeout(timer);
  }
}

async function pdfBytes(input) {
  if (!input.file) return Buffer.from(input.base64 ?? "", "base64");
  const path = resolve(input.file);
  if (await realpath(path) !== path) throw new Error("source_symlink");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("source_too_large");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size || (await file.stat()).mtimeMs !== stat.mtimeMs) throw new Error("source_changed");
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function pdfText(input) {
  const bytes = await pdfBytes(input);
  if (bytes.length > maxBytes) throw new Error("source_too_large");
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("invalid_pdf");
  const dir = await mkdtemp(join(tmpdir(), "orgbrain-wiki-pdf-"));
  try {
    const path = join(dir, "source.pdf");
    await writeFile(path, bytes, { mode: 0o600 });
    let output, version;
    try {
      ({ stderr: version } = await run("pdftotext", ["-v"], { timeout: 2_000, maxBuffer: 16_000 }));
      ({ stdout: output } = await run("pdftotext", ["-enc", "UTF-8", path, "-"], { timeout: 15_000, maxBuffer: maxBytes }));
    } catch (error) {
      throw new Error(error.code === "ENOENT" ? "pdf_extractor_unavailable" : "pdf_extraction_failed");
    }
    const pages = output.split("\f");
    if (!pages.at(-1)?.trim()) pages.pop();
    if (!pages.some(page => page.trim())) throw new Error("pdf_text_unavailable");
    return { bytes, name: input.name || basename(input.file || "document.pdf"),
      text: pages.map((page, i) => `# Page ${i + 1}\n\n${page.trim()}`).join("\n\n"),
      pages: pages.length, extractor: `pdftotext-${version.match(/version ([\w.]+)/u)?.[1] ?? "unknown"}-pages-v1` };
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

export async function importWikiSource(service, input, epoch) {
  const result = input.kind === "pdf" ? await pdfText(input) : await publicHtml(input.url);
  if (!result.text.trim() || result.text.includes("\0")) throw new Error("source_text_unavailable");
  if (Buffer.byteLength(result.text) > maxBytes) throw new Error("extraction_too_large");
  return service.request({ op: "ingest", name: result.name, url: result.url, source_id: input.source_id,
    base64: result.bytes.toString("base64"), extracted_text: result.text,
    extractor: result.extractor, page_count: result.pages }, epoch);
}
