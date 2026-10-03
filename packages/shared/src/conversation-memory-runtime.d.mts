import type { MemoryReviewContext } from './memory-review-runtime.mjs';
export const CONVERSATION_MEMORY_SCHEMA: 'conversation-memory/v1';
export type ConversationMemoryCandidate = {
  id: string; candidate_hash: string; category: 'decision'; conclusion: string; reason: string;
  reuse_rule: string; project_id: string; work_type: string; external_key: string;
  memory_type?: 'lesson' | 'playbook' | 'task_constraint'; scope?: Record<string, any>; playbook?: Record<string, any>; task_constraint?: Record<string, any>;
  confirmation_only: true; provenance: Record<string, unknown>;
  source_references: Array<Record<string, unknown>>; evidence: Array<Record<string, unknown>>;
  proposal: { tenant_id: string; source: string; item: {
    content: string; summary: string; project_id: string; work_type: string;
    external_key: string; tags: string[];
  }; review_context: MemoryReviewContext };
};
export type ConversationMemoryPlan = {
  schema_version: 'conversation-memory/v1'; tenant_id: string; project_id: string;
  task_key: string; producer: string; event_id: string; occurred_at: string;
  active_memories_created: 0; verification_state: 'unverified'; requires_confirmation: true;
  redacted_fields: string[]; candidates: ConversationMemoryCandidate[]; plan_hash: string;
};
export function planConversationMemory(input: unknown): ConversationMemoryPlan;
