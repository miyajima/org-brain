import { normalizeMemoryContractV2Event } from './memory-contract-v2-runtime.mjs';
import { validateV3Candidate } from './memory-extraction-v3-runtime.mjs';
import { validateCoverageCandidate } from './memory-extraction-coverage-runtime.mjs';
const MAX_CANDIDATES = 3;
const DURABLE_MEMORY_KINDS = new Set(['fact', 'decision', 'constraint', 'pitfall', 'preference', 'org_knowledge']);
const REFINED_CONTROL_FIELDS = new Set(['persistence', 'memory_kind', 'action', 'target_memory_id', 'decision_type']);
async function sha256(value) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2,'0')).join(''); }
function stableValue(value) { if (Array.isArray(value)) return value.map(stableValue); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.keys(value).sort().map(k => [k, stableValue(value[k])])); }
function exactGrounded(value, evidenceText, rejections, field) {
    if (value === null || typeof value !== "string" || !value.trim())
        return null;
    const exact = value.trim();
    if (evidenceText.includes(exact))
        return exact;
    rejections.push(`${field}_not_exactly_grounded`);
    return null;
}
function providerFields(raw) {
    const output = new Map();
    for (const field of Array.isArray(raw.fields) ? raw.fields : []) {
        if (!field || typeof field.name !== "string" || !Array.isArray(field.values))
            continue;
        const values = field.values.filter((value) => typeof value === "string").slice(0, 16);
        if (values.length > 0)
            output.set(field.name, [...(output.get(field.name) ?? []), ...values].slice(0, 16));
    }
    return output;
}
function sanitizeRefinedCandidate(raw, packet) {
    if (!raw || typeof raw !== 'object') return { candidate: raw, omitted: false };
    const snippetIds = new Set((packet.snippets ?? []).map((item) => item.span_id));
    const eventIds = new Set((packet.events ?? []).map((item) => item.event_id));
    const eventByCallId = new Map((packet.events ?? []).filter((item) => item.call_id && item.event_id).map((item) => [item.call_id, item.event_id]));
    const originalSupport = Array.isArray(raw.support_span_ids) ? raw.support_span_ids : [];
    let normalizedSupport = [...new Set(originalSupport.map((id) =>
        snippetIds.has(id) || eventIds.has(id) ? id : eventByCallId.get(id) ?? id))];
    const explicitDecisionLane = raw.lesson_type === "decision"
        && (packet.routing?.reason_codes ?? []).includes("explicit_user_decision_search");
    if (explicitDecisionLane) {
        const userSupport = normalizedSupport.filter((id) => (packet.snippets ?? []).some((item) => item.span_id === id && item.role === "user"));
        if (userSupport.length > 0) normalizedSupport = userSupport;
    }
    const support = new Set(normalizedSupport);
    const snippets = (packet.snippets ?? []).filter((item) => support.has(item.span_id));
    const explicitDecisionUserText = explicitDecisionLane
        ? snippets.find((item) => item.role === "user" && typeof item.text === "string" && item.text.trim())?.text.trim() ?? null
        : null;
    let omitted = normalizedSupport.length !== originalSupport.length
        || normalizedSupport.some((id, index) => id !== originalSupport[index]);
    const fields = (Array.isArray(raw.fields) ? raw.fields : []).flatMap((field) => {
        if (!field || typeof field.name !== 'string' || !Array.isArray(field.values)) return [];
        let values = field.values.filter((value) => typeof value === 'string');
        if (!REFINED_CONTROL_FIELDS.has(field.name)) values = values.filter((value) => snippets.some((snippet) => String(snippet.text).includes(value)));
        if (field.name === "decision" && explicitDecisionUserText
            && !values.some((value) => snippets.some((snippet) => snippet.role === "user" && String(snippet.text).includes(value)))) {
            values = [explicitDecisionUserText];
            omitted = true;
        }
        if (field.name === 'memory_kind') {
            const compatible = raw.lesson_type === 'failure' ? new Set(['pitfall']) : raw.lesson_type === 'decision'
                ? new Set(['decision', 'constraint', 'preference']) : new Set(['fact', 'org_knowledge']);
            values = values.filter((value) => compatible.has(value));
        }
        if (values.length !== field.values.length) omitted = true;
        return values.length > 0 ? [{ ...field, values }] : [];
    });
    return { candidate: { ...raw, support_span_ids: normalizedSupport, fields }, omitted };
}
function inferredDecisionType(evidenceText) {
    if (/\b(?:policy|governance|approval|permission|acl|must|never)\b|(?:規約|承認|権限|禁止|必須)/iu.test(evidenceText))
        return "governance";
    if (/\b(?:prefer|preference)\b|(?:好む|希望|優先)/iu.test(evidenceText))
        return "preference";
    if (/\b(?:api|schema|architecture|implementation|library|framework|database|runtime)\b|(?:API|スキーマ|設計|実装|ライブラリ|フレームワーク|データベース|ランタイム)/iu.test(evidenceText))
        return "implementation";
    return null;
}
export async function verifiedCandidates(input, candidates) {
    const v3 = input.packet.schema === "learning-extraction-proposal/v3";
    if (v3 && candidates.length > MAX_CANDIDATES)
        throw new Error("provider_failed:candidate_count_exceeded");
    const refinementProfile = input.refinement_profile ?? input.packet?.refinement_profile ?? null;
    const snippetIds = new Set(input.packet.snippets.map((item) => item.span_id));
    const eventIds = new Set(input.packet.events.map((item) => String(item.event_id ?? "")).filter(Boolean));
    const resolvesSupportId = (id) => eventIds.has(id) || snippetIds.has(id);
    const output = [];
    const acceptedIndices = [];
    const rejections = [];
    const reject = (candidateIndex, reasonCodes) => {
        rejections.push({ candidate_index: candidateIndex, reason_codes: [...new Set(reasonCodes)].sort() });
    };
    for (const [index, providerCandidate] of candidates.entries()) {
        const refined = refinementProfile ? sanitizeRefinedCandidate(providerCandidate, input.packet) : { candidate: providerCandidate, omitted: false };
        const raw = refined.candidate;
        if (raw?.lesson_type === "failure") {
            const failureFields = providerFields(raw);
            const hasFailureEvidence = ["symptom", "failed_approach", "root_cause", "correction", "verified_outcome", "avoidance_rule"]
                .some((name) => (failureFields.get(name) ?? []).length > 0);
            if (!hasFailureEvidence) {
                reject(index, ["failure_evidence_missing"]);
                continue;
            }
        }
        if (input.extraction_profile || refinementProfile) {
            const coverageValidation = validateCoverageCandidate(raw, input.packet);
            if (!coverageValidation.valid) {
                reject(index, coverageValidation.reason_codes);
                continue;
            }
        }
        if (v3) {
            const validation = validateV3Candidate(raw, input.packet);
            if (!validation.valid) {
                reject(index, [validation.reason ?? "candidate_schema_invalid"]);
                continue;
            }
        }
        if (!raw || !["success", "decision", "failure"].includes(raw.lesson_type)) {
            reject(index, ["lesson_type_invalid"]);
            continue;
        }
        const supportSpanIds = Array.isArray(raw.support_span_ids)
            ? [...new Set(raw.support_span_ids.filter((id) => typeof id === "string"))].slice(0, 16)
            : [];
        if (supportSpanIds.length === 0) {
            reject(index, ["support_missing"]);
            continue;
        }
        if (supportSpanIds.some((id) => !resolvesSupportId(id))) {
            reject(index, ["support_id_unresolved"]);
            continue;
        }
        const supportedSnippets = input.packet.snippets.filter((item) => supportSpanIds.includes(item.span_id));
        const evidenceText = supportedSnippets.map((item) => item.text).join("\n");
        const gaps = Array.isArray(raw.gaps) ? raw.gaps.filter((item) => typeof item === "string").slice(0, 16) : [];
        const groundingRejections = [];
        const fields = providerFields(raw);
        const one = (name) => fields.get(name)?.[0] ?? null;
        const many = (name) => fields.get(name) ?? [];
        const grounded = (value, field) => exactGrounded(value, evidenceText, groundingRejections, field);
        const persistence = one("persistence") === "operational_history" ? "operational_history" : "durable";
        if (one("persistence") && !["durable", "operational_history"].includes(one("persistence"))) {
            reject(index, ["persistence_invalid"]);
            continue;
        }
        const defaultKind = raw.lesson_type === "failure" ? "pitfall" : raw.lesson_type === "success" ? "org_knowledge" : "decision";
        const requestedKind = one("memory_kind");
        const compatibleKinds = raw.lesson_type === "failure"
            ? new Set(["pitfall"])
            : raw.lesson_type === "decision"
                ? new Set(["decision", "constraint", "preference"])
                : new Set(["fact", "org_knowledge"]);
        if (requestedKind && (persistence === "operational_history" ? requestedKind !== "episodic" : !compatibleKinds.has(requestedKind))) {
            reject(index, ["lesson_memory_kind_mismatch"]);
            continue;
        }
        const memoryKind = persistence === "operational_history"
            ? "episodic"
            : requestedKind && DURABLE_MEMORY_KINDS.has(requestedKind) ? requestedKind : defaultKind;
        const requestedAction = one("action") ?? "create";
        if (!["create", "skip", "update", "conflict"].includes(requestedAction)) {
            reject(index, ["action_invalid"]);
            continue;
        }
        // A provider-side skip is an auditable no-candidate decision, not a memory
        // proposal. It must never create a quarantine row that could be promoted.
        if (requestedAction === "skip") {
            reject(index, ["provider_skip"]);
            continue;
        }
        const targetMemoryId = one("target_memory_id");
        const suppliedMemoryIds = new Set((input.packet.existing_memories ?? []).map((item) => item.id));
        if (requestedAction !== "create" && (!targetMemoryId || !suppliedMemoryIds.has(targetMemoryId))) {
            reject(index, ["target_memory_id_unsearched"]);
            continue;
        }
        const decisionType = raw.lesson_type === "decision" ? (v3 ? one("decision_type") : inferredDecisionType(evidenceText)) : null;
        if (raw.lesson_type === "decision" && !decisionType)
            gaps.push("decision_type_missing");
        if (raw.lesson_type === "decision" && one("decision_type") && one("decision_type") !== decisionType)
            gaps.push("decision_type_unsupported");
        const common = {
            record_type: "learning_observation",
            schema_version: 2,
            lesson_type: raw.lesson_type,
            capture_intent: "review",
            trigger: grounded(one("trigger"), "trigger"),
            applicability: {
                target_files: many("target_files").flatMap((item) => {
                    const value = grounded(item, "target_files");
                    return value && !value.startsWith("/") ? [value] : [];
                }),
                components: input.project_id ? [input.project_id] : []
            },
            evidence_selectors: input.packet.snippets.filter((item) => supportSpanIds.includes(item.span_id)).filter((item) => item.role === "user").map((item) => ({ type: "user_statement", ref: item.text, supports: [item.span_id] })),
            gaps: [...new Set(gaps)]
        };
        if (raw.lesson_type === "success")
            Object.assign(common, {
                procedure: grounded(one("procedure"), "procedure"),
                why_it_worked: grounded(one("why_it_worked"), "why_it_worked"),
                observed_outcome: grounded(one("observed_outcome"), "observed_outcome"),
                reuse_when: grounded(one("reuse_when"), "reuse_when")
            });
        if (raw.lesson_type === "decision")
            Object.assign(common, {
                decision_type: decisionType,
                decision_key: `inferred.${(await sha256(input.extraction_profile
                    ? JSON.stringify(stableValue({ lesson_type: raw.lesson_type, support_span_ids: [...supportSpanIds].sort(), fields: raw.fields }))
                    : `${input.run_id}:${index}`)).slice(0, 24)}`,
                question: grounded(one("question"), "question"),
                selected_value: grounded(one("selected_value"), "selected_value"),
                decision: grounded(one("decision"), "decision"),
                constraints: many("constraints").flatMap((item) => {
                    const value = grounded(item, "constraints");
                    return value ? [value] : [];
                }),
                rationale: grounded(one("rationale"), "rationale"),
                alternatives: many("alternative").flatMap((item, alternativeIndex) => {
                    const alternative = grounded(item, "alternative");
                    if (!alternative)
                        return [];
                    return [{ alternative, reason_rejected: grounded(many("reason_rejected")[alternativeIndex] ?? null, "reason_rejected") }];
                }),
                reuse_when: grounded(one("reuse_when"), "reuse_when")
            });
        if (raw.lesson_type === "failure")
            Object.assign(common, {
                symptom: grounded(one("symptom"), "symptom"),
                failed_approach: grounded(one("failed_approach"), "failed_approach"),
                root_cause: grounded(one("root_cause"), "root_cause"),
                correction: grounded(one("correction"), "correction"),
                verified_outcome: grounded(one("verified_outcome"), "verified_outcome"),
                avoidance_rule: grounded(one("avoidance_rule"), "avoidance_rule")
            });
        if (groundingRejections.length > 0) {
            reject(index, groundingRejections);
            continue;
        }
        common.gaps = [...new Set(gaps)];
        const normalized = await normalizeMemoryContractV2Event(common, { sensitivePolicy: { mode: "deny", allowed_principals: [] } });
        if (!normalized.accepted || !normalized.event) {
            reject(index, ["normalized_contract_rejected"]);
            continue;
        }
        acceptedIndices.push(index);
        output.push({
            external_key: `memory-extraction:${input.run_id}:${normalized.event_hash}`,
            observation: normalized.event,
            persistence,
            memory_kind: memoryKind,
            action: requestedAction,
            target_memory_id: requestedAction === "create" ? null : targetMemoryId,
            support_span_ids: supportSpanIds,
            gaps: normalized.event.gaps,
            reason_codes: [...new Set(["llm_proposed_review_only", ...(refined.omitted ? ["unsupported_provider_fields_omitted"] : []), ...normalized.reason_codes])]
        });
    }
    return { candidates: output.slice(0, MAX_CANDIDATES), rejections, accepted_indices: acceptedIndices.slice(0, MAX_CANDIDATES) };
}
