import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, sep, extname } from "node:path";
import { wikiStatus, setWikiFeature } from "./wiki-service.mjs";

const allowedOperations = new Set([
  "init",
  "pages",
  "read",
  "put",
  "patch",
  "search",
  "ingest",
  "sources",
  "source_read",
  "links",
  "rename",
  "delete",
  "history",
  "diff",
  "restore_revision",
  "draft",
  "drafts",
  "draft_read",
  "approve",
  "diagnose",
  "reindex_embeddings",
]);
function send(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
async function body(request) {
  if (!String(request.headers["content-type"]).startsWith("application/json"))
    throw new Error("json_required");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 12_000_000) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function createWikiHttpHandler(service, { assets } = {}) {
  const csrf = randomBytes(32).toString("hex");
  const assetCandidates = [
    fileURLToPath(new URL("../../assets/wiki", import.meta.url)),
    fileURLToPath(new URL("../assets/wiki", import.meta.url)),
  ];
  assets ||= assetCandidates.find(existsSync);
  return async (request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    const recognized =
      url.pathname.startsWith("/api/v1/wiki/") ||
      url.pathname === "/api/v1/features/llm-wiki" ||
      ["/", "/settings", "/wiki"].includes(url.pathname) ||
      url.pathname.startsWith("/wiki-ui/");
    if (!recognized) return false;
    const expectedPort = request.socket.localPort;
    const hosts = new Set([
      `127.0.0.1:${expectedPort}`,
      `localhost:${expectedPort}`,
      `[::1]:${expectedPort}`,
    ]);
    const origin = `http://${request.headers.host}`;
    if (
      !hosts.has(request.headers.host) ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        request.socket.localAddress,
      )
    ) {
      send(response, 403, { error: "host_failed" });
      return true;
    }
    if (request.method === "POST") {
      const supplied = String(request.headers["x-wiki-csrf"] || "");
      if (
        request.headers.origin !== origin ||
        !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrf))
      ) {
        send(response, 403, { error: "origin_or_csrf_failed" });
        return true;
      }
    }
    try {
      if (url.pathname === "/api/v1/features/llm-wiki") {
        if (request.method === "GET")
          send(response, 200, { ...(await wikiStatus(service.config)), csrf });
        else if (request.method === "POST") {
          const value = await body(request);
          send(
            response,
            200,
            await setWikiFeature(service.config, value.enabled, {
              autoMaintenance: value.auto_maintenance,
            }),
          );
        } else send(response, 405, { error: "method_not_allowed" });
        return true;
      }
      if (url.pathname === "/api/v1/wiki/request") {
        if (request.method !== "POST") {
          send(response, 405, { error: "method_not_allowed" });
          return true;
        }
        const input = await body(request);
        if (
          !allowedOperations.has(input.op) ||
          input.file ||
          input.from ||
          input.output ||
          (input.wiki_id && input.wiki_id !== "personal")
        )
          throw new Error("operation_not_allowed");
        if (!(await wikiStatus(service.config)).enabled)
          throw new Error("feature_disabled");
        const result =
          input.op === "search"
            ? await service.search(input)
            : input.op === "reindex_embeddings"
              ? await service.reindexEmbeddings()
              : await service.request(input);
        send(response, 200, result);
        return true;
      }
      if (url.pathname.startsWith("/api/v1/wiki/source/")) {
        if (request.method !== "GET") {
          send(response, 405, { error: "method_not_allowed" });
          return true;
        }
        const id = decodeURIComponent(
          url.pathname.slice("/api/v1/wiki/source/".length),
        );
        const result = await service.request({
          op: "source_read",
          source_id: id,
          version: Number(url.searchParams.get("version")) || undefined,
        });
        if (url.searchParams.get("download") === "1") {
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`,
            "x-content-type-options": "nosniff",
            "content-length": result.size,
          });
          let offset = 0;
          while (offset < result.size) {
            const part = await service.request({
              op: "source_read",
              source_id: id,
              version: result.version,
              raw: true,
              offset,
              length: 1_000_000,
            });
            response.write(Buffer.from(part.base64, "base64"));
            offset = part.next_offset ?? result.size;
          }
          response.end();
        } else send(response, 200, result);
        return true;
      }
      if (request.method !== "GET") {
        send(response, 405, { error: "method_not_allowed" });
        return true;
      }
      if (url.pathname === "/") {
        response.writeHead(302, { location: "/settings" });
        response.end();
        return true;
      }
      if (
        ["/wiki", "/wiki-ui/", "/wiki-ui/index.html"].includes(url.pathname) &&
        !(await wikiStatus(service.config)).enabled
      ) {
        response.writeHead(302, { location: "/settings" });
        response.end();
        return true;
      }
      if (!assets) throw new Error("wiki_ui_unavailable: run build:wiki-ui");
      const root = await realpath(assets);
      const relative =
        url.pathname === "/settings"
          ? "settings/index.html"
          : url.pathname === "/wiki"
            ? "index.html"
            : decodeURIComponent(url.pathname.slice("/wiki-ui/".length));
      const path = await realpath(resolve(root, relative));
      if (!path.startsWith(root + sep)) throw new Error("invalid_asset_path");
      const mime =
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".woff2": "font/woff2",
        }[extname(path)] || "application/octet-stream";
      response.writeHead(200, {
        "content-type": mime,
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      response.end(await readFile(path));
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return true;
      }
      const message = error.message || "wiki_request_failed";
      const status =
        message === "feature_disabled" || message.includes("conflict")
          ? 409
          : error.code === "ENOENT"
            ? 404
            : 400;
      send(response, status, { error: message });
    }
    return true;
  };
}
