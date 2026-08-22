import type { Context, Hono } from "hono";

// Operation names are part of the public port contract. Runtime adapters keep
// their native parameter and result types while route groups are migrated.
export type PortFunction = (...args: any[]) => any;

export type RouteAppEnv = {
  Bindings: object;
  Variables: object;
};

export type RouteApp<TEnv extends RouteAppEnv> = Hono<TEnv>;
export type RouteContext<TEnv extends RouteAppEnv> = Context<TEnv>;

export type SharedAuthContext = {
  principal: string;
  defaultRole: string;
  tenantId?: string | null;
  scopes?: string[] | null;
  /** Runtime-owned credential used only by the adapter that created it. */
  sessionToken?: string | null;
};

export type AuthorizationDecision = {
  allowed: boolean;
  matched_roles: string[];
};

export interface CommonHttpPort<TEnv extends RouteAppEnv> {
  assertApiTenantAccess(context: RouteContext<TEnv>, requestedTenant?: string | null): string;
  getApiAuthContext(context: RouteContext<TEnv>): SharedAuthContext;
  getApiPrincipal(context: RouteContext<TEnv>): string;
  jsonOk(context: RouteContext<TEnv>, data: unknown, status?: number): Response;
  tenantFromBody(body: unknown): string | undefined;
}

export interface IdentityPort<TEnv extends RouteAppEnv> extends CommonHttpPort<TEnv> {
  sessionCookie: string;
  sessionCookieMaxAge: number;
  appendAuditEvent(env: TEnv["Bindings"], input: Record<string, unknown>): Promise<unknown>;
  requestEmailCode(env: TEnv["Bindings"], body: unknown, requestIp: string | null): Promise<unknown>;
  verifyEmailCode(env: TEnv["Bindings"], body: unknown): Promise<{
    user: { tenant_id: string; principal: string };
    session_token: string;
    csrf_token: string;
    expires_at: number;
  }>;
  logoutSession(env: TEnv["Bindings"], auth: SharedAuthContext): Promise<unknown>;
  revokeAllSessions(env: TEnv["Bindings"], tenantId: string): Promise<unknown>;
  getOrganization(env: TEnv["Bindings"], tenantId: string): Promise<unknown>;
  updateOrganization(env: TEnv["Bindings"], tenantId: string, body: unknown): Promise<unknown>;
  listUsers(env: TEnv["Bindings"], tenantId: string, query?: string): Promise<unknown>;
  createUser(env: TEnv["Bindings"], tenantId: string, body: unknown, principal: string): Promise<unknown>;
  updateUser(env: TEnv["Bindings"], tenantId: string, principal: string, body: unknown, actor: string): Promise<unknown>;
  listDirectory(env: TEnv["Bindings"], tenantId: string, query?: string): Promise<unknown>;
  listRoleAssignments(env: TEnv["Bindings"], tenantId: string, filters: { principal?: string; projectId?: string }): Promise<unknown>;
  upsertRoleAssignment(env: TEnv["Bindings"], tenantId: string, body: unknown, principal: string): Promise<unknown>;
  deleteRoleAssignment(env: TEnv["Bindings"], tenantId: string, id: string): Promise<unknown>;
  listScopedTokens(env: TEnv["Bindings"], tenantId: string): Promise<unknown>;
  issueScopedToken(env: TEnv["Bindings"], tenantId: string, body: unknown, principal: string): Promise<unknown>;
  revokeScopedToken(env: TEnv["Bindings"], tenantId: string, id: string): Promise<unknown>;
  assertPermission: PortFunction;
  authorizePermission: PortFunction;
  listMcpClientInstallations(env: TEnv["Bindings"], tenantId: string, principal?: string): Promise<unknown>;
  createMcpClientInstallation(env: TEnv["Bindings"], tenantId: string, principal: string, body: unknown): Promise<unknown>;
  revokeMcpClientInstallation(
    env: TEnv["Bindings"],
    tenantId: string,
    id: string,
    principal: string,
    adminAllowed: boolean
  ): Promise<unknown>;
}

export interface CollaborationPort<TEnv extends RouteAppEnv> extends CommonHttpPort<TEnv> {
  getMyIdentity(env: TEnv["Bindings"], tenantId: string, auth: SharedAuthContext): Promise<unknown>;
  updateUserProfile(env: TEnv["Bindings"], tenantId: string, auth: SharedAuthContext, body: unknown): Promise<unknown>;
  listGroups(env: TEnv["Bindings"], tenantId: string, principal: string, includeMembers: boolean): Promise<unknown>;
  createGroup(env: TEnv["Bindings"], tenantId: string, principal: string, body: unknown): Promise<unknown>;
  getGroup(env: TEnv["Bindings"], tenantId: string, groupId: string, principal: string, includeMembers: boolean): Promise<unknown>;
  updateGroup(env: TEnv["Bindings"], tenantId: string, groupId: string, principal: string, body: unknown, includeMembers: boolean): Promise<unknown>;
  addGroupMember(env: TEnv["Bindings"], tenantId: string, groupId: string, principal: string, body: unknown, includeMembers: boolean): Promise<unknown>;
  removeGroupMember(env: TEnv["Bindings"], tenantId: string, groupId: string, principal: string, member: string, includeMembers: boolean): Promise<unknown>;
  archiveGroup(env: TEnv["Bindings"], tenantId: string, groupId: string, principal: string, includeMembers: boolean): Promise<unknown>;
  updateResourceShare(env: TEnv["Bindings"], body: unknown, principal: string): Promise<unknown>;
  getResourceShare(env: TEnv["Bindings"], tenantId: string, resourceType: string, resourceId: string): Promise<unknown>;
  sendAgentMessage(env: TEnv["Bindings"], body: unknown, actor: { principal: string }): Promise<{ deduped?: boolean; [key: string]: unknown }>;
  listAgentMessages(env: TEnv["Bindings"], query: Record<string, unknown>, actor: { principal: string }): Promise<unknown>;
  getAgentMessage(env: TEnv["Bindings"], tenantId: string, messageId: string, target: Record<string, unknown>, actor: { principal: string }): Promise<unknown>;
  markAgentMessageRead(env: TEnv["Bindings"], tenantId: string, messageId: string, body: unknown, actor: { principal: string }): Promise<unknown>;
  ackAgentMessage(env: TEnv["Bindings"], tenantId: string, messageId: string, body: unknown, actor: { principal: string }): Promise<unknown>;
  createTask(env: TEnv["Bindings"], body: unknown, actor: { actorPrincipal: string }): Promise<unknown>;
  listTasks(env: TEnv["Bindings"], tenantId: string, limit: number, status?: string, query?: string, offset?: number): Promise<unknown>;
  getTask(env: TEnv["Bindings"], tenantId: string, taskId: string): Promise<unknown>;
  getTaskEvents(env: TEnv["Bindings"], tenantId: string, taskId: string, limit: number, cursor?: number): Promise<unknown>;
}

export interface AssetAgentPort<TEnv extends RouteAppEnv> extends CommonHttpPort<TEnv> {
  createAgent: PortFunction;
  getAgent: PortFunction;
  listAgents: PortFunction;
  resolveAgentLoadoutContext: PortFunction;
  updateAgent: PortFunction;
  updateAgentLoadout: PortFunction;
  availableSkillProviders: PortFunction;
  createSkillAsset: PortFunction;
  createSkillVersion: PortFunction;
  exportSkillAsset: PortFunction;
  generateSkillAsset: PortFunction;
  getSkillAsset: PortFunction;
  listSkillAssets: PortFunction;
  publishSkillAsset: PortFunction;
  retireSkillAsset: PortFunction;
  authorizePermission: PortFunction;
  getVerifiedIngestionManifest: PortFunction;
  ingestVerifiedKnowledgeBundle: PortFunction;
  listVerifiedManifestsByCollector: PortFunction;
  registerCollectorKey: PortFunction;
  revokeCollectorKey: PortFunction;
  assertDecisionConsoleEnabled: PortFunction;
  isTenantAdmin: PortFunction;
  requireIdempotencyKey: PortFunction;
}

export interface DashboardAccessPort<TEnv extends RouteAppEnv> extends CommonHttpPort<TEnv> {
  getActivityDashboard: PortFunction;
  getAccessPolicy: PortFunction;
  getAccessPolicyShadowSummary: PortFunction;
  updateAccessPolicy: PortFunction;
  getKnowledgeGraph: PortFunction;
  getMemoryStrata: PortFunction;
  getMemoryStrataDetail: PortFunction;
  getMemoryAnalytics: PortFunction;
  getMemoryMap: PortFunction;
  getMemoryMapTrace: PortFunction;
  accessPolicyResourceType: PortFunction;
  assertDecisionConsoleEnabled: PortFunction;
  dashboardStrataDetailQuerySchema: {
    safeParse(input: unknown):
      | { success: true; data: { tenant_id?: string; project_id?: string } }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  };
  isTenantAdmin: PortFunction;
  runDashboardView<T>(
    context: RouteContext<TEnv>,
    view: "activity" | "knowledge_graph" | "strata" | "strata_detail",
    operation: () => Promise<T>,
    summarize: (data: T) => { count: number; truncated: boolean }
  ): Promise<T>;
}

export interface OperationsPort<TEnv extends RouteAppEnv> extends CommonHttpPort<TEnv> {
  listAuditEvents: PortFunction;
  parseAuditLimit: PortFunction;
  verifyAuditChain: PortFunction;
  backfillV3RetrievalUnits: PortFunction;
  backfillV4RetrievalUnits: PortFunction;
  rebuildSemanticIndex: PortFunction;
  getOperationsStatus: PortFunction;
  applyRetentionPolicies: PortFunction;
  listRetentionPolicies: PortFunction;
  upsertRetentionPolicy: PortFunction;
  cancelRetentionQueue: PortFunction;
  listRetentionQueue: PortFunction;
  backfillDecisionRetrievalUnits: PortFunction;
  replayFailedTask: PortFunction;
}

export interface MemoryPort<TEnv extends RouteAppEnv> extends CommonHttpPort<TEnv> {
  createBusinessCategory: PortFunction;
  listBusinessCategories: PortFunction;
  updateBusinessCategory: PortFunction;
  memoryImpactReport: PortFunction;
  createMemoryFailurePattern: PortFunction;
  listMemoryFailurePatterns: PortFunction;
  recordMemoryEffect: PortFunction;
  recordMemoryUsage: PortFunction;
  recordMemoryUsageFromRequest: PortFunction;
  updateMemoryFailurePattern: PortFunction;
  updateMemoryUsageStates: PortFunction;
  assignRetrievalGeneration: PortFunction;
  backfillRetrievalGeneration: PortFunction;
  createRetrievalGeneration: PortFunction;
  createRetrievalRankingProfile: PortFunction;
  resolveRetrievalGenerationAssignment: PortFunction;
  transitionRetrievalGeneration: PortFunction;
  extractMemoryCandidates: PortFunction;
  searchDecisionMemories: PortFunction;
  captureMemories: PortFunction;
  deleteMemoryById: PortFunction;
  getMemoryDetails: PortFunction;
  getMemoryProfile: PortFunction;
  listMemories: PortFunction;
  listMemoriesCursorPage: PortFunction;
  listMemoriesPage: PortFunction;
  refreshMemoryByRequest: PortFunction;
  restoreMemoryByRequest: PortFunction;
  reviseMemoryByRequest: PortFunction;
  retrieveMemoryContext: PortFunction;
  searchMemories: PortFunction;
  suppressMemoryByRequest: PortFunction;
  trashMemoryByRequest: PortFunction;
  upsertMemories: PortFunction;
  getPrincipalOwnerMapping: PortFunction;
  listPrincipalOwnerMappings: PortFunction;
  upsertOwnPrincipalOwnerMapping: PortFunction;
  upsertPrincipalOwnerMapping: PortFunction;
  getMemoryQualityRun: PortFunction;
  listMemoryQualityRuns: PortFunction;
  getMemoryImpactExecution: PortFunction;
  getMemoryImpactSummary: PortFunction;
  reportMemoryImpact: PortFunction;
  startMemoryImpact: PortFunction;
  captureMemoryWithInferredRationale: PortFunction;
  captureRequestClaimsVerified: PortFunction;
  confirmProposedMemory: PortFunction;
  proposeMemoryWithRationale: PortFunction;
  assertPermission: PortFunction;
  assertRetrievalOperator: PortFunction;
  isTenantAdmin: PortFunction;
  withPrincipalActor: PortFunction;
}

export interface DecisionContextPort<TEnv extends RouteAppEnv> extends CommonHttpPort<TEnv> {
  portableArchiveMode(env: TEnv["Bindings"]): string;
  applyPortableImport: PortFunction;
  createPortableImport: PortFunction;
  getDomainRecall: PortFunction;
  getDomainRecallById: PortFunction;
  planPortableImport: PortFunction;
  putPortableImportChunk: PortFunction;
  recordDomainRecallFeedback: PortFunction;
  confirmDecisionMemory: PortFunction;
  createDecisionMemory: PortFunction;
  enrichContext: PortFunction;
  getDecisionMemoryContext: PortFunction;
  getDecisionReviewQueue: PortFunction;
  preActionDecisionGate: PortFunction;
  reviseDecisionMemory: PortFunction;
  searchDecisionMemories: PortFunction;
  getKnowledgeDoc: PortFunction;
  getKnowledgeDocContext: PortFunction;
  searchKnowledgeDocs: PortFunction;
  upsertKnowledgeDoc: PortFunction;
  assertPermission: PortFunction;
  addKnowledgeResourceLocation: PortFunction;
  backfillKnowledgeResources: PortFunction;
  captureKnowledgeResourceVersion: PortFunction;
  confirmDecisionResourceLinkProposal: PortFunction;
  createDecisionResourceLink: PortFunction;
  getDecisionResources: PortFunction;
  getResourceDecisions: PortFunction;
  listDecisionResourceLinkProposals: PortFunction;
  resolveKnowledgeResource: PortFunction;
  retireDecisionResourceLink: PortFunction;
  searchKnowledgeResources: PortFunction;
  upsertKnowledgeResource: PortFunction;
  assertFeatureEnabled: PortFunction;
  isTenantAdmin: PortFunction;
  requireIdempotencyKey: PortFunction;
}

export interface DomainPort<TEnv extends RouteAppEnv> extends CommonHttpPort<TEnv> {
  domainCapabilities(env: TEnv["Bindings"]): Record<string, unknown>;
  getDomainContext: PortFunction;
  createDecisionDomainLink: PortFunction;
  createManagedObject: PortFunction;
  createManagedObjectExternalRef: PortFunction;
  createManagedObjectRelation: PortFunction;
  createManagedObjectType: PortFunction;
  createMetricBinding: PortFunction;
  createMetricDefinition: PortFunction;
  createMetricDefinitionVersion: PortFunction;
  createMetricSnapshot: PortFunction;
  listDomainDashboards: PortFunction;
  listMetricSourceBindings: PortFunction;
  queryMetricSnapshots: PortFunction;
  queryMetrics: PortFunction;
  recordMetricPromotion: PortFunction;
  searchManagedObjects: PortFunction;
  setMetricTarget: PortFunction;
  upsertDomainDashboard: PortFunction;
  getDomainPackWorkspace: PortFunction;
  installDomainPacks: PortFunction;
  listDomainPacks: PortFunction;
  planDomainPackInstallation: PortFunction;
  uninstallDomainPack: PortFunction;
  getDecisionBriefing: PortFunction;
  getDecisionMap: PortFunction;
  getDecisionTrace: PortFunction;
  assertDecisionConsoleEnabled: PortFunction;
  isTenantAdmin: PortFunction;
}
