import { createMemoryMapRenderer, memoryMapColors } from "./memory-map-renderer";
export type MapNode = {
    id: string;
    node_type?: "memory" | "decision" | "project" | "entity" | "tenant";
    memory_id: string | null;
    decision_id?: string | null;
    related_memory_id?: string | null;
    entity_id?: string | null;
    entity_type?: string | null;
    entity_link_count?: number;
    cross_project_link_count?: number;
    member_count?: number;
    tenant_id?: string | null;
    label: string;
    summary?: string | null;
    project_id: string | null;
    owner_principal: string | null;
    created_by_principal: string | null;
    reference_count: number;
    consumer_count: number;
    used_count: number;
    utilization_rate: number | null;
    net_saved_tokens: number;
    injected_tokens: number;
    updated_at?: number | null;
    cluster_key?: string;
    decision_type?: string | null;
    confirmation_state?: string | null;
    confidence_score?: number | null;
    fx?: number;
    fy?: number;
    fz?: number;
  };

export type GraphLink = { id?: string; source: string | MapNode; target: string | MapNode; relation?: string; directed?: boolean; inferred?: boolean; weight?: number; confidence?: number | null; cross_project?: boolean };
export type MemoryMapData = { nodes: MapNode[]; links: Array<{ id?: string; source: string; target: string; relation: string; directed?: boolean; inferred?: boolean; weight?: number; confidence?: number | null; cross_project?: boolean }>; cluster_mode: boolean; total_count?: number; visible_count?: number; memory_visible_count?: number; project_count?: number; entity_count?: number; decision_count?: number; decision_count_total?: number; decision_count_confirmed?: number; decision_count_inferred?: number; decision_count_truncated?: boolean; related_count?: number; relationship_count?: number; cross_project_link_count?: number; truncated?: boolean };
  import type { MemoryMapTraceResponse } from "@org-brain/contracts";
  import { formatDateTime } from "./format-date";
  import { buildMemoryMapTraceView, evidenceClaimKeys, normalizeTraceStep, TRACE_STEP_IDS, type TraceStepId } from "./memory-map-trace-view";

  type MemoryDetailPayload = {
    ok?: boolean;
    error?: { message?: string };
    data?: {
      memory_id: string;
      memory: {
        id?: string;
        source?: string | null;
        external_key?: string | null;
        created_at?: number | null;
        kind?: string | null;
        current_version?: number | null;
        last_accessed_at?: number | null;
        confidence_score?: number | null;
        utility_score?: number | null;
        actor_type?: string | null;
        actor_id?: string | null;
        owner_principal?: string | null;
        created_by_principal?: string | null;
        deleted_at?: number | null;
        deleted_by_principal?: string | null;
        delete_reason?: string | null;
        project_id?: string | null;
        content?: string | null;
        summary?: string | null;
        tags?: string[];
        lifecycle_state?: string | null;
        updated_at?: number | null;
        reference_count?: number | null;
        used_count?: number | null;
        consumer_count?: number | null;
        net_saved_tokens?: number | null;
        injected_tokens?: number | null;
      } | null;
      versions: Array<{
        version: number;
        operation: string;
        summary: string | null;
        kind: string;
        lifecycle_state: string;
        actor_type: string | null;
        actor_id: string | null;
        created_at: number;
      }>;
      rationales: Array<{
        id: string;
        decision_type: string;
        conclusion: string;
        reason_summary: string;
        status: string;
        confirmation_state: string;
        confidence_score: number | null;
        created_at: number;
        confirmed_at: number | null;
        evidence: Array<{
          id: string;
          evidence_type: string;
          evidence_ref: string;
          relation: string;
          note: string | null;
          weight_score: number | null;
        }>;
      }>;
      meta?: { usage_id?: string; verification_sampled?: boolean };
    };
  };

  type MemoryMapTracePayload = {
    ok?: boolean;
    error?: { message?: string };
    data?: {
      selected: {
        node_type: "memory" | "decision";
        id: string;
        memory_id: string;
        decision_rationale_id: string | null;
      };
      memory: {
        id: string;
        project_id: string | null;
        kind: string;
        summary: string | null;
        lifecycle_state: string;
        verification_state: string;
        verified_at: number | null;
        reuse_rule: string | null;
        learning: Record<string, unknown> | null;
        versions: Array<{
          version: number;
          operation: string;
          summary: string | null;
          kind: string;
          lifecycle_state: string;
          actor_type: string | null;
          actor_id: string | null;
          created_at: number;
        }>;
      };
      selected_rationale_id: string | null;
      rationales: Array<{
        id: string;
        decision_type: string;
        conclusion: string;
        reason_summary: string;
        status: string;
        confirmation_state: string;
        confidence_score: number | null;
        created_at: number;
        confirmed_at: number | null;
        derived: {
          lesson_type: string | null;
          trigger: string | null;
          question: string | null;
          decision_key: string | null;
          decision: string | null;
          selected_value: string | null;
          rationale: string | null;
          alternatives: Array<{ alternative: string; reason_rejected: string | null }>;
          constraints: string[];
          reuse_when: string | null;
          outcome: string | null;
          symptom: string | null;
          failed_approach: string | null;
          root_cause: string | null;
          correction: string | null;
          verified_outcome: string | null;
          avoidance_rule: string | null;
        };
        evidence: Array<{
          id: string;
          evidence_type: string;
          evidence_ref: string;
          relation: string;
          note: string | null;
          weight_score: number | null;
          content_hash: string | null;
          observed_at: number | null;
          attestation_ref: string | null;
        }>;
        resources: {
          sources: Array<{
            link: { role: string; resource_version_id: string | null; locator: Record<string, unknown> | null; note: string | null; confirmation_state: string; excerpt_digest: string | null };
            resource: { id: string; title: string; resource_kind: string; canonical_uri: string; source_system: string; lifecycle_state: string; current_version_id: string | null };
            version: { id: string; source_version: string | null; content_hash: string; captured_at: number; extraction_state: string; pinned: boolean } | null;
            freshness: string;
            availability: "readable";
          }>;
          artifacts: Array<{
            link: { role: string; resource_version_id: string | null; locator: Record<string, unknown> | null; note: string | null; confirmation_state: string; excerpt_digest: string | null };
            resource: { id: string; title: string; resource_kind: string; canonical_uri: string; source_system: string; lifecycle_state: string; current_version_id: string | null };
            version: { id: string; source_version: string | null; content_hash: string; captured_at: number; extraction_state: string; pinned: boolean } | null;
            freshness: string;
            availability: "readable";
          }>;
        };
      }>;
      completeness: {
        rationale_count: number;
        evidence_count: number;
        source_count: number;
        artifact_count: number;
        missing: string[];
        partial: boolean;
        truncated: boolean;
      };
    };
  };

  export function mountMemoryMap(root: HTMLElement): () => void {
    const events = new AbortController();
    let disposed = false;
    const timeouts = new Set<number>();
    const frames = new Set<number>();
    const later = (callback: () => void, delay: number) => {
      const id = window.setTimeout(() => { timeouts.delete(id); if (!disposed) callback(); }, delay);
      timeouts.add(id);
      return id;
    };
    const scheduleFrame = (callback: FrameRequestCallback) => {
      const id = window.requestAnimationFrame((time) => { frames.delete(id); if (!disposed) callback(time); });
      frames.add(id);
      return id;
    };
    const data = JSON.parse(root.dataset.map || "{}") as MemoryMapData;
    const stage = root.querySelector<HTMLElement>("[data-map-stage]");
    const fallback = root.querySelector<HTMLElement>("[data-map-fallback]");
    const fallbackList = root.querySelector<HTMLUListElement>("[data-map-fallback-list]");
    const search = root.querySelector<HTMLInputElement>("[data-map-search]");
    const inspectorTitle = root.querySelector<HTMLElement>("[data-map-inspector-title]");
    const inspectorSummary = root.querySelector<HTMLElement>("[data-map-inspector-summary]");
    const inspectorProject = root.querySelector<HTMLElement>("[data-map-inspector-project]");
    const inspectorOwner = root.querySelector<HTMLElement>("[data-map-inspector-owner]");
    const inspectorRefs = root.querySelector<HTMLElement>("[data-map-inspector-refs]");
    const inspectorUtilization = root.querySelector<HTMLElement>("[data-map-inspector-utilization]");
    const inspectorSaved = root.querySelector<HTMLElement>("[data-map-inspector-saved]");
    const inspectorKind = root.querySelector<HTMLElement>("[data-map-inspector-kind]");
    const inspectorStatus = root.querySelector<HTMLElement>("[data-map-inspector-status]");
    const inspectorDetail = root.querySelector<HTMLElement>("[data-map-inspector-detail]");
    const inspectorMetadata = root.querySelector<HTMLElement>("[data-map-inspector-metadata]");
    const inspectorTagsSection = root.querySelector<HTMLElement>("[data-map-inspector-tags-section]");
    const inspectorTags = root.querySelector<HTMLElement>("[data-map-inspector-tags]");
    const inspectorContentSection = root.querySelector<HTMLElement>("[data-map-inspector-content-section]");
    const inspectorContent = root.querySelector<HTMLElement>("[data-map-inspector-content]");
    const inspectorRationalesSection = root.querySelector<HTMLElement>("[data-map-inspector-rationales-section]");
    const inspectorRationales = root.querySelector<HTMLElement>("[data-map-inspector-rationales]");
    const inspectorTraceHeading = root.querySelector<HTMLElement>("[data-map-trace-heading]");
    const inspectorTraceStatus = root.querySelector<HTMLElement>("[data-map-trace-status]");
    const inspectorVersionsSection = root.querySelector<HTMLElement>("[data-map-inspector-versions-section]");
    const inspectorVersions = root.querySelector<HTMLElement>("[data-map-inspector-versions]");
    const technicalDetails = root.querySelector<HTMLDetailsElement>("[data-map-technical]");
    const pathwayPrompt = root.querySelector<HTMLElement>("[data-trace-pathway-prompt]");
    const pathwayButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-trace-step]")];
    const sheetToggle = root.querySelector<HTMLButtonElement>("[data-trace-sheet-toggle]");
    const fitButton = root.querySelector<HTMLButtonElement>("[data-map-fit]");
    const renderStatus = root.querySelector<HTMLElement>("[data-map-render-status]");
    const commandBar = root.querySelector<HTMLElement>("[data-map-command-bar]");
    const searchResults = root.querySelector<HTMLElement>("[data-map-search-results]");
    const accessibleList = root.querySelector<HTMLUListElement>("[data-map-accessible-list]");
    const accessibleSearch = root.querySelector<HTMLInputElement>("[data-map-accessible-search]");
    const selectionStatus = root.querySelector<HTMLElement>("[data-map-selection-status]");
    const viewTraceLink = root.querySelector<HTMLAnchorElement>("[data-map-view-trace]");
    const accessibleCount = root.querySelector<HTMLElement>("[data-map-accessible-count]");
    const resourceDialog = root.querySelector<HTMLDialogElement>("[data-map-resource-dialog]");
    const resourceDialogTitle = root.querySelector<HTMLElement>("[data-map-resource-dialog-title]");
    const resourceDialogRole = root.querySelector<HTMLElement>("[data-map-resource-dialog-role]");
    const resourceDialogNote = root.querySelector<HTMLElement>("[data-map-resource-dialog-note]");
    const resourceDialogReference = root.querySelector<HTMLElement>("[data-map-resource-dialog-reference]");
    const resourceDialogMeta = root.querySelector<HTMLElement>("[data-map-resource-dialog-meta]");
    const resourceDialogLink = root.querySelector<HTMLAnchorElement>("[data-map-resource-dialog-link]");
    const projectLegend = root.querySelector<HTMLElement>("[data-project-legend]");
    const inspectorLink = root.querySelector<HTMLAnchorElement>("[data-map-inspector-link]");
    const mapCopy = JSON.parse(root.dataset.mapCopy || "{}") as Record<string, unknown>;
    const mapText = (key: string, fallback: string) => typeof mapCopy[key] === "string" ? String(mapCopy[key]) : fallback;
    const traceCopy = JSON.parse(root.dataset.traceCopy || "{}") as Record<string, unknown>;
    const traceText = (key: string, fallback: string) => typeof traceCopy[key] === "string" ? String(traceCopy[key]) : fallback;
    let preset = "project";
    let selectedId = new URL(window.location.href).searchParams.get("selected") || "";
    let activeTraceStep = normalizeTraceStep(new URL(window.location.href).searchParams.get("trace_step"));
    root.dataset.activeTraceStep = activeTraceStep;
    let activeTracePayload: MemoryMapTraceResponse | null = null;
    let activeRationaleId: string | null = null;
    let refreshAccessibleChoices = () => {};
    let openSearchResults = () => {};
    let closeSearchResults = () => {};
    let preserveInitialTraceStep = Boolean(selectedId);
    let selectedRelatedIds = new Set<string>();
    let renderer: ReturnType<typeof createMemoryMapRenderer> | null = null;
    let intersects = true;
    let pageVisible = true;
    const renderInput = () => ({ selectedId, selectedRelatedIds, activeTraceStep, preset, query: search?.value || "" });
    const updateGraph = () => renderer?.update(renderInput());
    const setSheetState = (state: "peek" | "half" | "expanded") => {
      const inspector = root.querySelector<HTMLElement>("[data-map-inspector]");
      if (!inspector) return;
      inspector.dataset.sheetState = state;
      const expanded = state !== "peek";
      sheetToggle?.setAttribute("aria-expanded", String(expanded));
      if (sheetToggle) sheetToggle.textContent = expanded
        ? traceText("collapsePanel", "Close details")
        : traceText("expandPanel", "Open details");
    };

    const { projectKeys, hashColor, colorFor } = memoryMapColors(data, () => ({ preset, selectedId, selectedRelatedIds }));
    const nodeId = (item: string | MapNode) => typeof item === "string" ? item : item.id;
    const relatedNodeIdsFor = (id: string) => {
      const related = new Set<string>();
      if (!id) return related;
      related.add(id);

      const firstHop = new Set<string>();
      for (const link of data.links) {
        const source = nodeId(link.source);
        const target = nodeId(link.target);
        if (source === id) firstHop.add(target);
        if (target === id) firstHop.add(source);
      }
      for (const neighbor of firstHop) related.add(neighbor);

      // Project, concept, and decision hubs are intentionally treated as
      // one-hop bridges so the connected memory cluster keeps its project
      // colors when one memory is selected.
      const hubIds = [...firstHop].filter((neighbor) => {
        const node = data.nodes.find((candidate) => candidate.id === neighbor);
        return node?.node_type === "tenant" || node?.node_type === "project" || node?.node_type === "entity" || node?.node_type === "decision";
      });
      if (hubIds.length > 0) {
        const hubs = new Set(hubIds);
        for (const link of data.links) {
          const source = nodeId(link.source);
          const target = nodeId(link.target);
          if (hubs.has(source)) related.add(target);
          if (hubs.has(target)) related.add(source);
        }
      }
      return related;
    };
    const visible = (node: MapNode) => {
      const query = search?.value.trim().toLowerCase() || "";
      if (!query) return true;
      return [node.id, node.label, node.project_id, node.owner_principal, node.decision_type, node.entity_type].filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
    };
    const formatTimestamp = (value: number | null | undefined) => {
      if (value === null || value === undefined || !Number.isFinite(Number(value)) || Number(value) <= 0) return "—";
      return formatDateTime(Number(value), root.dataset.locale);
    };
    const formatNumber = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString();
    const appendText = (parent: HTMLElement, tag: string, text: string, className = "") => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      element.textContent = text;
      parent.appendChild(element);
      return element;
    };
    const renderMetadata = (items: Array<[string, string]>) => {
      if (!inspectorMetadata) return;
      inspectorMetadata.innerHTML = "";
      for (const [label, value] of items) {
        const wrapper = document.createElement("div");
        wrapper.className = "memory-map-inspector-field";
        appendText(wrapper, "dt", label, "memory-map-inspector-field-label");
        appendText(wrapper, "dd", value || "—", "memory-map-inspector-field-value");
        inspectorMetadata.appendChild(wrapper);
      }
      if (inspectorDetail) inspectorDetail.hidden = false;
      if (technicalDetails) technicalDetails.hidden = false;
    };
    const clearInspectorDetails = () => {
      if (inspectorDetail) inspectorDetail.hidden = true;
      if (technicalDetails) {
        technicalDetails.hidden = true;
        technicalDetails.open = false;
      }
      if (inspectorStatus) {
        inspectorStatus.hidden = true;
        inspectorStatus.textContent = "";
        delete inspectorStatus.dataset.detailState;
      }
      for (const section of [inspectorTagsSection, inspectorContentSection, inspectorVersionsSection]) {
        if (section) section.hidden = true;
      }
      for (const element of [inspectorMetadata, inspectorTags, inspectorVersions]) {
        if (element) element.innerHTML = "";
      }
      if (inspectorContent) inspectorContent.textContent = "";
      activeTracePayload = null;
      activeRationaleId = null;
    };
    const renderNodeMetadata = (node: MapNode) => {
      const nodeType = node.node_type || "memory";
      const nodeTypeLabel = nodeType === "tenant"
        ? mapText("tenantRoot", "Tenant root")
        : nodeType === "project"
          ? mapText("projectHub", "Project hub")
          : nodeType === "entity"
            ? mapText("sharedConcept", "Shared concept")
            : nodeType === "decision"
              ? mapText("decisionKind", "Decision")
              : mapText("memoryKind", "Memory");
      renderMetadata([
        [mapText("idLabel", "ID"), node.id],
        [mapText("nodeTypeLabel", "Node type"), nodeTypeLabel],
        [mapText("labelLabel", "Label"), node.label],
        [mapText("summaryLabel", "Summary"), node.summary || "—"],
        [mapText("tenantLabel", "Tenant"), node.tenant_id || root.dataset.tenantId || "default"],
        [mapText("projectLabel", "Project"), node.project_id || mapText("notSet", "Not set")],
        [mapText("ownerLabel", "Owner"), node.owner_principal || mapText("noAssignment", "Unassigned")],
        [mapText("creatorLabel", "Creator"), node.created_by_principal || mapText("noAssignment", "Unassigned")],
        [mapText("membersLabel", "Members"), formatNumber(node.member_count)],
        [mapText("referencesLabel", "References"), formatNumber(node.reference_count)],
        [mapText("usedLabel", "Used"), formatNumber(node.used_count)],
        [mapText("consumersLabel", "Consumers"), formatNumber(node.consumer_count)],
        [mapText("utilizationLabel", "Utilization"), node.utilization_rate === null || node.utilization_rate === undefined ? mapText("unmeasured", "Not measured") : `${Math.round(node.utilization_rate * 100)}%`],
        [mapText("netSavedLabel", "Net saved"), formatNumber(node.net_saved_tokens)],
        [mapText("injectedTokensLabel", "Injected tokens"), formatNumber(node.injected_tokens)],
        [mapText("updatedLabel", "Updated"), formatTimestamp(node.updated_at)],
        [mapText("clusterLabel", "Cluster"), node.cluster_key || "—"],
        [mapText("entityTypeLabel", "Entity type"), node.entity_type || "—"],
        [mapText("decisionTypeLabel", "Decision type"), node.decision_type || "—"],
        [mapText("confirmationLabel", "Confirmation"), node.confirmation_state || "—"],
        [mapText("confidenceLabel", "Confidence"), node.confidence_score === null || node.confidence_score === undefined ? "—" : String(node.confidence_score)]
      ]);
    };
    const renderMemoryDetail = (payload: NonNullable<MemoryDetailPayload["data"]>, node: MapNode) => {
      const memory = payload.memory;
      if (!memory) throw new Error("memory detail is empty");
      const referenceCount = Number(memory.reference_count ?? node.reference_count ?? 0);
      const usedCount = Number(memory.used_count ?? node.used_count ?? 0);
      renderMetadata([
        [mapText("idLabel", "ID"), memory.id || payload.memory_id || node.memory_id || node.id],
        [mapText("nodeTypeLabel", "Node type"), mapText("memoryKind", "Memory")],
        [mapText("sourceLabel", "Source"), memory.source || "—"],
        [mapText("externalKeyLabel", "External key"), memory.external_key || "—"],
        [mapText("kindLabel", "Kind"), memory.kind || "—"],
        [mapText("lifecycleLabel", "Lifecycle"), memory.lifecycle_state || "—"],
        [mapText("currentVersionLabel", "Current version"), formatNumber(memory.current_version)],
        [mapText("tenantLabel", "Tenant"), root.dataset.tenantId || "default"],
        [mapText("summaryLabel", "Summary"), memory.summary || "—"],
        [mapText("projectLabel", "Project"), memory.project_id || mapText("notSet", "Not set")],
        [mapText("ownerLabel", "Owner"), memory.owner_principal || mapText("noAssignment", "Unassigned")],
        [mapText("creatorLabel", "Creator"), memory.created_by_principal || mapText("noAssignment", "Unassigned")],
        [mapText("actorLabel", "Actor"), [memory.actor_type, memory.actor_id].filter(Boolean).join(" / ") || "—"],
        [mapText("createdLabel", "Created"), formatTimestamp(memory.created_at)],
        [mapText("updatedLabel", "Updated"), formatTimestamp(memory.updated_at)],
        [mapText("lastAccessedLabel", "Last accessed"), formatTimestamp(memory.last_accessed_at)],
        [mapText("confidenceLabel", "Confidence"), memory.confidence_score === null || memory.confidence_score === undefined ? "—" : String(memory.confidence_score)],
        [mapText("utilityLabel", "Utility"), memory.utility_score === null || memory.utility_score === undefined ? "—" : String(memory.utility_score)],
        [mapText("referencesLabel", "References"), formatNumber(referenceCount)],
        [mapText("usedLabel", "Used"), formatNumber(usedCount)],
        [mapText("consumersLabel", "Consumers"), formatNumber(memory.consumer_count)],
        [mapText("utilizationLabel", "Utilization"), referenceCount > 0 ? `${Math.round((usedCount / referenceCount) * 100)}%` : mapText("unmeasured", "Not measured")],
        [mapText("netSavedLabel", "Net saved tokens"), formatNumber(memory.net_saved_tokens)],
        [mapText("injectedTokensLabel", "Injected tokens"), formatNumber(memory.injected_tokens)],
        [mapText("deletedAtLabel", "Deleted at"), formatTimestamp(memory.deleted_at)],
        [mapText("deletedByLabel", "Deleted by"), memory.deleted_by_principal || "—"],
        [mapText("deleteReasonLabel", "Delete reason"), memory.delete_reason || "—"],
        [mapText("detailUsageIdLabel", "Detail usage ID"), payload.meta?.usage_id || "—"],
        [mapText("verificationSampledLabel", "Verification sampled"), payload.meta?.verification_sampled === undefined ? "—" : payload.meta.verification_sampled ? mapText("yesLabel", "yes") : mapText("noLabel", "no")]
      ]);

      const tags = memory.tags ?? [];
      if (inspectorTagsSection && inspectorTags) {
        inspectorTagsSection.hidden = tags.length === 0;
        inspectorTags.innerHTML = "";
        for (const tag of tags) appendText(inspectorTags, "span", tag, "memory-map-tag");
      }
      const content = String(memory.content ?? "");
      if (inspectorContentSection && inspectorContent) {
        inspectorContentSection.hidden = content.length === 0;
        inspectorContent.textContent = content;
      }
      const versions = payload.versions ?? [];
      if (inspectorVersionsSection && inspectorVersions) {
        inspectorVersionsSection.hidden = versions.length === 0;
        inspectorVersions.innerHTML = "";
        for (const version of versions) {
          const card = document.createElement("article");
          card.className = "memory-map-record memory-map-version";
          appendText(card, "strong", `v${version.version} / ${version.operation}`);
          appendText(card, "small", `${formatTimestamp(version.created_at)} · ${version.kind} · ${version.lifecycle_state} · ${version.actor_type || "—"} / ${version.actor_id || "—"}`);
          appendText(card, "p", version.summary || "—");
          inspectorVersions.appendChild(card);
        }
      }
    };

    const presentNarrative = (value: string | null | undefined) => String(value || "")
      .replace(/\s*[（(](?:synthetic case|合成ケース|合成用例)\s*\d+[）)]\s*$/iu, "")
      .trim();
    const addTraceField = (parent: HTMLElement, label: string, value: string | null | undefined) => {
      if (!value) return;
      const field = document.createElement("div");
      field.className = "memory-map-trace-field";
      appendText(field, "dt", label, "memory-map-trace-label");
      appendText(field, "dd", presentNarrative(value), "memory-map-trace-value");
      parent.appendChild(field);
    };
    const addTraceGroup = (parent: HTMLElement, title = "") => {
      const group = document.createElement("section");
      group.className = "memory-map-trace-group";
      if (title) appendText(group, "h4", title, "memory-map-trace-group-title");
      parent.appendChild(group);
      return group;
    };
    const formatLocator = (locator: Record<string, unknown> | null) => locator
      ? Object.entries(locator).map(([key, value]) => `${key}: ${String(value)}`).join(" / ")
      : "";
    const resourceRoleLabel = (role: string) => {
      if (role === "implementation_artifact") return traceText("implementation", "Implementation");
      if (role === "verification_artifact") return traceText("verification", "Verification");
      if (role === "output_artifact") return traceText("outputArtifact", "Output");
      if (role === "rationale_source" || role === "conclusion_source") return traceText("sources", "Sources");
      return role;
    };
    const resourceKindLabel = (kind: string) => ({
      document: traceText("resourceKindDocument", "Document"),
      test_result: traceText("resourceKindTestResult", "Test result"),
      build: traceText("resourceKindBuild", "Build"),
      output: traceText("resourceKindOutput", "Output"),
      source_file: traceText("resourceKindSourceFile", "Source file")
    })[kind] || kind;
    const stateValueLabel = (value: string) => ({
      active: traceText("stateActive", "Active"),
      confirmed: traceText("confirmedState", "Confirmed"),
      retired: traceText("stateRetired", "Retired"),
      archived: traceText("stateArchived", "Archived"),
      current: traceText("stateCurrent", "Current")
    })[value] || value;
    const presentResourceTitle = (value: string) => presentNarrative(value)
      .replace(/\s*[·|]\s*(?:failure|decision|success|case)-\d+\s*$/iu, "")
      .trim();
    const traceStateLabel = (state: string, count = 0, step: TraceStepId = "decision") => {
      if (state === "available") {
        if (step === "evidence") return traceText("evidenceCount", "Evidence · {count}").replace("{count}", String(count));
        if (step === "artifact") return traceText("artifactCount", "Artifacts · {count}").replace("{count}", String(count));
        return traceText("confirmedState", "Confirmed");
      }
      const label = state === "available"
        ? traceText("availableState", "Available")
        : state === "missing"
          ? traceText("missingState", "Missing")
          : state === "unverified"
            ? traceText("unverifiedState", "Unverified")
            : traceText("truncatedState", "Partial");
      return count > 0 && (step === "evidence" || step === "artifact") ? `${label} · ${count}` : label;
    };
    const traceStepCopy = (step: TraceStepId, isFailure = false) => {
      const normal = {
        decision: [traceText("stepDecision", "Decision"), traceText("stepDecisionDescription", "What was decided"), traceText("conceptDecisionDetail", "Start with the conclusion the organization adopted.")],
        reason: [traceText("stepReason", "Reason"), traceText("stepReasonDescription", "Why it was chosen"), traceText("conceptReasonDetail", "Review the reasoning, constraints, and rejected alternatives.")],
        evidence: [traceText("stepEvidence", "Evidence"), traceText("stepEvidenceDescription", "What supports it"), traceText("conceptEvidenceDetail", "Check the files, commands, statements, and sources that support the claim.")],
        artifact: [traceText("stepArtifact", "Artifact"), traceText("stepArtifactDescription", "Where it was reflected"), traceText("conceptArtifactDetail", "Confirm the implementation, output, or verification result where the decision landed.")]
      } as const;
      if (!isFailure) return normal[step];
      const failure = {
        decision: [traceText("failureDecision", "Failure and learning"), traceText("failureDecisionDescription", "What happened"), traceText("conceptFailureDecisionDetail", "Start with the observed symptom and the lesson recorded from it.")],
        reason: [traceText("failureReason", "Root cause"), traceText("failureReasonDescription", "Why it happened"), traceText("conceptFailureReasonDetail", "Separate the root cause from the visible symptom.")],
        evidence: [traceText("failureEvidence", "Verification"), traceText("failureEvidenceDescription", "How it was checked"), traceText("conceptFailureEvidenceDetail", "Compare the failing and successful evidence used to verify the correction.")],
        artifact: [traceText("failureArtifact", "Correction and prevention"), traceText("failureArtifactDescription", "What changed"), traceText("conceptFailureArtifactDetail", "Confirm the correction, verified outcome, and rule that prevents recurrence.")]
      } as const;
      return failure[step];
    };
    const updatePathway = (payload: MemoryMapTraceResponse | null, rationaleId: string | null) => {
      const view = payload ? buildMemoryMapTraceView(payload, rationaleId) : null;
      root.classList.toggle("has-trace-selection", Boolean(view?.rationale));
      if (pathwayPrompt) pathwayPrompt.textContent = view?.rationale
        ? traceText("instancePrompt", "Use the four steps to inspect this decision's real data.")
        : traceText("conceptPrompt", "Select a decision node to inspect a real path.");
      for (const button of pathwayButtons) {
        const step = normalizeTraceStep(button.dataset.traceStep);
        const item = button.closest<HTMLElement>("[data-trace-step-item]");
        const label = button.querySelector<HTMLElement>("[data-trace-step-label]");
        const description = button.querySelector<HTMLElement>("[data-trace-step-description]");
        const state = button.querySelector<HTMLElement>("[data-trace-step-state]");
        const copy = traceStepCopy(step, view?.isFailure);
        if (label) label.textContent = copy[0];
        if (description) description.textContent = copy[1];
        const stage = view?.stages.find((candidate) => candidate.id === step);
        if (item) item.dataset.state = stage?.state || "concept";
        if (state) state.textContent = stage ? traceStateLabel(stage.state, stage.count, step) : "";
        const visibleText = button.textContent?.replace(/\s+/gu, " ").trim() || "";
        button.setAttribute("aria-label", visibleText);
        if (step === activeTraceStep) button.setAttribute("aria-current", "step");
        else button.removeAttribute("aria-current");
      }
      return view;
    };
    const appendCopyReference = (parent: HTMLElement, value: string) => {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "memory-map-copy-reference";
      action.dataset.copyValue = value;
      action.textContent = traceText("copyReference", "Copy reference");
      parent.appendChild(action);
    };
    const resourceDetailsHref = (rationaleId: string) => {
      const resourceParams = new URLSearchParams({
        tenant_id: root.dataset.tenantId || "default",
        project_id: root.dataset.projectId || "",
        decision_ref: `decision_rationale:${rationaleId}`,
        advanced: "1",
        lang: root.dataset.locale || "en"
      });
      return `/resources?${resourceParams.toString()}`;
    };
    const openResourcePreview = (
      item: NonNullable<MemoryMapTracePayload["data"]>["rationales"][number]["resources"]["artifacts"][number],
      rationaleId: string
    ) => {
      if (!resourceDialog || !resourceDialogTitle || !resourceDialogReference || !resourceDialogMeta || !resourceDialogLink) return;
      resourceDialogTitle.textContent = presentResourceTitle(item.resource.title || item.resource.id);
      if (resourceDialogRole) resourceDialogRole.textContent = `${resourceRoleLabel(item.link.role)} · ${resourceKindLabel(item.resource.resource_kind)}`;
      if (resourceDialogNote) {
        resourceDialogNote.hidden = !item.link.note;
        resourceDialogNote.textContent = presentNarrative(item.link.note);
      }
      resourceDialogReference.innerHTML = "";
      const uri = item.resource.canonical_uri;
      if (/^https?:\/\//iu.test(uri)) {
        const link = document.createElement("a");
        link.href = uri;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = uri;
        resourceDialogReference.appendChild(link);
      } else {
        appendText(resourceDialogReference, "code", uri);
        appendCopyReference(resourceDialogReference, uri);
      }
      resourceDialogMeta.innerHTML = "";
      addTraceField(resourceDialogMeta, traceText("pinnedVersion", "Pinned version"), item.version ? `${item.version.id}${item.version.pinned ? "" : " · current"}` : traceText("notAvailable", "Not available"));
      addTraceField(resourceDialogMeta, traceText("lifecycle", "Lifecycle"), stateValueLabel(item.resource.lifecycle_state));
      addTraceField(resourceDialogMeta, traceText("locator", "Locator"), formatLocator(item.link.locator));
      addTraceField(resourceDialogMeta, traceText("status", "Status"), stateValueLabel(item.link.confirmation_state));
      resourceDialogLink.href = resourceDetailsHref(rationaleId);
      resourceDialog.showModal();
    };
    const renderTraceResource = (parent: HTMLElement, item: NonNullable<MemoryMapTracePayload["data"]>["rationales"][number]["resources"]["artifacts"][number], rationaleId: string) => {
      const card = document.createElement("article");
      card.className = "memory-map-trace-resource";
      const header = document.createElement("div");
      header.className = "memory-map-trace-resource-header";
      appendText(header, "strong", presentResourceTitle(item.resource.title || item.resource.id));
      appendText(header, "small", `${resourceRoleLabel(item.link.role)} · ${resourceKindLabel(item.resource.resource_kind)} · ${stateValueLabel(item.freshness)}`);
      card.appendChild(header);
      const uri = item.resource.canonical_uri;
      if (/^https?:\/\//iu.test(uri)) {
        const link = document.createElement("a");
        link.href = uri;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = uri;
        link.className = "memory-map-trace-uri";
        card.appendChild(link);
      } else {
        const localReference = document.createElement("div");
        localReference.className = "memory-map-trace-local-reference";
        appendText(localReference, "span", traceText("localReference", "Local reference"));
        appendCopyReference(localReference, uri);
        card.appendChild(localReference);
      }
      const technical = document.createElement("details");
      technical.className = "memory-map-trace-technical";
      appendText(technical, "summary", traceText("resourceDetails", "Resource details"));
      const metadata = document.createElement("dl");
      metadata.className = "memory-map-trace-resource-meta";
      addTraceField(metadata, traceText("pinnedVersion", "Pinned version"), item.version ? `${item.version.id}${item.version.pinned ? "" : " · current"}` : traceText("notAvailable", "Not available"));
      addTraceField(metadata, traceText("lifecycle", "Lifecycle"), item.resource.lifecycle_state);
      addTraceField(metadata, traceText("locator", "Locator"), formatLocator(item.link.locator));
      addTraceField(metadata, traceText("status", "Status"), item.link.confirmation_state);
      technical.appendChild(metadata);
      card.appendChild(technical);
      if (item.link.note) appendText(card, "p", presentNarrative(item.link.note), "memory-map-trace-note");
      const actions = document.createElement("div");
      actions.className = "memory-map-trace-resource-actions";
      const preview = document.createElement("button");
      preview.type = "button";
      preview.textContent = traceText("previewResource", "Preview here");
      preview.className = "memory-map-trace-resource-preview";
      preview.addEventListener("click", () => { if (!disposed) openResourcePreview(item, rationaleId); });
      actions.appendChild(preview);
      const resourceLink = document.createElement("a");
      resourceLink.href = resourceDetailsHref(rationaleId);
      resourceLink.target = "_blank";
      resourceLink.rel = "noreferrer";
      resourceLink.textContent = traceText("openDetailsNewTab", "Open details in a new tab");
      resourceLink.className = "memory-map-trace-resource-link";
      actions.appendChild(resourceLink);
      card.appendChild(actions);
      parent.appendChild(card);
    };
    const appendTraceNavigation = (parent: HTMLElement) => {
      const navigation = document.createElement("nav");
      navigation.className = "memory-map-trace-navigation";
      navigation.setAttribute("aria-label", traceText("pathwayTitle", "The path of a decision"));
      const index = TRACE_STEP_IDS.indexOf(activeTraceStep);
      if (index > 0) {
        const previous = document.createElement("button");
        previous.type = "button";
        previous.className = "memory-map-trace-nav-previous";
        previous.textContent = `← ${traceText("previousStep", "Previous")}`;
        previous.addEventListener("click", () => { if (!disposed) setActiveTraceStep(TRACE_STEP_IDS[index - 1], { focus: true }); });
        navigation.appendChild(previous);
      }
      if (index < TRACE_STEP_IDS.length - 1) {
        const next = document.createElement("button");
        next.type = "button";
        next.className = "memory-map-trace-nav-next";
        next.textContent = activeTraceStep === "decision"
          ? `${traceText("inspectReason", "Inspect the reason")} →`
          : `${traceText("nextStep", "Next")} →`;
        next.addEventListener("click", () => { if (!disposed) setActiveTraceStep(TRACE_STEP_IDS[index + 1], { focus: true }); });
        navigation.appendChild(next);
      }
      parent.appendChild(navigation);
    };
    const renderConceptTrace = () => {
      if (!inspectorRationales) return;
      updatePathway(null, null);
      inspectorRationales.innerHTML = "";
      const copy = traceStepCopy(activeTraceStep);
      const card = document.createElement("article");
      card.className = "memory-map-trace-card memory-map-trace-concept";
      card.dataset.traceActiveStep = activeTraceStep;
      const heading = appendText(card, "h3", copy[0], "memory-map-trace-stage-title");
      heading.tabIndex = -1;
      appendText(card, "p", copy[2], "memory-map-trace-stage-intro");
      appendText(card, "p", traceText("conceptPrompt", "Select a decision node to inspect a real path."), "memory-map-trace-concept-prompt");
      appendTraceNavigation(card);
      inspectorRationales.appendChild(card);
    };
    const evidenceClaimLabel = (key: ReturnType<typeof evidenceClaimKeys>[number]) => ({
      decision: traceText("supportsDecision", "Supports the decision"),
      reason: traceText("supportsReason", "Supports the reason"),
      cause: traceText("supportsCause", "Supports the cause"),
      verification: traceText("supportsVerification", "Supports verification"),
      other: traceText("supportsOther", "Other evidence")
    })[key];
    const evidencePresentation = (evidence: NonNullable<MemoryMapTracePayload["data"]>["rationales"][number]["evidence"][number]) => {
      const relation = evidence.relation.toLowerCase();
      const note = String(evidence.note || "").toLowerCase();
      if (evidence.evidence_type === "command") {
        const succeeded = relation.includes("verified") || relation.includes("outcome") || /exit[_ ]?code\s*[:=]\s*0\b/u.test(note);
        const failed = relation.includes("symptom") || relation.includes("cause") || /exit[_ ]?code\s*[:=]\s*[1-9]\d*\b/u.test(note);
        if (succeeded) return { label: traceText("successfulCommand", "Successful run"), className: "is-success" };
        if (failed) return { label: traceText("failedCommand", "Failed run"), className: "is-failure" };
        return { label: traceText("commandEvidence", "Command"), className: "" };
      }
      return {
        label: ({
          file: traceText("fileEvidence", "File"),
          user_statement: traceText("userStatementEvidence", "User statement"),
          tool_call: traceText("toolCallEvidence", "Tool call")
        })[evidence.evidence_type] || evidence.evidence_type,
        className: ""
      };
    };
    const renderEvidenceItem = (parent: HTMLElement, evidence: NonNullable<MemoryMapTracePayload["data"]>["rationales"][number]["evidence"][number]) => {
      const item = document.createElement("article");
      item.className = "memory-map-trace-evidence";
      const badges = document.createElement("div");
      badges.className = "memory-map-trace-badges";
      const presentation = evidencePresentation(evidence);
      appendText(badges, "span", presentation.label, `memory-map-trace-badge memory-map-trace-badge-outcome ${presentation.className}`.trim());
      for (const claim of evidenceClaimKeys(evidence.relation)) appendText(badges, "span", evidenceClaimLabel(claim), "memory-map-trace-badge memory-map-trace-badge-support");
      item.appendChild(badges);
      if (evidence.note) appendText(item, "p", evidence.note);
      const technical = document.createElement("details");
      technical.className = "memory-map-trace-technical";
      appendText(technical, "summary", traceText("evidenceDetails", "Evidence details"));
      appendText(technical, "code", evidence.evidence_ref);
      appendText(technical, "small", evidence.relation);
      appendCopyReference(technical, evidence.evidence_ref);
      item.appendChild(technical);
      parent.appendChild(item);
    };
    const renderMemoryTrace = (payload: NonNullable<MemoryMapTracePayload["data"]>) => {
      if (!inspectorRationalesSection || !inspectorRationales) return;
      inspectorRationalesSection.hidden = false;
      if (inspectorTraceHeading) inspectorTraceHeading.textContent = traceText("pathwayTitle", "The path of a decision");
      if (inspectorTraceStatus) {
        inspectorTraceStatus.hidden = true;
        inspectorTraceStatus.textContent = "";
      }
      activeTracePayload = payload as MemoryMapTraceResponse;
      if (inspectorStatus && inspectorStatus.dataset.detailState) {
        inspectorStatus.hidden = true;
        inspectorStatus.textContent = "";
      }
      const view = buildMemoryMapTraceView(activeTracePayload, activeRationaleId);
      updatePathway(activeTracePayload, activeRationaleId);
      activeRationaleId = view.rationaleId;
      inspectorRationales.innerHTML = "";
      if (!view.rationale) {
        appendText(inspectorRationales, "p", traceText("noRationales", "No decision or failure learning is attached."), "memory-map-trace-empty");
        return;
      }
      const rationale = view.rationale;
      const derived = rationale.derived;
      if (inspectorKind && view.isFailure) inspectorKind.textContent = traceText("failureKind", "Failure learning");
      if (inspectorTitle) inspectorTitle.textContent = view.isFailure
        ? presentNarrative(derived.symptom || rationale.conclusion)
        : presentNarrative(rationale.conclusion || derived.decision || derived.selected_value);
      if (inspectorSummary) inspectorSummary.textContent = view.isFailure
        ? presentNarrative(derived.root_cause || rationale.reason_summary || traceText("missingReason", "Reason not recorded"))
        : presentNarrative(rationale.reason_summary || derived.rationale || traceText("missingReason", "Reason not recorded"));
      if (payload.rationales.length > 1) {
        const switcher = document.createElement("label");
        switcher.className = "memory-map-trace-switcher";
        appendText(switcher, "span", traceText("decisionSelector", "Decision"));
        const select = document.createElement("select");
        select.setAttribute("aria-label", traceText("decisionSelector", "Decision"));
        for (const candidate of payload.rationales) {
          const option = document.createElement("option");
          option.value = candidate.id;
          option.textContent = candidate.conclusion || candidate.decision_type;
          option.selected = candidate.id === rationale.id;
          select.appendChild(option);
        }
        select.addEventListener("change", () => {
          if (disposed) return;
          activeRationaleId = select.value;
          activeTraceStep = "decision";
          renderMemoryTrace(payload);
          updateRouteState();
        });
        switcher.appendChild(select);
        inspectorRationales.appendChild(switcher);
      }
      const stage = view.stages.find((candidate) => candidate.id === activeTraceStep) || view.stages[0];
      const copy = traceStepCopy(activeTraceStep, view.isFailure);
      const card = document.createElement("article");
      card.className = "memory-map-trace-card";
      card.dataset.traceActiveStep = activeTraceStep;
      const header = document.createElement("header");
      header.className = "memory-map-trace-stage-header";
      appendText(header, "span", `0${TRACE_STEP_IDS.indexOf(activeTraceStep) + 1}`, "memory-map-trace-stage-index");
      const titleGroup = document.createElement("div");
      const heading = appendText(titleGroup, "h3", copy[0], "memory-map-trace-stage-title");
      heading.tabIndex = -1;
      appendText(titleGroup, "p", copy[1], "memory-map-trace-stage-description");
      header.appendChild(titleGroup);
      appendText(header, "span", traceStateLabel(stage.state, stage.count, activeTraceStep), `memory-map-trace-stage-state is-${stage.state}`);
      card.appendChild(header);
      if (stage.state !== "available") {
        appendText(card, "p", stage.state === "missing"
          ? ({ decision: traceText("missingDecision", "Decision not recorded"), reason: traceText("missingReason", "Reason not recorded"), evidence: traceText("missingEvidence", "Evidence not recorded"), artifact: traceText("missingArtifact", "Formal artifact link not registered") })[activeTraceStep]
          : stage.state === "unverified"
            ? traceText("missingVerification", "Verification is not confirmed")
            : traceText("partial", "Some trace fields are missing"), "memory-map-trace-warning");
      }
      const body = document.createElement("div");
      body.className = "memory-map-trace-card-body";
      if (activeTraceStep === "decision") {
        const group = addTraceGroup(body);
        addTraceField(group, traceText("decisionValue", "Decision"), rationale.conclusion || derived.decision || derived.selected_value);
        addTraceField(group, traceText("decisionKey", "Decision key"), derived.decision_key);
        addTraceField(group, traceText("status", "Status"), `${rationale.confirmation_state} · ${rationale.status}${rationale.confidence_score === null ? "" : ` · ${Math.round(rationale.confidence_score * 100)}%`}`);
        addTraceField(group, view.isFailure ? traceText("symptom", "Symptom") : traceText("reasonPreview", "Reason preview"), view.isFailure ? derived.symptom : rationale.reason_summary || derived.rationale);
      } else if (activeTraceStep === "reason") {
        const group = addTraceGroup(body);
        if (view.isFailure) {
          addTraceField(group, traceText("symptom", "Symptom"), derived.symptom);
          addTraceField(group, traceText("rootCause", "Root cause"), derived.root_cause || rationale.reason_summary);
          addTraceField(group, traceText("failedApproach", "Failed approach"), derived.failed_approach);
        } else {
          addTraceField(group, traceText("reasonDetail", "Reason"), rationale.reason_summary || derived.rationale);
          addTraceField(group, traceText("trigger", "Trigger"), derived.trigger);
          addTraceField(group, traceText("question", "Question"), derived.question);
        }
        if (derived.constraints.length > 0) {
          const constraints = addTraceGroup(body, traceText("constraints", "Constraints"));
          const list = document.createElement("ul");
          for (const constraint of derived.constraints) appendText(list, "li", constraint);
          constraints.appendChild(list);
        }
        if (!view.isFailure && derived.alternatives.length > 0) {
          const alternatives = addTraceGroup(body, traceText("alternatives", "Rejected alternatives"));
          for (const alternative of derived.alternatives) {
            const item = document.createElement("article");
            item.className = "memory-map-trace-alternative";
            appendText(item, "strong", alternative.alternative);
            appendText(item, "p", alternative.reason_rejected || traceText("notAvailable", "Not available"));
            alternatives.appendChild(item);
          }
        }
      } else if (activeTraceStep === "evidence") {
        const evidenceGroup = addTraceGroup(body);
        for (const evidence of rationale.evidence) renderEvidenceItem(evidenceGroup, evidence);
        if (rationale.resources.sources.length > 0) {
          appendText(evidenceGroup, "h5", traceText("sources", "Sources"), "memory-map-trace-subtitle");
          for (const item of rationale.resources.sources) renderTraceResource(evidenceGroup, item, rationale.id);
        }
        if (rationale.evidence.length === 0 && rationale.resources.sources.length === 0) appendText(evidenceGroup, "p", traceText("missingEvidence", "Evidence not recorded"), "memory-map-trace-empty");
      } else {
        const outcomeGroup = addTraceGroup(body, traceText("outcome", "Outcome and reuse"));
        if (view.isFailure) {
          addTraceField(outcomeGroup, traceText("correction", "Correction"), derived.correction);
          addTraceField(outcomeGroup, traceText("verifiedOutcome", "Verified outcome"), derived.verified_outcome || derived.outcome);
          addTraceField(outcomeGroup, traceText("avoidanceRule", "Prevention rule"), derived.avoidance_rule || derived.reuse_when);
        } else {
          addTraceField(outcomeGroup, traceText("outcomeValue", "Outcome"), derived.outcome);
          addTraceField(outcomeGroup, traceText("reuseWhen", "Reuse when"), derived.reuse_when || payload.memory.reuse_rule);
        }
        const artifactGroup = addTraceGroup(body, traceText("artifacts", "Reflected artifacts"));
        for (const item of rationale.resources.artifacts) renderTraceResource(artifactGroup, item, rationale.id);
        if (rationale.resources.artifacts.length === 0) appendText(artifactGroup, "p", traceText("noArtifacts", "No readable confirmed artifacts are linked."), "memory-map-trace-empty");
      }
      card.appendChild(body);
      appendTraceNavigation(card);
      inspectorRationales.appendChild(card);
    };
    const updateRouteState = () => {
      const url = new URL(window.location.href);
      if (selectedId) {
        url.searchParams.set("selected", selectedId);
        url.searchParams.set("trace_step", activeTraceStep);
      } else {
        url.searchParams.delete("selected");
        url.searchParams.delete("trace_step");
      }
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    };
    const setActiveTraceStep = (step: TraceStepId, options: { focus?: boolean; updateUrl?: boolean } = {}) => {
      activeTraceStep = normalizeTraceStep(step);
      root.dataset.activeTraceStep = activeTraceStep;
      root.classList.remove("is-trace-advancing");
      void root.offsetWidth;
      root.classList.add("is-trace-advancing");
      if (activeTracePayload) renderMemoryTrace(activeTracePayload as unknown as NonNullable<MemoryMapTracePayload["data"]>);
      else renderConceptTrace();
      if (options.updateUrl !== false) updateRouteState();
      if (options.focus) root.querySelector<HTMLElement>(".memory-map-trace-stage-title")?.focus();
      updateGraph();
    };
    let detailRequestId = 0;
    const loadMemoryDetail = async (node: MapNode) => {
      if (!node.memory_id) return;
      const requestId = ++detailRequestId;
      if (inspectorStatus) {
        inspectorStatus.hidden = false;
        inspectorStatus.textContent = mapText("loadingMemoryDetail", "Loading content, history, and evidence…");
        inspectorStatus.dataset.detailState = "loading";
      }
      try {
        const response = await fetch(`/api/v1/memories/${encodeURIComponent(node.memory_id)}/details?tenant_id=${encodeURIComponent(root.dataset.tenantId || "default")}`, { headers: { accept: "application/json" } });
        const payload = await response.json() as MemoryDetailPayload;
        if (disposed || requestId !== detailRequestId || selectedId !== node.id) return;
        if (!response.ok || !payload.data) throw new Error(payload.error?.message || "memory detail could not be loaded");
        renderMemoryDetail(payload.data, node);
        if (inspectorStatus) {
          inspectorStatus.hidden = true;
          inspectorStatus.textContent = "";
          delete inspectorStatus.dataset.detailState;
        }
      } catch {
        if (disposed || requestId !== detailRequestId || selectedId !== node.id) return;
        if (inspectorStatus) {
          inspectorStatus.dataset.detailState = "unavailable";
          inspectorStatus.hidden = Boolean(activeTracePayload);
          inspectorStatus.textContent = activeTracePayload
            ? ""
            : mapText("detailFallback", "Details could not be loaded; showing map metadata.");
        }
      }
    };
    let traceRequestId = 0;
    const loadMemoryTrace = async (node: MapNode) => {
      const isDecision = node.node_type === "decision" && Boolean(node.decision_id);
      const memoryId = node.memory_id || (node.node_type === "memory" ? node.id : null);
      if (!isDecision && !memoryId) return;
      const requestId = ++traceRequestId;
      if (inspectorRationalesSection) inspectorRationalesSection.hidden = false;
      if (inspectorTraceStatus) {
        inspectorTraceStatus.hidden = false;
        inspectorTraceStatus.textContent = traceText("loading", "Loading decision trace…");
      }
      if (inspectorRationales) inspectorRationales.innerHTML = "";
      const params = new URLSearchParams({
        tenant_id: root.dataset.tenantId || "default",
        scope: root.dataset.scope || "org",
        lang: root.dataset.locale || "en"
      });
      if (root.dataset.projectId) params.set("project_id", root.dataset.projectId);
      if (isDecision && node.decision_id) params.set("decision_rationale_id", node.decision_id);
      else if (memoryId) params.set("memory_id", memoryId);
      try {
        const response = await fetch(`/api/v1/dashboard/memory-map/trace?${params.toString()}`, { headers: { accept: "application/json" } });
        const payload = await response.json() as MemoryMapTracePayload;
        if (disposed || requestId !== traceRequestId || selectedId !== node.id) return;
        if (!response.ok || !payload.data) throw new Error(payload.error?.message || traceText("error", "The decision trace could not be loaded."));
        renderMemoryTrace(payload.data);
      } catch {
        if (disposed || requestId !== traceRequestId || selectedId !== node.id) return;
        if (inspectorRationalesSection) inspectorRationalesSection.hidden = false;
        if (inspectorTraceStatus) {
          inspectorTraceStatus.hidden = false;
          inspectorTraceStatus.textContent = traceText("traceLoadFailure", "The real data could not be loaded. You can continue selecting nodes on the map.");
        }
        activeTracePayload = null;
        activeRationaleId = null;
        renderConceptTrace();
        root.classList.add("has-trace-selection");
        if (pathwayPrompt) pathwayPrompt.textContent = traceText("traceLoadFailure", "The real data could not be loaded. You can continue selecting nodes on the map.");
      }
    };
    const renderLegend = () => {
      if (!projectLegend) return;
      projectLegend.innerHTML = "";
      if (preset === "utilization") {
        const gradient = document.createElement("span");
        gradient.className = "legend-utilization-gradient";
        gradient.title = "low → high utilization";
        projectLegend.appendChild(gradient);
        return;
      }
        const values = preset === "owner"
        ? [...new Set(data.nodes.filter((node) => node.node_type === "memory" && node.owner_principal).map((node) => node.owner_principal as string))].sort()
        : projectKeys;
      for (const value of values) {
        const projectNode = preset === "project"
          ? data.nodes.find((node) => node.node_type === "project" && node.project_id === value)
          : undefined;
        const item = document.createElement(projectNode ? "button" : "span");
        item.className = `memory-map-project-legend-item${projectNode ? " is-clickable" : ""}`;
        if (projectNode) {
          (item as HTMLButtonElement).type = "button";
          item.dataset.projectId = value;
          item.dataset.projectLegendItem = "true";
          item.setAttribute("aria-pressed", "false");
          item.title = `${value} · ${mapText("selectedNode", "Selected node")}`;
          item.setAttribute("aria-label", `${value} · ${mapText("selectedNode", "Selected node")}`);
          item.addEventListener("click", () => { if (!disposed) focusProjectNode(projectNode); });
        }
        const dot = document.createElement("i");
        const color = hashColor(value);
        dot.style.background = color;
        const label = document.createElement("span");
        label.textContent = value;
        label.style.color = color;
        item.appendChild(dot);
        item.appendChild(label);
        projectLegend.appendChild(item);
      }
    };
    const focusGraphNode = (node: MapNode) => renderer?.focus(node.id);
    const focusProjectNode = (node: MapNode) => {
      selectNode(node);
      focusGraphNode(node);
    };
    const displayNodeLabel = (node: MapNode) => node.node_type === "decision"
      ? node.label
        .replace(/^[a-z][a-z0-9_-]*:\s*/iu, "")
        .replace(/\s*[（(](?:synthetic case|合成ケース|合成用例)\s*\d+[）)]\s*$/iu, "")
      : node.label;
    const selectNode = (node: MapNode | null, options: { keyboard?: boolean; preserveStep?: boolean } = {}) => {
      selectedId = node?.id || "";
      detailRequestId += 1;
      traceRequestId += 1;
      selectedRelatedIds = node ? relatedNodeIdsFor(node.id) : new Set<string>();
      root.querySelectorAll<HTMLElement>("[data-project-legend-item]").forEach((item) => {
        const focused = Boolean(node?.node_type === "project" && node.project_id && item.dataset.projectId === node.project_id);
        item.classList.toggle("is-focused", focused);
        item.setAttribute("aria-pressed", String(focused));
      });
      const isDecision = node?.node_type === "decision";
      const isProject = node?.node_type === "project";
      const isEntity = node?.node_type === "entity";
      const isTenant = node?.node_type === "tenant";
      const isMemory = node?.node_type === "memory" || Boolean(node?.memory_id);
      clearInspectorDetails();
      if (!options.preserveStep) activeTraceStep = "decision";
      const hasTraceTarget = Boolean(node && (isMemory || isDecision));
      root.classList.toggle("has-trace-selection", hasTraceTarget);
      const inspector = root.querySelector<HTMLElement>("[data-map-inspector]");
      setSheetState(options.preserveStep ? "peek" : hasTraceTarget ? "half" : "peek");
      if (node) {
        renderNodeMetadata(node);
      }
      if (inspectorKind) inspectorKind.textContent = node
        ? ({
            tenant: mapText("tenantRoot", "Tenant root"),
            project: mapText("projectHub", "Project hub"),
            entity: mapText("sharedConcept", "Shared concept"),
            decision: mapText("decisionKind", "Decision"),
            memory: mapText("memoryKind", "Memory")
          }[node.node_type || "memory"] || mapText("nodeKind", "Node"))
        : mapText("nothingSelected", "Nothing selected");
      if (inspectorTitle) inspectorTitle.textContent = node ? displayNodeLabel(node) : mapText("selectNode", "Select a node.");
      if (inspectorSummary) inspectorSummary.textContent = node
        ? isDecision
          ? `${mapText("decisionKind", "Decision")} / ${node.decision_type || mapText("relatedMemory", "related rationale")} · ${node.confirmation_state || mapText("notSet", "unconfirmed")}`
          : isTenant
            ? `${mapText("tenantRoot", "Tenant root")} · ${node.member_count || 0} ${mapText("projectsLabel", "projects")} · ${node.reference_count.toLocaleString()} ${mapText("memoriesLabel", "memories")}`
          : isProject
            ? `${mapText("projectHub", "Project hub")} · ${node.member_count || node.reference_count} ${mapText("membersLabel", "visible members")}`
          : isEntity
              ? `${mapText("sharedConcept", "Shared concept")} / ${node.entity_type || mapText("nodeKind", "entity")} · ${node.reference_count} ${mapText("memoriesLabel", "memories")}`
              : (node.summary || node.label)
        : mapText("selectNodeHint", "Select a node to inspect its owner, references, and net savings.");
      if (inspectorProject) inspectorProject.textContent = node?.project_id || (isTenant ? mapText("tenantRoot", "Tenant root") : mapText("notSet", "Not set"));
      if (inspectorOwner) inspectorOwner.textContent = node?.owner_principal || mapText("noAssignment", "Unassigned");
      if (inspectorRefs) inspectorRefs.textContent = node
        ? isDecision
          ? `${mapText("relatedMemory", "related memory")} · ${node.related_memory_id || "—"}`
          : isTenant
            ? `${node.member_count || 0} ${mapText("projectsLabel", "projects")} / ${node.reference_count.toLocaleString()} ${mapText("memoriesLabel", "memories")}`
          : isProject
            ? `${node.member_count || node.reference_count} ${mapText("membersLabel", "members")}`
          : isEntity
              ? `${node.reference_count} ${mapText("memoriesLabel", "memories")} / ${node.entity_link_count || node.reference_count} ${mapText("linksLabel", "links")}`
              : `${node.reference_count} ${mapText("refsLabel", "refs")} / ${node.consumer_count} ${mapText("peopleLabel", "people")}`
        : "—";
      if (inspectorUtilization) inspectorUtilization.textContent = node?.utilization_rate === null || !node ? mapText("unmeasured", "Not measured") : `${Math.round(node.utilization_rate * 100)}%`;
      if (inspectorSaved) inspectorSaved.textContent = node ? `${node.net_saved_tokens.toLocaleString()} ${mapText("tokensLabel", "tokens")}` : "—";
      if (inspectorLink) inspectorLink.href = node?.decision_id
        ? resourceDetailsHref(node.decision_id)
        : node?.memory_id
        ? `/memories?tenant_id=${encodeURIComponent(root.dataset.tenantId || "default")}&scope=${root.dataset.scope || "org"}&view=search&page=1&selected=${encodeURIComponent(node.memory_id)}`
          : isTenant
            ? `/memories?tenant_id=${encodeURIComponent(root.dataset.tenantId || "default")}&scope=${root.dataset.scope || "org"}`
          : isProject
            ? `/memories?tenant_id=${encodeURIComponent(root.dataset.tenantId || "default")}&scope=${root.dataset.scope || "org"}&project_id=${encodeURIComponent(node.project_id || "")}`
            : isEntity
              ? `/memories/constellation?tenant_id=${encodeURIComponent(root.dataset.tenantId || "default")}&scope=${root.dataset.scope || "org"}&q=${encodeURIComponent(node.label)}`
          : "/memories";
      if (inspectorLink) inspectorLink.textContent = isDecision
        ? traceText("openDetailsNewTab", "Open details in a new tab")
        : `${mapText("openMemory", "Open in memory library")} ↗`;
      if (inspectorLink) inspectorLink.hidden = !node;
      if (selectionStatus) selectionStatus.textContent = node
        ? `${mapText("selectedNode", "Selected node")}: ${displayNodeLabel(node)}`
        : mapText("nothingSelected", "Nothing selected");
      if (viewTraceLink) viewTraceLink.hidden = !hasTraceTarget;
      if (hasTraceTarget && node) {
        updatePathway(null, null);
        root.classList.add("has-trace-selection");
        if (pathwayPrompt) pathwayPrompt.textContent = traceText("instancePrompt", "Use the four steps to inspect this decision's real data.");
        void loadMemoryTrace(node);
      } else {
        renderConceptTrace();
      }
      if (isMemory && node) void loadMemoryDetail(node);
      updateRouteState();
      updateGraph();
      if (options.keyboard && accessibleSearch) {
        accessibleSearch.value = "";
        closeSearchResults();
        updateGraph();
      }
      refreshAccessibleChoices();
      if (options.keyboard && node) scheduleFrame(() => {
        accessibleSearch?.focus({ preventScroll: true });
        closeSearchResults();
      });
    };
    renderLegend();
    renderConceptTrace();
    const initialNode = data.nodes.find((node) => node.id === selectedId || node.memory_id === selectedId || node.decision_id === selectedId || node.id === selectedId.replace(/^memory:/, ""));
    if (initialNode) {
      selectNode(initialNode, { preserveStep: preserveInitialTraceStep });
      preserveInitialTraceStep = false;
    }
    const renderFallback = (reason: string) => {
      if (stage) stage.hidden = true;
      stage?.setAttribute("aria-busy", "false");
      if (fallback) fallback.hidden = false;
      if (renderStatus) renderStatus.textContent = reason;
      if (fallbackList) {
        fallbackList.innerHTML = "";
        for (const node of data.nodes.filter((candidate) => candidate.node_type === "memory").filter(visible).slice(0, 24)) {
          const item = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.className = "memory-map-fallback-node";
          button.innerHTML = `<span class="fallback-node-dot" style="background:${colorFor(node)}"></span><div><strong></strong><small></small></div><b></b>`;
          const strong = button.querySelector("strong");
          const small = button.querySelector("small");
          const count = button.querySelector("b");
          if (strong) strong.textContent = node.label;
          if (small) small.textContent = `${node.project_id || mapText("notSet", "Not set")} · ${node.owner_principal || mapText("noAssignment", "Unassigned")}`;
          if (count) count.textContent = `${node.reference_count} ${mapText("refsLabel", "refs")}`;
          button.addEventListener("click", () => { if (!disposed) selectNode(node, { keyboard: true }); });
          item.appendChild(button);
          fallbackList.appendChild(item);
        }
      }
      if (inspectorSummary && reason) inspectorSummary.textContent = `${reason} ${inspectorSummary.textContent || ""}`.trim();
    };
    const redirectToList = (reason: string) => {
      renderFallback(reason);
    };
    search?.addEventListener("input", updateGraph, { signal: events.signal });
    for (const [index, button] of pathwayButtons.entries()) {
      button.addEventListener("click", () => {
        setActiveTraceStep(normalizeTraceStep(button.dataset.traceStep), { focus: Boolean(activeTracePayload) });
        const selectedNode = data.nodes.find((node) => node.id === selectedId);
        if (selectedNode) focusGraphNode(selectedNode);
      }, { signal: events.signal });
      button.addEventListener("keydown", (event) => {
        const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown"
          ? Math.min(pathwayButtons.length - 1, index + 1)
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? Math.max(0, index - 1)
            : event.key === "Home" ? 0 : event.key === "End" ? pathwayButtons.length - 1 : -1;
        if (nextIndex < 0 || nextIndex === index) return;
        event.preventDefault();
        pathwayButtons[nextIndex]?.focus();
        setActiveTraceStep(normalizeTraceStep(pathwayButtons[nextIndex]?.dataset.traceStep), { focus: false });
        const selectedNode = data.nodes.find((node) => node.id === selectedId);
        if (selectedNode) focusGraphNode(selectedNode);
      }, { signal: events.signal });
    }
    root.addEventListener("click", async (event) => {
      const action = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-copy-value]");
      if (!action) return;
      const value = action.dataset.copyValue || "";
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        if (disposed) return;
        const original = action.textContent || traceText("copyReference", "Copy reference");
        action.textContent = traceText("copied", "Copied");
        later(() => { action.textContent = original; }, 1400);
      } catch {
        if (disposed) return;
        action.title = value;
      }
    }, { signal: events.signal });
    for (const close of root.querySelectorAll<HTMLButtonElement>("[data-map-resource-dialog-close], [data-map-resource-dialog-done]")) {
      close.addEventListener("click", () => resourceDialog?.close(), { signal: events.signal });
    }
    resourceDialog?.addEventListener("click", (event) => {
      if (event.target === resourceDialog) resourceDialog.close();
    }, { signal: events.signal });
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || window.matchMedia("(min-width: 901px)").matches) return;
      setSheetState("peek");
    }, { signal: events.signal });
    const selectableNodes = data.nodes.filter((candidate) => candidate.node_type === "decision" || candidate.node_type === "memory");
    const pickerNodeLabel = (node: MapNode) => presentNarrative(displayNodeLabel(node))
      .replace(/^[^|]+\|\s*[^|]+\|\s*/u, "")
      .replace(/^[a-z][a-z0-9_-]*:\s*/iu, "")
      .trim();
    const pickerNodeKind = (node: MapNode) => {
      const failure = node.decision_type === "failure_prevention"
        || /(?:^|\|)\s*failure\s*(?:\||$)/iu.test(node.label)
        || /^failure_prevention\s*:/iu.test(node.label);
      if (failure) return traceText("failureKind", "Failure learning");
      return node.node_type === "decision" ? mapText("decisionKind", "Decision") : mapText("memoryKind", "Memory");
    };
    const renderAccessibleChoices = (rawQuery = "") => {
      if (!accessibleList) return;
      const query = rawQuery.trim().toLocaleLowerCase();
      const matches = selectableNodes.filter((node) => {
        if (!query) return true;
        return [pickerNodeLabel(node), pickerNodeKind(node), node.id, node.project_id || "", node.confirmation_state || ""]
          .some((value) => value.toLocaleLowerCase().includes(query));
      });
      const orderedMatches = selectedId
        ? [...matches.filter((node) => node.id === selectedId), ...matches.filter((node) => node.id !== selectedId)]
        : matches;
      const visible = orderedMatches.slice(0, 6);
      accessibleList.innerHTML = "";
      for (const node of visible) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "memory-map-accessible-node";
        button.dataset.mapAccessibleNodeId = node.id;
        button.setAttribute("aria-pressed", String(node.id === selectedId));
        button.setAttribute("aria-current", String(node.id === selectedId));
        appendText(button, "strong", pickerNodeLabel(node));
        appendText(button, "span", pickerNodeKind(node), "memory-map-accessible-node-kind");
        appendText(button, "span", `${mapText("projectLabel", "Project")}: ${node.project_id || mapText("notSet", "Not set")}`, "memory-map-accessible-node-project");
        appendText(button, "span", `${mapText("confirmationLabel", "Confirmation")}: ${stateValueLabel(node.confirmation_state || mapText("notSet", "Not set"))}`, "memory-map-accessible-node-state");
        button.addEventListener("click", () => {
          if (disposed) return;
          selectNode(node, { keyboard: true });
          focusGraphNode(node);
        });
        item.appendChild(button);
        accessibleList.appendChild(item);
      }
      if (accessibleCount) {
        accessibleCount.textContent = traceText("pickerCount", "Showing {visible} of {total}")
          .replace("{visible}", String(visible.length))
          .replace("{total}", String(matches.length));
      }
    };
    refreshAccessibleChoices = () => renderAccessibleChoices(accessibleSearch?.value || "");
    openSearchResults = () => {
      if (!searchResults || !accessibleSearch) return;
      searchResults.hidden = false;
      accessibleSearch.setAttribute("aria-expanded", "true");
    };
    closeSearchResults = () => {
      if (!searchResults || !accessibleSearch) return;
      searchResults.hidden = true;
      accessibleSearch.setAttribute("aria-expanded", "false");
    };
    renderAccessibleChoices();
    accessibleSearch?.addEventListener("focus", () => {
      renderAccessibleChoices(accessibleSearch.value);
      openSearchResults();
    }, { signal: events.signal });
    accessibleSearch?.addEventListener("input", () => {
      renderAccessibleChoices(accessibleSearch.value);
      openSearchResults();
    }, { signal: events.signal });
    accessibleSearch?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearchResults();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "Enter") return;
      const firstChoice = accessibleList?.querySelector<HTMLButtonElement>("[data-map-accessible-node-id]");
      if (!firstChoice) return;
      event.preventDefault();
      if (event.key === "Enter") firstChoice.click();
      else firstChoice.focus();
    }, { signal: events.signal });
    commandBar?.addEventListener("keydown", (event) => {
      const choice = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-map-accessible-node-id]");
      if (!choice) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearchResults();
        accessibleSearch?.focus();
      }
    }, { signal: events.signal });
    document.addEventListener("click", (event) => {
      if (!commandBar?.contains(event.target as Node)) closeSearchResults();
    }, { signal: events.signal });
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-map-preset]")) {
      button.addEventListener("click", () => {
        preset = button.dataset.mapPreset || "project";
        root.querySelectorAll("[data-map-preset]").forEach((candidate) => candidate.classList.toggle("is-active", candidate === button));
        renderLegend();
        updateGraph();
      }, { signal: events.signal });
    }
    fitButton?.addEventListener("click", () => {
      if (!renderer?.fit(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 450)) {
        if (renderStatus) renderStatus.textContent = mapText("mapRenderFallback", "The accessible list is active.");
        return;
      }
      if (renderStatus) renderStatus.textContent = mapText("fitAll", "Fit all nodes");
    }, { signal: events.signal });
    sheetToggle?.addEventListener("click", () => {
      const inspector = root.querySelector<HTMLElement>("[data-map-inspector]");
      const expanded = inspector?.dataset.sheetState !== "peek";
      setSheetState(expanded ? "peek" : "expanded");
    }, { signal: events.signal });
    renderer = createMemoryMapRenderer(root, data, renderInput(), mapText,
      (id) => selectNode(id ? data.nodes.find((node) => node.id === id) || null : null), redirectToList);
    const syncVisibility = () => renderer?.setVisible(pageVisible && intersects && document.visibilityState === "visible");
    document.addEventListener("visibilitychange", syncVisibility, { signal: events.signal });
    window.addEventListener("pagehide", (event) => {
      if (!event.persisted) dispose();
      else { pageVisible = false; syncVisibility(); }
    }, { signal: events.signal });
    window.addEventListener("pageshow", () => { pageVisible = true; syncVisibility(); }, { signal: events.signal });
    const intersectionObserver = "IntersectionObserver" in window
      ? new IntersectionObserver(([entry]) => { intersects = Boolean(entry?.isIntersecting); syncVisibility(); }, { threshold: 0.01 })
      : null;
    intersectionObserver?.observe(root);
    syncVisibility();
    function dispose() {
      if (disposed) return;
      disposed = true;
      detailRequestId += 1;
      traceRequestId += 1;
      events.abort();
      intersectionObserver?.disconnect();
      for (const id of timeouts) window.clearTimeout(id);
      for (const id of frames) window.cancelAnimationFrame(id);
      renderer?.dispose();
      renderer = null;
      for (const container of [accessibleList, fallbackList, inspectorRationales, projectLegend]) container?.replaceChildren();
    }
    return dispose;
  }
