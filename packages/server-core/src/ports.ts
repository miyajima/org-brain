import type { Context, Hono } from "hono";
import type { PrincipalActorOptions, MemoryListOptions, MemoryQualityAuditOptions, MemoryQualityRunFilters, MemoryUsageInput, DecisionSearchOptions, MemorySearchRouteResult, DecisionSearchRouteResult, MemoryProposalOptions, MemoryConversationStageOptions, OrgPermission } from "@org-brain/contracts";

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
  projectId?: string | null;
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
  allTenantRoute?(context: RouteContext<TEnv>, kind: "memory" | "decision_memory" | "doc", body?: unknown, id?: string): Promise<{ tenantId: string; body: unknown }>;
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
  listUsers(env: TEnv["Bindings"], tenantId: string, options?: {
    query?: string;
    status?: "invited" | "active" | "suspended" | "deprovisioned" | null;
    role?: "tenant_admin" | "project_owner" | "contributor" | "reader" | "auditor" | "service_agent" | null;
    limit?: number;
    offset?: number;
  }): Promise<unknown>;
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
  getMyIdentity(
    env: TEnv["Bindings"],
    tenantId: string,
    auth: SharedAuthContext,
    projectId: string | null
  ): Promise<unknown>;
  updateUserProfile(env: TEnv["Bindings"], tenantId: string, auth: SharedAuthContext, body: unknown): Promise<unknown>;
  listGroups(env: TEnv["Bindings"], tenantId: string, principal: string, includeMembers: boolean): Promise<unknown>;
  createGroup(env: TEnv["Bindings"], tenantId: string, principal: string, body: unknown): Promise<unknown>;
  getGroup(env: TEnv["Bindings"], tenantId: string, groupId: string, principal: string, includeMembers: boolean): Promise<unknown>;
  updateGroup(env: TEnv["Bindings"], tenantId: string, groupId: string, principal: string, body: unknown, includeMembers: boolean): Promise<unknown>;
  addGroupMember(env: TEnv["Bindings"], tenantId: string, groupId: string, principal: string, body: unknown, includeMembers: boolean): Promise<unknown>;
  getGroupMemberImpact(env: TEnv["Bindings"], tenantId: string, groupId: string, principal: string, member: string, includeMembers: boolean): Promise<unknown>;
  removeGroupMember(env: TEnv["Bindings"], tenantId: string, groupId: string, principal: string, member: string, expectedImpactDigest: string | null, includeMembers: boolean): Promise<unknown>;
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

// Migrated operations are checked both at the gateway and at their route calls.
export interface TypedMemoryReadOperations<TEnv extends RouteAppEnv> {
  getMemoryDetails(env: TEnv["Bindings"], tenantId: string, memoryId: string, options?: PrincipalActorOptions): Promise<unknown>;
  getMemoryImpactExecution(env: TEnv["Bindings"], tenantId: string, externalRunId: string): Promise<unknown>;
  getMemoryImpactSummary(env: TEnv["Bindings"], tenantId: string, options: { from?: number; to?: number; projectId?: string }): Promise<unknown>;
  listMemoryQualityRuns(env: TEnv["Bindings"], tenantId: string, options?: { limit?: number }): Promise<unknown>;
  getMemoryQualityRun(env: TEnv["Bindings"], tenantId: string, runId: string, filters?: MemoryQualityRunFilters): Promise<unknown>;
  getMemoryQualityAudit(env: TEnv["Bindings"], tenantId: string, options: MemoryQualityAuditOptions): Promise<unknown>;
  getMemoryQualityAuditDetail(env: TEnv["Bindings"], tenantId: string, memoryId: string, options?: { now?: number }): Promise<unknown>;
  listMemoryIntegrityIssues(env: TEnv["Bindings"], tenantId: string, projectId: string, principal: string): Promise<unknown>;
  getMemoryAgingPlan(env: TEnv["Bindings"], tenantId: string, projectId: string, now?: number): Promise<unknown>;
  getPrincipalOwnerMapping(env: TEnv["Bindings"], tenantId: string, producerPrincipal: string): Promise<unknown>;
  listPrincipalOwnerMappings(env: TEnv["Bindings"], tenantId: string): Promise<unknown>;
  listBusinessCategories(env: TEnv["Bindings"], tenantId: string, includeInactive?: boolean): Promise<unknown>;
  listMemoryFailurePatterns(env: TEnv["Bindings"], tenantId: string, projectId?: string | null): Promise<unknown>;
  memoryImpactReport(env: TEnv["Bindings"], tenantId: string, raw: unknown): Promise<unknown>;
  retrieveMemoryContext(env: TEnv["Bindings"], body: unknown, options?: PrincipalActorOptions): Promise<unknown>;
  getMemoryProfile(env: TEnv["Bindings"], body: unknown, options?: PrincipalActorOptions): Promise<unknown>;
  listMemories(env: TEnv["Bindings"], tenantId: string, options?: MemoryListOptions): Promise<unknown>;
  listMemoriesPage(env: TEnv["Bindings"], tenantId: string, options?: MemoryListOptions): Promise<unknown>;
  listMemoriesCursorPage(env: TEnv["Bindings"], tenantId: string, options?: MemoryListOptions & { cursor?: string | null; view?: "full" | "compact" }): Promise<unknown>;
  searchMemories(env: TEnv["Bindings"], body: unknown, options?: PrincipalActorOptions): Promise<MemorySearchRouteResult>;
  searchDecisionMemories(env: TEnv["Bindings"], body: unknown, options?: DecisionSearchOptions): Promise<DecisionSearchRouteResult>;
  sharedKnowledgeForSearch?(env: TEnv["Bindings"], actor: { tenantId: string; principal: string; isTenantAdmin?: boolean; projectId?: string | null }, request: Record<string, unknown>, delivery?: { waitUntil?: (promise: Promise<unknown>) => void }): Promise<object>;
}

export interface TypedMemoryWriteOperations<TEnv extends RouteAppEnv> {
  extractMemoryCandidates(env: TEnv["Bindings"], event: unknown): Promise<unknown>;
  startMemoryImpact(env: TEnv["Bindings"], tenantId: string, raw: unknown, principal: string): Promise<unknown>;
  reportMemoryImpact(env: TEnv["Bindings"], tenantId: string, externalRunId: string, raw: unknown, principal: string): Promise<unknown>;
  reportMemoryFeedback(env: TEnv["Bindings"], tenantId: string, raw: unknown, reporter: string): Promise<unknown>;
  proposeMemoryRelation(env: TEnv["Bindings"], tenantId: string, raw: unknown, proposer: string): Promise<unknown>;
  reviewMemoryFeedback(env: TEnv["Bindings"], tenantId: string, feedbackId: string, decision: unknown, reviewer: string): Promise<unknown>;
  reviewMemoryRelation(env: TEnv["Bindings"], tenantId: string, relationId: string, decision: unknown, reviewer: string): Promise<unknown>;
  upsertOwnPrincipalOwnerMapping(env: TEnv["Bindings"], tenantId: string, raw: unknown, principal: string): Promise<unknown>;
  upsertPrincipalOwnerMapping(env: TEnv["Bindings"], tenantId: string, raw: unknown, principal: string): Promise<unknown>;
  createBusinessCategory(env: TEnv["Bindings"], tenantId: string, raw: unknown): Promise<unknown>;
  updateBusinessCategory(env: TEnv["Bindings"], tenantId: string, categoryId: string, raw: unknown): Promise<unknown>;
  createMemoryFailurePattern(env: TEnv["Bindings"], tenantId: string, raw: unknown): Promise<unknown>;
  updateMemoryFailurePattern(env: TEnv["Bindings"], tenantId: string, patternId: string, raw: unknown): Promise<unknown>;
  upsertMemories(env: TEnv["Bindings"], body: unknown, options?: PrincipalActorOptions): Promise<unknown>;
  captureMemories(env: TEnv["Bindings"], body: unknown, options?: PrincipalActorOptions): Promise<unknown>;
  reviseMemoryByRequest(env: TEnv["Bindings"], body: unknown, options?: PrincipalActorOptions): Promise<unknown>;
  refreshMemoryByRequest(env: TEnv["Bindings"], body: unknown, options?: PrincipalActorOptions): Promise<unknown>;
  suppressMemoryByRequest(env: TEnv["Bindings"], body: unknown, options?: PrincipalActorOptions): Promise<unknown>;
  trashMemoryByRequest(env: TEnv["Bindings"], body: unknown, options?: PrincipalActorOptions): Promise<unknown>;
  restoreMemoryByRequest(env: TEnv["Bindings"], body: unknown, options?: PrincipalActorOptions): Promise<unknown>;
  deleteMemoryById(env: TEnv["Bindings"], tenantId: string, memoryId: string, options?: PrincipalActorOptions): Promise<unknown>;
}

export interface TypedMemoryConfirmationOperations<TEnv extends RouteAppEnv> {
  captureRequestClaimsVerified(body: unknown): boolean;
  captureMemoryWithInferredRationale(env: TEnv["Bindings"], body: unknown, options?: { canAttest?: boolean }): Promise<unknown>;
  confirmProposedMemory(env: TEnv["Bindings"], body: unknown, principal?: string): Promise<unknown>;
  getMemoryConfirmationStatus(env: TEnv["Bindings"], body: unknown, principal?: string): Promise<unknown>;
  proposeMemoryWithRationale(env: TEnv["Bindings"], body: unknown, options?: MemoryProposalOptions): Promise<unknown>;
  cancelMemoryConfirmation?(env: TEnv["Bindings"], tenantId: string, body: Record<string, unknown>, principal: string, fallbackRole?: string): Promise<unknown>;
  stageConversationMemories?(env: TEnv["Bindings"], tenantId: string, input: unknown, options: MemoryConversationStageOptions): Promise<unknown>;
  listMemoryConfirmationReviews(env: TEnv["Bindings"], tenantId: string, options: { principal: string; projectId?: string; limit?: number; cursor?: string }): Promise<unknown>;
  withPrincipalActor(body: unknown, principal: string): unknown;
  guardMemoryConfirmation?(env: TEnv["Bindings"], tenantId: string | undefined, token: unknown, auth: SharedAuthContext, permission: "read" | "write"): Promise<void>;
  assertPermission(env: TEnv["Bindings"], input: { tenantId: string; projectId?: string | null; principal: string; permission: OrgPermission; fallbackRole?: string }): Promise<AuthorizationDecision>;
  isTenantAdmin(context: RouteContext<TEnv>, tenantId: string): Promise<boolean>;
}

export interface TypedMemoryUsageOperations<TEnv extends RouteAppEnv> {
  memoryUseOperation(env: TEnv["Bindings"], tenantId: string, raw: unknown, principal: string | null, operation: string): Promise<unknown>;
  recordMemoryEffect(env: TEnv["Bindings"], tenantId: string, raw: unknown): Promise<{ effect_id: string }>;
  recordMemoryUsage(env: TEnv["Bindings"], input: MemoryUsageInput): Promise<{ usage_id: string; verification_sampled: boolean }>;
  recordMemoryUsageFromRequest(env: TEnv["Bindings"], tenantId: string, raw: unknown, actorPrincipal?: string | null): Promise<unknown>;
  updateMemoryUsageStates(env: TEnv["Bindings"], tenantId: string, raw: unknown): Promise<unknown>;
}

export interface TypedMemoryRetrievalOperations<TEnv extends RouteAppEnv> {
  resolveRetrievalGenerationAssignment(env: TEnv["Bindings"], tenantId: string, projectId: string | null): Promise<unknown>;
  assignRetrievalGeneration(env: TEnv["Bindings"], tenantId: string, raw: unknown): Promise<unknown>;
  createRetrievalRankingProfile(env: TEnv["Bindings"], raw: unknown): Promise<unknown>;
  createRetrievalGeneration(env: TEnv["Bindings"], raw: unknown): Promise<unknown>;
  backfillRetrievalGeneration(env: TEnv["Bindings"], tenantId: string, generationId: string, raw: unknown): Promise<unknown>;
  transitionRetrievalGeneration(env: TEnv["Bindings"], generationId: string, status: string, raw?: unknown): Promise<unknown>;
  assertRetrievalOperator(env: TEnv["Bindings"], principal: string): void;
}

export interface TypedMemoryPort<TEnv extends RouteAppEnv> extends CommonHttpPort<TEnv>, TypedMemoryReadOperations<TEnv>, TypedMemoryWriteOperations<TEnv>, TypedMemoryConfirmationOperations<TEnv>, TypedMemoryUsageOperations<TEnv>, TypedMemoryRetrievalOperations<TEnv> {}

// Legacy registration contract remains available for external adapters.
export interface MemoryPort<TEnv extends RouteAppEnv> extends CommonHttpPort<TEnv> {
  sharedKnowledgeForSearch?: PortFunction;
  createBusinessCategory: PortFunction;
  listBusinessCategories: PortFunction;
  updateBusinessCategory: PortFunction;
  memoryImpactReport: PortFunction;
  createMemoryFailurePattern: PortFunction;
  listMemoryFailurePatterns: PortFunction;
  memoryUseOperation: PortFunction;
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
  getMemoryQualityAudit: PortFunction;
  getMemoryQualityAuditDetail: PortFunction;
  reportMemoryFeedback: PortFunction;
  reviewMemoryFeedback: PortFunction;
  proposeMemoryRelation: PortFunction;
  reviewMemoryRelation: PortFunction;
  listMemoryIntegrityIssues: PortFunction;
  getMemoryAgingPlan: PortFunction;
  listMemoryQualityRuns: PortFunction;
  getMemoryImpactExecution: PortFunction;
  getMemoryImpactSummary: PortFunction;
  reportMemoryImpact: PortFunction;
  startMemoryImpact: PortFunction;
  captureMemoryWithInferredRationale: PortFunction;
  captureRequestClaimsVerified: PortFunction;
  confirmProposedMemory: PortFunction;
  guardMemoryConfirmation?: PortFunction;
  stageConversationMemories?: PortFunction;
  cancelMemoryConfirmation?: PortFunction;
  getMemoryConfirmationStatus: PortFunction;
  listMemoryConfirmationReviews: PortFunction;
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
  domainCapabilities(env: TEnv["Bindings"], tenantId: string, adminAllowed?: boolean): Record<string, unknown>;
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
  createKnowledgePackOnboarding: PortFunction;
  getKnowledgePackOnboarding: PortFunction;
  updateKnowledgePackOnboardingStep: PortFunction;
  planKnowledgePackOnboarding: PortFunction;
  completeKnowledgePackOnboarding: PortFunction;
  getOrganizationDashboard: PortFunction;
  recordKnowledgePackGoalSnapshot: PortFunction;
  listMetricConnections: PortFunction;
  enqueueMetricImport: PortFunction;
  getMetricImportRun: PortFunction;
  createRetrospectiveSchedule: PortFunction;
  listRetrospectiveSchedules: PortFunction;
  updateRetrospectiveSchedule: PortFunction;
  createRetrospective: PortFunction;
  listRetrospectives: PortFunction;
  getRetrospective: PortFunction;
  putRetrospectiveResponse: PortFunction;
  closeRetrospective: PortFunction;
  cancelRetrospective: PortFunction;
  getRetrospectiveResults: PortFunction;
  createImprovementAction: PortFunction;
  listImprovementActions: PortFunction;
  updateImprovementAction: PortFunction;
  verifyImprovementAction: PortFunction;
  requireIdempotencyKey: PortFunction;
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
