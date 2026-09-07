/*
 * Transport contracts for the v1.2 experiment.
 *
 * The runner accepts a deliberately small JSON Schema subset. Semantic
 * constraints (exact quotations, retention, relationships and harm checks)
 * are enforced by memory-utility-v12.mjs after the runner returns. Source
 * evidence is selected by bounded ordinal token in transport; canonical IDs
 * and quotes are hydrated from the private, ordered source spans after parsing.
 */

export const V12_CATEGORIES = Object.freeze(['decision', 'failure', 'operational', 'reference']);
export const V12_STATUSES = Object.freeze(['proposed', 'adopted', 'observed', 'unknown']);
export const V12_ROLES = Object.freeze(['user', 'tool', 'assistant', 'unknown', 'mixed']);
export const V12_RELATIONS = Object.freeze(['create', 'duplicate', 'update', 'conflict']);
export const V12_QUALITY_KINDS = Object.freeze([
  'fabricated_reason', 'false_adoption', 'false_resolution', 'overretention', 'omission', 'fragmented_incident'
]);
export const V12_FIELD_NAMES = Object.freeze([
  'content', 'decision', 'rationale', 'symptom', 'cause', 'correction', 'outcome', 'reuse_when', 'scope'
]);
export const V12_CERTAINTIES = Object.freeze(['verified', 'observed', 'reported', 'proposed', 'adopted', 'unknown']);

// Structured Outputs counts every value in every enum toward its schema-wide
// enum budget. A flat enum for every source span would therefore fail on
// multi-line turns (some cases contain more than 400 spans). Transport uses
// a bounded `span-N` / `item-N` ordinal token with runtime range checks instead
// of repeating those values in the output schema. The remaining semantic
// enums stay well below the official 1000-value limit.
export const V12_MAX_SPAN_REFS = 512;
export const V12_MAX_ITEM_REFS = 96;
export const V12_SPAN_REF_ENUM = Object.freeze(
  Array.from({length: V12_MAX_SPAN_REFS}, (_, index) => `span-${index + 1}`)
);
export const V12_ITEM_REF_ENUM = Object.freeze(
  Array.from({length: V12_MAX_ITEM_REFS}, (_, index) => `item-${index + 1}`)
);

const evidenceEntry = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {id: {type: 'string'}}
});

const fieldEvidence = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: V12_FIELD_NAMES,
  properties: Object.fromEntries(V12_FIELD_NAMES.map(name => [name, {
    type: 'array',
    items: evidenceEntry
  }]))
});

const fieldCertainty = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: V12_FIELD_NAMES,
  properties: Object.fromEntries(V12_FIELD_NAMES.map(name => [name, {
    type: 'string',
    enum: V12_CERTAINTIES
  }]))
});

export const V12_C_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      maxItems: V12_MAX_ITEM_REFS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id', 'category', 'subtype', 'incident_id', 'status', 'source_role',
          ...V12_FIELD_NAMES, 'field_certainty', 'gaps', 'evidence', 'support_ids', 'relation', 'target_ids'
        ],
        properties: {
          id: {type: 'string'},
          category: {type: 'string', enum: V12_CATEGORIES},
          subtype: {type: 'string', enum: ['settings', 'testcounts', 'other', 'unknown']},
          incident_id: {type: 'string'},
          status: {type: 'string', enum: V12_STATUSES},
          source_role: {type: 'string', enum: V12_ROLES},
          ...Object.fromEntries(V12_FIELD_NAMES.map(name => [name, {type: 'string'}])),
          field_certainty: fieldCertainty,
          gaps: {type: 'array', items: {type: 'string'}},
          evidence: fieldEvidence,
          support_ids: {type: 'array', items: {type: 'string'}},
          relation: {type: 'string', enum: V12_RELATIONS},
          target_ids: {type: 'array', items: {type: 'string'}}
        }
      }
    }
  }
});

export const V12_REPLAY_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'used_memory_ids'],
  properties: {
    answer: {type: 'string'},
    used_memory_ids: {type: 'array', items: {type: 'string'}}
  }
});

const metricSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['rating', 'reason', 'support_ids'],
  properties: {
    rating: {type: 'string', enum: ['meets', 'partial', 'fails', 'unknown']},
    reason: {type: 'string'},
    support_ids: {type: 'array', items: {type: 'string'}}
  }
});

const harmMetricSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'rating', 'reason', 'support_ids', 'checked_answer_id', 'checked_memory_ids',
    'problematic_answer_passage', 'causal_memory_id', 'constraint_support_ids',
    'missing_evidence_reason'
  ],
  properties: {
    rating: {type: 'string', enum: ['meets', 'partial', 'fails', 'unknown']},
    reason: {type: 'string'},
    support_ids: {type: 'array', items: {type: 'string'}},
    checked_answer_id: {type: 'string'},
    checked_memory_ids: {type: 'array', items: {type: 'string'}},
    problematic_answer_passage: {type: 'string'},
    causal_memory_id: {type: 'string'},
    constraint_support_ids: {type: 'array', items: {type: 'string'}},
    missing_evidence_reason: {type: 'string'}
  }
});

export const V12_EVALUATION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['answers', 'extraction_issues'],
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'metrics', 'major_memory_errors'],
        properties: {
          id: {type: 'string', enum: ['answer-1', 'answer-2', 'answer-3']},
          metrics: {
            type: 'object',
            additionalProperties: false,
            required: ['continuation', 'constraints', 'recurrence_prevention', 'memory_harm'],
            properties: {
              continuation: metricSchema,
              constraints: metricSchema,
              recurrence_prevention: metricSchema,
              memory_harm: harmMetricSchema
            }
          },
          major_memory_errors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['description', 'support_ids'],
              properties: {
                description: {type: 'string'},
                support_ids: {type: 'array', items: {type: 'string'}}
              }
            }
          }
        }
      }
    },
    extraction_issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['answer_id', 'item_id', 'kind', 'reason', 'support_ids'],
        properties: {
          answer_id: {type: 'string'},
          item_id: {type: 'string'},
          kind: {type: 'string', enum: ['unsupported', 'duplicate', 'retention', 'missed_update', 'fragmented_incident']},
          reason: {type: 'string'},
          support_ids: {type: 'array', items: {type: 'string'}}
        }
      }
    }
  }
});

const qualityCheckedSetEntry = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {id: {type: 'string'}}
});

const qualityItemCheck = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['item_id', 'checked_fields', 'support_ids'],
  properties: {
    item_id: {type: 'string'},
    checked_fields: {type: 'array', items: {type: 'string', enum: V12_FIELD_NAMES}, maxItems: V12_FIELD_NAMES.length},
    support_ids: {type: 'array', items: {type: 'string'}}
  }
});

const qualityFinding = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'item_id', 'reason', 'support_ids'],
  properties: {
    kind: {type: 'string', enum: V12_QUALITY_KINDS},
    item_id: {type: 'string'},
    reason: {type: 'string'},
    support_ids: {type: 'array', items: {type: 'string'}}
  }
});

const qualityPositiveEvidence = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'result', 'reason', 'support_ids'],
  properties: {
    kind: {type: 'string', enum: V12_QUALITY_KINDS},
    result: {type: 'string', enum: ['passed', 'failed', 'unknown']},
    reason: {type: 'string'},
    support_ids: {type: 'array', items: {type: 'string'}}
  }
});

export const V12_QUALITY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['status', 'checked_kinds', 'checked_set', 'item_checks', 'findings', 'positive_evidence'],
  properties: {
    status: {type: 'string', enum: ['passed', 'failed', 'unknown']},
    checked_kinds: {type: 'array', items: {type: 'string', enum: V12_QUALITY_KINDS}},
    checked_set: {type: 'array', items: qualityCheckedSetEntry},
    item_checks: {type: 'array', items: qualityItemCheck},
    findings: {type: 'array', items: qualityFinding},
    positive_evidence: {type: 'array', items: qualityPositiveEvidence}
  }
});

export const V12_SCHEMA_NAMES = Object.freeze({
  'extract-b': 'frozen-v2-b',
  'extract-c': 'v12-c',
  'calibrate-c': 'v12-c',
  replay: 'v12-replay',
  evaluate: 'v12-evaluation',
  quality: 'v12-quality'
});
