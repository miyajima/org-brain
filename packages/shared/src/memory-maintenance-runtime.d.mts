export type MaintenanceInputRow = {
  id: string;
  project_id?: string | null;
  source: string;
  summary?: string | null;
  content: string;
  tags_json?: string | null;
  created_at: number;
  kind?: string | null;
  [key: string]: unknown;
};

export type PlannedSynthesizedMemory = {
  external_key: string;
  project_id: string | null;
  source: "org-brain";
  created_at: number;
  tags: string[];
  summary: string;
  content: string;
  member_ids: string[];
};

export type PlannedMaintenanceCompaction = {
  id: string;
  reason: "digest" | "duplicate";
  digest_external_key: string | null;
  next_tags: string[];
};

export type MemoryMaintenanceCoreOptions = {
  tenantId?: string;
  now?: number;
  digestOlderThanDays?: number;
  duplicateOlderThanDays?: number;
  digestGroupMin?: number;
};

export type MemoryMaintenanceCorePlan = {
  canonicals: PlannedSynthesizedMemory[];
  digests: PlannedSynthesizedMemory[];
  compactions: PlannedMaintenanceCompaction[];
  stats: {
    scanned_count: number;
    canonical_group_count: number;
    canonical_memory_count: number;
    digest_group_count: number;
    digested_memory_count: number;
    duplicate_compaction_count: number;
    total_compaction_count: number;
  };
};

export function planMemoryMaintenanceCore(
  rows: MaintenanceInputRow[],
  options?: MemoryMaintenanceCoreOptions
): MemoryMaintenanceCorePlan;
