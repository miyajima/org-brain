// Shared local/Cloud interactive review screening. Preserve provenance; reject
// sensitive review text rather than silently rewriting the human-reviewed fields.
function calendarIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function screenInteractiveMemory(value, field, { referenceDates = false, proseDates = false } = {}) {
  // A truncated phone candidate must not turn into an allowed date prefix.
  if (proseDates && typeof value === 'string' && value.length > 20_000) throw new Error(`${field}_too_large`);
  const text = typeof value === 'string' && value.trim() ? value.trim().slice(0, 20_000) : null;
  if (!text) throw new Error(`${field}_required`);
  const sensitivePatterns = [
    /\b(?:api[_-]?key|client[_-]?secret|password|passwd|token)\s*[:=]\s*[^\s,;]+/iu,
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu
  ];
  // Inspect original bytes and NFKC in provenance as well as prose. Preserve the
  // original value, but never let compatibility characters hide credentials.
  const inspectedTexts = [text, text.normalize('NFKC')];
  for (const inspected of inspectedTexts) {
    const sensitivePhone = [...inspected.matchAll(/(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/gu)].some(match => {
      const referenceDate = referenceDates && match.index >= referenceDates.pathStart;
      const proseDate = proseDates && !/(?:tel|mailto):\s*$/iu.test(inspected.slice(0, match.index));
      // Test the whole phone candidate, never just a date-shaped prefix.
      return !(referenceDate || proseDate) || !calendarIsoDate(match[0]);
    });
    if (sensitivePhone || sensitivePatterns.some((pattern) => pattern.test(inspected))) {
      throw new Error(`${field}_contains_sensitive_data`);
    }
  }
  return text;
}

export function screenInteractiveProse(value, field) {
  return screenInteractiveMemory(value, field, { proseDates: true });
}

export function screenReviewReference(value) {
  // Only a complete phone-pattern match that is a valid ISO date may pass in
  // a clean HTTPS or canonical repo-relative path. Never exempt the project
  // identifier, rewrite the reference, or hide it from credential/email checks.
  let referenceDates = false;
  if (/^repo:/iu.test(value)) {
    const repo = /^repo:([A-Za-z0-9][A-Za-z0-9._:-]*)\/([\p{L}\p{N}._/-]+)$/u.exec(value);
    if (!repo || value !== value.normalize('NFKC') || repo[2].split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error('invalid_review_source');
    }
    referenceDates = { pathStart: value.indexOf('/') + 1 };
  } else try {
    const url = new URL(value);
    const pathStart = value.indexOf('/', value.indexOf('://') + 3);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && pathStart >= 0) referenceDates = { pathStart };
  } catch { /* Non-URL references keep the strict screen. */ }
  return screenInteractiveMemory(value, 'review_source', { referenceDates });
}

export function normalizeMemoryReviewContext(raw) {
  if(raw===undefined) return undefined;
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||typeof raw.candidate_id!=='string'||!raw.candidate_id||raw.candidate_id.length>128
    ||!(/^[a-f0-9]{64}$/u.test(raw.candidate_hash))||!Array.isArray(raw.source_references)||raw.source_references.length>8) throw new Error('invalid_review_context');
  const value={candidate_id:raw.candidate_id,candidate_hash:raw.candidate_hash,
    source_references:raw.source_references.map(ref=>{
      if(!ref||typeof ref!=='object'||typeof ref.ref!=='string'||!ref.ref||ref.ref.length>512) throw new Error('invalid_review_source');
      const structuralRef=/^turn:(?:sha256:)?[a-f0-9]{64}#[A-Za-z0-9._:-]+$/u.test(ref.ref);
      const result={ref:structuralRef?ref.ref:screenReviewReference(ref.ref)};
      for(const key of ['type','span_id','parent_span_id','role','content_hash']) if(ref[key]!=null) {
        if(typeof ref[key]!=='string'||ref[key].length>128) throw new Error('invalid_review_source');
        const opaqueSpan = ['span_id', 'parent_span_id'].includes(key) && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(ref[key]);
        result[key]=opaqueSpan || key==='content_hash'&&/^(?:sha256:)?[a-f0-9]{64}$/u.test(ref[key])?ref[key]:screenInteractiveMemory(ref[key],'review_source');
      }
      return result;
    })};
  for(const key of ['conclusion','reason_summary','reuse_rule']) if(raw[key]!=null) {
    if(typeof raw[key]!=='string'||raw[key].length>2000) throw new Error('invalid_review_context');
    value[key]=screenInteractiveProse(raw[key],key);
  }
  return value;
}
