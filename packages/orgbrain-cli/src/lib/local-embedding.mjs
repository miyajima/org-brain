import { createHash } from "node:crypto";

export const LOCAL_EMBEDDING_PROVIDER = "local-sparse-feature-hash-v2";
export const LOCAL_EMBEDDING_FEATURE_LIMIT = 32;

const CONCEPT_GROUPS = [
  ["automobile", "car", "vehicle", "auto", "自動車", "車両"],
  ["delete", "remove", "erase", "削除", "消去"],
  ["decision", "choice", "決定", "判断"],
  ["constraint", "policy", "rule", "制約", "方針", "規則"],
  ["failure", "error", "bug", "失敗", "エラー", "不具合"],
  ["backup", "snapshot", "バックアップ", "復元"],
  ["credential", "secret", "token", "資格情報", "秘密", "トークン"],
  ["memory", "knowledge", "記憶", "メモリ", "知識"],
  ["doctor", "physician", "dermatologist", "clinician", "医師", "医者"],
  ["publication", "paper", "article", "conference", "research", "論文", "学会", "研究"],
  ["sibling", "brother", "sister", "きょうだい", "兄弟", "姉妹"],
  ["ingredient", "recipe", "meal", "dinner", "food", "cooking", "cook", "baking", "bake", "dish", "dessert", "食材", "レシピ", "料理"],
  ["homegrown", "garden", "harvest", "grow", "栽培", "庭", "収穫"],
  ["appliance", "smoker", "oven", "grill", "blender", "toaster", "家電", "調理器具"],
  ["battery", "power", "charger", "charging", "バッテリー", "充電", "電源"],
  ["milestone", "launch", "achievement", "breakthrough", "節目", "達成"]
];

const CONCEPT_BY_TERM = new Map(
  CONCEPT_GROUPS.flatMap((group, index) => group.map((term) => [term, `concept:${index}`]))
);

function hashFeature(value) {
  return createHash("sha256").update(value, "utf8").digest().readInt32BE(0);
}

function stemAscii(token) {
  if (!/^[a-z][a-z0-9_-]+$/.test(token)) return token;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (token.length > suffix.length + 3 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

function termsForText(text) {
  const normalized = String(text).normalize("NFKC").toLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const terms = [];
  for (const rawToken of tokens) {
    const token = stemAscii(rawToken);
    if (token.length >= 2) terms.push(`term:${token}`);
    const concept = CONCEPT_BY_TERM.get(token);
    if (concept) terms.push(concept);
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token) && token.length >= 3) {
      for (let index = 0; index <= token.length - 3; index += 1) {
        terms.push(`cjk3:${token.slice(index, index + 3)}`);
      }
    }
  }
  return terms;
}

export function embedLocalText(text, limit = LOCAL_EMBEDDING_FEATURE_LIMIT) {
  const counts = new Map();
  for (const term of termsForText(text)) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const weighted = [...counts.entries()]
    .map(([term, count]) => ({ feature_hash: hashFeature(term), weight: 1 + Math.log(count) }))
    .sort((left, right) => right.weight - left.weight || left.feature_hash - right.feature_hash)
    .slice(0, limit);
  const norm = Math.sqrt(weighted.reduce((sum, feature) => sum + feature.weight ** 2, 0)) || 1;
  return weighted.map((feature) => ({
    feature_hash: feature.feature_hash,
    weight: feature.weight / norm
  }));
}

export function localEmbeddingText(record) {
  return [
    record.summary ?? "",
    record.content ?? "",
    ...(Array.isArray(record.tags) ? record.tags : []),
    ...(Array.isArray(record.entities) ? record.entities : [])
  ].join("\n");
}
