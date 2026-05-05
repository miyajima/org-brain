import { collapseWhitespace } from "./memory-retrieval";

export const DECISION_TYPES = ["adopt", "reject", "prioritize", "diagnose", "workaround", "policy"] as const;
export const RATIONALE_STATUSES = ["proposed", "accepted", "superseded", "rejected"] as const;
export const CONFIRMATION_STATES = ["inferred_unconfirmed", "user_confirmed", "user_corrected"] as const;
export const ENTITY_TYPES = ["person", "service", "project", "team", "org", "document", "unknown"] as const;
export const ENTITY_ROLES = ["subject", "author", "decision_maker", "reviewer", "mentioned"] as const;
export const EVIDENCE_TYPES = ["memory", "task_event", "artifact", "doc", "file", "command", "thread", "external"] as const;
export const EVIDENCE_RELATIONS = ["supports", "contradicts", "context_for"] as const;

export type DecisionType = (typeof DECISION_TYPES)[number];
export type RationaleStatus = (typeof RATIONALE_STATUSES)[number];
export type ConfirmationState = (typeof CONFIRMATION_STATES)[number];
export type EntityType = (typeof ENTITY_TYPES)[number];
export type EntityRole = (typeof ENTITY_ROLES)[number];
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export type EvidenceRelation = (typeof EVIDENCE_RELATIONS)[number];

export type ProposedEntity = {
  name: string;
  entity_type: EntityType;
  role: EntityRole;
  confidence_score: number | null;
  external_ref?: string | null;
};

export type ProposedEvidence = {
  evidence_type: EvidenceType;
  evidence_ref: string;
  relation: EvidenceRelation;
  note?: string | null;
  weight_score: number | null;
};

export type ProposedRationale = {
  decision_type: DecisionType;
  conclusion: string;
  reason_summary: string;
  status: RationaleStatus;
  confidence_score: number | null;
};

export type RationaleProposal = {
  rationale: ProposedRationale;
  entities: ProposedEntity[];
  evidence: ProposedEvidence[];
};

const DECISION_HINTS: Array<{ type: DecisionType; patterns: RegExp[] }> = [
  { type: "reject", patterns: [/\b(reject|rejected|却下|見送り)\b/i] },
  { type: "adopt", patterns: [/\b(adopt|adopted|採用)\b/i] },
  { type: "prioritize", patterns: [/\b(prioritize|prioritized|優先)\b/i] },
  { type: "policy", patterns: [/\b(always|never|must|方針|ルール|原則)\b/i] },
  { type: "diagnose", patterns: [/\b(root cause|because|原因|理由)\b/i] },
  { type: "workaround", patterns: [/\b(workaround|fix|fixed|対処|回避|暫定)\b/i] }
];

const EVIDENCE_PATTERNS: Array<{ type: EvidenceType; regex: RegExp }> = [
  { type: "memory", regex: /\bmemory:\/\/[^\s)]+/gi },
  { type: "artifact", regex: /\br2:\/\/[^\s)]+/gi },
  { type: "task_event", regex: /\btask:\/\/[^\s)]+/gi },
  { type: "doc", regex: /\bdoc:\/\/[^\s)]+/gi },
  { type: "thread", regex: /\bthread[:/][A-Za-z0-9_-]+/gi },
  { type: "file", regex: /(?:^|\s)(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs|rb|erb|astro|md|yml|yaml|json|jsonc|sql|rs|py|sh)\b/gi },
  { type: "command", regex: /`[^`\n]+`/g },
  { type: "external", regex: /\bhttps?:\/\/[^\s)]+/gi }
];

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function splitSentences(raw: string): string[] {
  return raw
    .split(/(?<=[。.!?])\s+|\n+/)
    .map((part) => collapseWhitespace(part))
    .filter(Boolean);
}

function chooseDecisionType(text: string): DecisionType {
  for (const hint of DECISION_HINTS) {
    if (hint.patterns.some((pattern) => pattern.test(text))) return hint.type;
  }
  return "workaround";
}

function chooseConclusion(sentences: string[], summary: string | null | undefined): string {
  const summaryText = collapseWhitespace(summary ?? "");
  if (summaryText) return clip(summaryText, 240);
  const preferred =
    sentences.find((sentence) => /(結論|方針|採用|却下|priority|recommend|decide|decided)/i.test(sentence)) ||
    sentences[0] ||
    "No conclusion extracted";
  return clip(preferred, 240);
}

function chooseReasonSummary(sentences: string[], text: string): string {
  const selected = sentences.filter((sentence) => /(原因|理由|because|root cause|対処|workaround|fix|方針|must|never)/i.test(sentence));
  const source = (selected.length > 0 ? selected : sentences.slice(0, 3)).slice(0, 3);
  return clip(source.join(" ").trim() || text, 500);
}

function inferEntityType(name: string): EntityType {
  if (/[A-Z][a-z]+ [A-Z][a-z]+/.test(name) || /さん$/.test(name)) return "person";
  if (/team|squad|部|チーム/i.test(name)) return "team";
  if (/service|api|worker|gateway|runner|wrangler|cloudflare|d1|r2|mcp/i.test(name)) return "service";
  if (/project|proj|org-brain/i.test(name)) return "project";
  return "unknown";
}

function extractEntities(text: string, projectId?: string | null): ProposedEntity[] {
  const found = new Map<string, ProposedEntity>();
  const candidates = [
    ...text.matchAll(/\b[A-Z][A-Za-z0-9_-]{2,}\b/g),
    ...text.matchAll(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g),
    ...text.matchAll(/[一-龠ぁ-んァ-ヶA-Za-z0-9_-]+さん/g)
  ]
    .map((match) => collapseWhitespace(match[0]))
    .filter((value) => value.length >= 2)
    .slice(0, 8);

  for (const candidate of candidates) {
    if (!found.has(candidate)) {
      found.set(candidate, {
        name: candidate,
        entity_type: inferEntityType(candidate),
        role: "subject",
        confidence_score: 0.45,
        external_ref: null
      });
    }
  }

  if (projectId && !found.has(projectId)) {
    found.set(projectId, {
      name: projectId,
      entity_type: "project",
      role: "mentioned",
      confidence_score: 0.9,
      external_ref: null
    });
  }

  return [...found.values()].slice(0, 8);
}

function extractEvidence(text: string): ProposedEvidence[] {
  const results: ProposedEvidence[] = [];
  for (const { type, regex } of EVIDENCE_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const ref = type === "command" ? match[0].slice(1, -1).trim() : collapseWhitespace(match[0]);
      if (!ref) continue;
      results.push({
        evidence_type: type,
        evidence_ref: ref,
        relation: "supports",
        note: null,
        weight_score: 0.6
      });
      if (results.length >= 8) return results;
    }
  }
  return results;
}

export function extractRationaleProposal(args: {
  content: string;
  summary?: string | null;
  projectId?: string | null;
  entities?: ProposedEntity[];
  evidence?: ProposedEvidence[];
}): RationaleProposal {
  const normalized = collapseWhitespace(args.content);
  const sentences = splitSentences(args.content);
  const decisionType = chooseDecisionType(normalized);
  const rationale: ProposedRationale = {
    decision_type: decisionType,
    conclusion: chooseConclusion(sentences, args.summary),
    reason_summary: chooseReasonSummary(sentences, normalized),
    status: "accepted",
    confidence_score: 0.55
  };

  return {
    rationale,
    entities: (args.entities && args.entities.length > 0 ? args.entities : extractEntities(args.content, args.projectId)).slice(0, 8),
    evidence: (args.evidence && args.evidence.length > 0 ? args.evidence : extractEvidence(args.content)).slice(0, 8)
  };
}
