export type TaskQueryClause = { groups: string[][]; fts: string; literal_subjects: string[]; strict_literal_subjects: string[] };
export type TaskQueryPlan = { groups: string[][]; clauses: TaskQueryClause[]; fts: string };
export function localTaskQueryPlan(query: unknown): TaskQueryPlan | null;
export function matchesLocalTaskQuery(memory: { content?: string; summary?: string | null; rationale?: string | null; reuse_rule?: string | null }, plan: TaskQueryPlan | TaskQueryClause | null): boolean;
export function coversLocalTaskQuery(memories: Array<{ content?: string; summary?: string | null; rationale?: string | null; reuse_rule?: string | null }>, plan: TaskQueryPlan | null): boolean;
export function matchesLocalTaskQueryLiterals(memory: { content?: string; summary?: string | null; rationale?: string | null; reuse_rule?: string | null }, plan: TaskQueryPlan | null): boolean;
