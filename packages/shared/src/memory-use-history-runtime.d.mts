export const MEMORY_USE_POLICY: string;
export const MEMORY_USE_HALF_LIFE_MS: number;
export const MEMORY_USE_SCHEMA_SQL: string;
export type UseContext = { task: string; target: string; constraints: string; conditions: string };
export type UseFlags = { collect: boolean; context: boolean; ranking: boolean; sync: boolean };
export type UseRow = Record<string, any>; // SQL adapter rows retain the existing product contracts.
export type UseDb = { all(sql: string, args: unknown[]): Promise<UseRow[]>; batch(commands: {sql:string;args:unknown[]}[]): Promise<unknown> };
export function useHash(value: unknown): Promise<string>;
export function memoryUseFlags(env?: Record<string, unknown>): UseFlags;
export function normalizeUseContext(raw: unknown): UseContext;
export function useContextTokens(raw: unknown): string[];
export function useConditionsMatch(context: UseContext, requested?: Partial<UseContext>): boolean;
export function useScore(base: number, positive: number, negative: number): number;
export class MemoryUseHistory {
 constructor(options: {db:UseDb;tenantId:string;principal:string;resolveSource:(type:string,id:string)=>Promise<UseRow|null>;resolveEvidence:(type:string,id:string,scope:UseRow)=>Promise<UseRow|null>;now?:()=>number});
 record(input: unknown): Promise<UseRow>;
 evaluate(input: unknown): Promise<UseRow>;
 revoke(id: string): Promise<UseRow>;
 history(options?: {source_id?:string|null;project_id?:string|null;limit?:number;before?:string|null}): Promise<UseRow>;
 rebuild(project:string, work:string): Promise<UseRow>;
 search(input: {query:string;project_id?:string|null;work_type?:string|null;task_id?:string|null;context?:Partial<UseContext>;base?:UseRow[];context_enabled?:boolean;ranking_enabled?:boolean;limit?:number;at?:number;snapshot_id?:string|null;source_types?:string[];filter_candidates?:(rows:UseRow[])=>Promise<UseRow[]>}): Promise<{results:UseRow[];meta:UseRow}>;
}

export function observeMemoryUse(input: unknown): UseRow;
