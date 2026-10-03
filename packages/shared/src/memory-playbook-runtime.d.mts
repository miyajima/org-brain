export type ProjectMemoryScope = { level: 'project'; project_id: string };
export type TaskMemoryScope = { level: 'task'; project_id: string; task_key: string; expires_at: string };
export type MemoryScope = ProjectMemoryScope | TaskMemoryScope;
export type TaskMemoryConstraint = { decision_key: string; max_calls?: number; max_cost?: number; currency?: 'USD' };
export type MemoryPlaybookSource = { ref: string; version: string; content_hash: string; evidence_status: 'supplied_unverified' };
export type MemoryPlaybookStep = {
  command: { executable: 'fixture-jobctl' | 'gcloud'; args: string[]; tool_version: string; validation_state: 'template_checked_unverified' };
  expected_output: string; stop_when: string; on_failure: string;
};
export type MemoryPlaybook = {
  schema_version: 'memory-playbook/v1'; scope: ProjectMemoryScope; sources: MemoryPlaybookSource[];
  prerequisites: string; steps: MemoryPlaybookStep[]; refresh_when: string; verification_state: 'unverified';
};
export function normalizeMemoryScope(value: unknown, projectId: string): MemoryScope;
export function normalizeTaskConstraint(value: unknown, scope: MemoryScope | undefined, occurredAt: string): TaskMemoryConstraint;
export function normalizeMemoryPlaybook(value: unknown, scope: MemoryScope | undefined): MemoryPlaybook;
export function renderMemoryPlaybook(playbook: MemoryPlaybook): string;
