import { open, stat } from "node:fs/promises";

const MAX_STATIC_INSTRUCTION_SCAN_BYTES = 1024 * 1024;

function transcriptPathOf(payload) {
  const value = payload?.transcript_path ?? payload?.transcriptPath ?? payload?.metadata?.transcript_path ?? payload?.metadata?.transcriptPath;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Which of the given static instruction markers already sit in a developer
// message after the latest compaction. Only transcript evidence counts: hook
// output that was dropped before reaching the model is delivered again.
export async function deliveredStaticInstructions(payload, markers) {
  const found = new Set();
  const transcriptPath = transcriptPathOf(payload);
  if (!transcriptPath || markers.length === 0) return found;
  try {
    const info = await stat(transcriptPath);
    if (!info.isFile() || info.size === 0) return found;
    const size = Math.min(info.size, MAX_STATIC_INSTRUCTION_SCAN_BYTES);
    const handle = await open(transcriptPath, "r");
    let raw;
    try {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, info.size - size);
      raw = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
    if (info.size > size) raw = raw.slice(Math.max(0, raw.indexOf("\n") + 1));
    for (const line of raw.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const item = row?.payload ?? row;
      if (row?.type === "compacted" || item?.type === "compacted") { found.clear(); continue; }
      if (item?.type !== "message" || item.role !== "developer") continue;
      const text = typeof item.content === "string" ? item.content : (item.content ?? []).map((part) => part?.text ?? "").join("\n");
      for (const marker of markers) if (text.includes(marker)) found.add(marker);
    }
  } catch {
    return new Set();
  }
  return found;
}
