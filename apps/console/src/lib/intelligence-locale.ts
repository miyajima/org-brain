import { normalizeLocale, type Locale } from "./decision-ui";

const EN_COPY = {
  common: {
    unavailable: "Unavailable",
    notMeasured: "Not measured",
    events: "events",
    critical: "critical",
    activeTasks: "active tasks",
    read: "read",
    write: "write",
    nodes: "nodes",
    edges: "edges",
    omitted: "nodes omitted",
    items: "items",
    links: "links",
    global: "global",
    revisions: "revisions",
    sources: "sources",
    partial: "partial",
    complete: "complete",
    notRecorded: "Not recorded in the snapshot",
    severity: {
      info: "Info",
      warning: "Warning",
      critical: "Critical"
    }
  },
  nav: {
    memoriesAria: "Memory views",
    decisionsAria: "Decision views",
    constellation: "Knowledge connections",
    explorer: "Explorer",
    strata: "Knowledge history",
    decisionEditor: "Decision Editor"
  },
  poller: {
    live: "Live",
    stale: "Data is stale",
    lastUpdated: "Last updated",
    refresh: "Refresh",
    newData: "New data is available. Refreshing now.",
    retry: "Refresh failed. Retrying in {seconds} seconds.",
    refreshing: "Refreshing",
    reconnecting: "Data is stale · Reconnecting",
    paused: "Paused",
    stopped: "Stopped"
  },
  nervous: {
    eyebrow: "Activity · Organizational Nervous System",
    title: "Organization activity",
    description: "See your organization learning in real time: who is reading and writing knowledge, how work is moving, and where attention is needed.",
    reviewSignals: "Review signals",
    replay24: "Replay the last 24 hours",
    periodLabel: "Time range",
    periods: { "24h": "24 hours", "3d": "3 days", "7d": "7 days", "30d": "30 days" },
    replayPeriod: "Replay {period}",
    noActivityTitle: "No activity to show yet",
    noActivityBody: "Task, memory, and decision events in this tenant / project will appear here.",
    agentsHeading: "Observed AI agents",
    brainHeading: "Organizational memory (Org Brain)",
    projectsHeading: "Projects / decisions",
    topologyTitle: "Activity paths between agents, Org Brain, and projects",
    topologyDescription: "Lines represent real events observed in the last 24 hours. The same items are available in the following list.",
    topologyDescriptionPeriod: "Lines represent real events observed during the selected {period}. The same items are available in the following list.",
    remember: "Remember",
    storeStructure: "Store · structure",
    understand: "Understand",
    searchRelate: "Search · relate",
    evaluate: "Evaluate",
    trustFreshness: "Trust · freshness",
    use: "Apply",
    shareGenerate: "Share · generate",
    capabilitiesHeading: "Org Brain activity",
    capabilityCount: "{count} events",
    noCapabilityActivity: "No activity in this period",
    filterByCapability: "Filter the timeline by {capability}",
    showAllActivity: "Show all activity",
    filteredEventCount: "{capability}: {count} of {total} events",
    observedAgents: "Observed agents",
    relatedProjects: "Related projects",
    attentionEyebrow: "Attention",
    attentionTitle: "Signals that need intervention",
    selectedEvent: "Selected event",
    target: "Target",
    status: "Status",
    occurredAt: "Occurred at",
    openTrace: "Open trace",
    openTask: "Review Task",
    replayEyebrow: "Replay",
    replayTitle: "Events in the last 24 hours",
    replayTitlePeriod: "Events from the last {period}",
    now: "Now",
    hoursAgo: "{hours}h ago",
    daysAgo: "{days}d ago",
    eventTypes: "Event types",
    noPeriodEvents: "No events in this period.",
    timeUnknown: "Time unavailable",
    active: "active",
    idle: "idle",
    omittedSummary: "Some activity is summarized",
    moreEventsAvailable: "More events exist beyond the loaded page.",
    omittedAgents: "{count} additional observed agents",
    omittedProjects: "{count} additional projects",
    omittedSignals: "{count} additional attention signals",
    eventList: "Browse all events"
  },
  constellation: {
    eyebrow: "Knowledge Constellation",
    title: "Knowledge connections",
    description: "Select a piece of knowledge to see the decisions, sources, projects, and tasks connected to it.",
    area: "Domain",
    search: "Search knowledge",
    searchPlaceholder: "Title, summary, or ID",
    apply: "Apply",
    nodeTypes: {
      all: "All domains",
      memory: "Memory",
      decision: "Decision",
      resource: "Resource",
      entity: "Entity",
      project: "Project",
      task: "Task"
    },
    visualKinds: {
      memory: "Memory",
      decision: "Decision",
      lesson: "Lesson",
      warning: "Warning",
      evidence: "Evidence",
      project: "Project",
      task: "Task"
    },
    pollerLabel: "Refreshes every 30 seconds",
    nodeTypesAria: "Node types",
    mapTitle: "Org Brain knowledge graph",
    mapDescription: "Shows only the nodes and relationships returned by the API around the selected knowledge. The same items are operable from the following list.",
    emptyTitle: "No nodes to show",
    emptyBody: "Change the filter or refresh after the knowledge graph has been generated.",
    relationsTruncated: "Some relationships are hidden by the display limit.",
    summary: "Summary",
    noSummary: "No summary has been recorded.",
    trustUse: "Trust and usage",
    confidence: "Confidence",
    usage30: "30-day usage",
    degree: "Connections",
    lastUsed: "Last used",
    impact: "Impact",
    status: "Status",
    unset: "Not set",
    clusters: "Clusters",
    relatedEdges: "Related edges",
    openRecord: "Review content",
    exploreList: "Review relationships",
    selectNode: "Select a node.",
    accessibleList: "Accessible list",
    visibleKnowledge: "Visible knowledge",
    visibleRelations: "Visible relationships",
      directed: "Directed",
      mutual: "Mutual",
      mapEyebrow: "Memory constellation / WebGL",
      memoryMapTitle: "3D memory map",
      mapAriaLabel: "3D memory map",
      allNodesMode: "All readable nodes",
      topNodesMode: "Representative nodes",
      allNodesAction: "Show all nodes",
      topNodesAction: "Show representative nodes",
      visibleNodes: "visible nodes",
      sourceMemories: "memories in scope",
      truncatedNodes: "Some nodes are omitted by the display ceiling",
      searchFilters: "Search & filters",
      searchMap: "Search map",
      mapSearchPlaceholder: "memory ID / summary / owner",
      presetsAria: "Map color presets",
      projectPreset: "Project",
      ownerPreset: "Owner",
      utilizationPreset: "Utilization",
      openList: "Open memory list",
      allProjects: "All projects",
      allOwners: "All owners",
      myMemories: "My memories",
      from: "From",
      to: "To",
      anyPeriod: "Any period",
      applyFilters: "Apply filters",
      fallbackTitle: "3D view is unavailable; the accessible list remains available",
      fallbackBody: "Search, select a node, and inspect its decision path on this page. You can also open the full memory list with the same filters.",
      openMemoryList: "Open memory list",
      selectedNode: "Selected node",
      nothingSelected: "Nothing selected",
      selectNodeHint: "Select a node to inspect its owner, references, and net savings.",
      projectLabel: "Project",
      ownerLabel: "Owner",
      referencesLabel: "References",
      utilizationLabel: "Utilization",
      netSavedLabel: "Net saved",
      tagsLabel: "Tags",
      contentLabel: "Content",
      historyLabel: "History",
      tenantRoot: "Tenant root",
      projectHub: "Project hub",
      sharedConcept: "Shared concept",
      memoryKind: "Memory",
      decisionKind: "Decision",
      nodeKind: "Node",
      noAssignment: "Unassigned",
      notSet: "Not set",
      unmeasured: "Not measured",
      openMemory: "Open in memory library",
      creatorLabel: "Creator",
      decisionTypeLabel: "Decision type",
      relatedMemory: "related memory",
      projectsLabel: "projects",
      memoriesLabel: "memories",
      membersLabel: "members",
      linksLabel: "links",
      peopleLabel: "people",
      refsLabel: "refs",
      tokensLabel: "tokens",
      sourceNodeLegend: "line color = source node",
      directedRelationLegend: "directed relation",
      mapInteractionHint: "Use the list to select a node. The 3D view is visual only.",
      fitAll: "Fit all nodes",
      fitAllAria: "Fit the complete memory map in view",
      legend: "Map legend",
      mapLegend: "Map legend",
      legendSelected: "Selected node",
      legendAmbient: "Readable node",
      legendStageDecision: "Decision",
      legendStageReason: "Reason",
      legendStageEvidence: "Evidence",
      legendStageArtifact: "Artifact",
      loadingNodes: "Rendering nodes…",
      expandPanel: "Open details",
      collapsePanel: "Close details",
      idLabel: "ID",
      nodeTypeLabel: "Node type",
      labelLabel: "Label",
      summaryLabel: "Summary",
      tenantLabel: "Tenant",
      usedLabel: "Used",
      consumersLabel: "Consumers",
      injectedTokensLabel: "Injected tokens",
      updatedLabel: "Updated",
      clusterLabel: "Cluster",
      entityTypeLabel: "Entity type",
      confirmationLabel: "Confirmation",
      confidenceLabel: "Confidence",
      sourceLabel: "Source",
      externalKeyLabel: "External key",
      kindLabel: "Kind",
      lifecycleLabel: "Lifecycle",
      currentVersionLabel: "Current version",
      actorLabel: "Actor",
      createdLabel: "Created",
      lastAccessedLabel: "Last accessed",
      utilityLabel: "Utility",
      deletedAtLabel: "Deleted at",
      deletedByLabel: "Deleted by",
      deleteReasonLabel: "Delete reason",
      detailUsageIdLabel: "Detail usage ID",
      verificationSampledLabel: "Verification sampled",
      yesLabel: "yes",
      noLabel: "no",
      loadingMemoryDetail: "Loading content, history, and evidence…",
      detailFallback: "Details could not be loaded; showing map metadata.",
      mapRenderFallback: "The 3D view could not be rendered, so the list is shown.",
      trace: {
      eyebrow: "Decision trace",
      decision: "Decision",
      decisionKey: "Decision key",
      decisionValue: "Decision",
      status: "Status",
      reason: "Why this was chosen",
      reasonDetail: "Reason",
      trigger: "Trigger",
      question: "Question",
      alternatives: "Rejected alternatives",
      evidence: "Evidence",
      outcome: "Outcome and reuse",
      outcomeValue: "Outcome",
      verifiedOutcome: "Verified outcome",
      artifacts: "Reflected artifacts",
      sources: "Sources",
      implementation: "Implementation",
      verification: "Verification",
      source: "Source",
      symptom: "Symptom",
      rootCause: "Root cause",
      correction: "Correction",
      avoidanceRule: "Prevention rule",
      reuseWhen: "Reuse when",
      missingDecision: "Decision not recorded",
      missingReason: "Reason not recorded",
      missingAlternative: "Rejected alternative not recorded",
      missingEvidence: "Evidence not recorded",
      missingArtifact: "Formal artifact link not registered",
      missingVerification: "Verification is not confirmed",
      noRationales: "No decision or failure learning is attached.",
      noArtifacts: "No readable confirmed artifacts are linked.",
      unverified: "Not verified",
      loading: "Loading decision trace…",
      error: "The decision trace could not be loaded.",
      manageArtifacts: "Manage artifact links",
      openResource: "Open resource record",
      previewResource: "Preview here",
      resourcePreview: "Artifact preview",
      closePreview: "Close preview",
      openDetailsNewTab: "Open details in a new tab",
      localReference: "Local reference",
      pinnedVersion: "Pinned version",
      lifecycle: "Lifecycle",
      locator: "Locator",
      notAvailable: "Not available",
      partial: "Some trace fields are missing"
      ,pathwayEyebrow: "Decision lineage"
      ,pathwayTitle: "The path of a decision"
      ,pathwayIntro: "Follow what was decided, why it was chosen, what supports it, and where it was reflected."
      ,stepDecision: "Decision"
      ,stepDecisionDescription: "What was decided"
      ,stepReason: "Reason"
      ,stepReasonDescription: "Why it was chosen"
      ,stepEvidence: "Evidence"
      ,stepEvidenceDescription: "What supports it"
      ,stepArtifact: "Artifact"
      ,stepArtifactDescription: "Where it was reflected"
      ,conceptPrompt: "Select a decision node to inspect a real path."
      ,instancePrompt: "Use the four steps to inspect this decision's real data."
      ,currentPath: "This decision path"
      ,technicalDetails: "Technical details"
      ,panelControls: "Trace panel controls"
      ,expandPanel: "Expand"
      ,collapsePanel: "Collapse"
      ,keyboardSelection: "Search and select a node"
      ,keyboardSearch: "Filter decisions and memories"
      ,keyboardSearchPlaceholder: "Search nodes"
      ,availableState: "Available"
      ,confirmedState: "Confirmed"
      ,evidenceCount: "Evidence · {count}"
      ,artifactCount: "Artifacts · {count}"
      ,missingState: "Missing"
      ,unverifiedState: "Unverified"
      ,truncatedState: "Partial"
      ,conceptDecisionDetail: "Start with the conclusion the organization adopted."
      ,conceptReasonDetail: "Review the reasoning, constraints, and rejected alternatives."
      ,conceptEvidenceDetail: "Check the files, commands, statements, and sources that support the claim."
      ,conceptArtifactDetail: "Confirm the implementation, output, or verification result where the decision landed."
      ,failureDecision: "Failure and learning"
      ,failureKind: "Failure learning"
      ,failureDecisionDescription: "What happened"
      ,failureReason: "Root cause"
      ,failureReasonDescription: "Why it happened"
      ,failureEvidence: "Verification"
      ,failureEvidenceDescription: "How it was checked"
      ,failureArtifact: "Correction and prevention"
      ,failureArtifactDescription: "What changed"
      ,conceptFailureDecisionDetail: "Start with the observed symptom and the lesson recorded from it."
      ,conceptFailureReasonDetail: "Separate the root cause from the visible symptom."
      ,conceptFailureEvidenceDetail: "Compare the failing and successful evidence used to verify the correction."
      ,conceptFailureArtifactDetail: "Confirm the correction, verified outcome, and rule that prevents recurrence."
      ,copyReference: "Copy reference"
      ,copied: "Copied"
      ,resourceDetails: "Resource details"
      ,evidenceDetails: "Evidence details"
      ,previousStep: "Previous"
      ,nextStep: "Next"
      ,inspectReason: "Inspect the reason"
      ,supportsDecision: "Supports the decision"
      ,supportsReason: "Supports the reason"
      ,supportsCause: "Supports the cause"
      ,supportsVerification: "Supports verification"
      ,supportsOther: "Other evidence"
      ,decisionSelector: "Decision"
      ,failedApproach: "Failed approach"
      ,constraints: "Constraints"
      ,reasonPreview: "Reason preview"
      ,traceLoadFailure: "The real data could not be loaded. You can continue selecting nodes on the map."
      ,outputArtifact: "Output artifact"
      ,resourceKindDocument: "Document"
      ,resourceKindTestResult: "Test result"
      ,resourceKindBuild: "Build"
      ,resourceKindOutput: "Output"
      ,resourceKindSourceFile: "Source file"
      ,stateActive: "Active"
      ,stateRetired: "Retired"
      ,stateArchived: "Archived"
      ,stateCurrent: "Current"
      ,successfulCommand: "Successful run"
      ,failedCommand: "Failed run"
      ,commandEvidence: "Command"
      ,fileEvidence: "File"
      ,userStatementEvidence: "User statement"
      ,toolCallEvidence: "Tool call"
      ,pickerCount: "Showing {visible} of {total}"
      ,viewDecisionPath: "View decision path"
    }
  },
  strata: {
    eyebrow: "Memory Strata",
    title: "Knowledge history",
    description: "Understand what is currently adopted, what changed, and which decisions, learnings, assumptions, and sources support it.",
    reviewChanges: "Review today's changes",
    project: "Project",
    all: "All",
    lineageType: "Lineage type",
    apply: "Apply",
    selected: "Selected",
    openCanonical: "Review current content",
    timelineAria: "Organizational knowledge timeline",
    today: "Today",
    legendCanonical: "Currently adopted",
    legendSupport: "Supporting",
    legendWarning: "Possibly superseded or conflicting",
    legendTruncated: "Display limit reached",
    mobileTitle: "Knowledge revision history",
    emptyTitle: "No knowledge lineage to show",
    emptyBody: "Revisions and current states recorded in this scope will appear here as strata.",
    selectedEyebrow: "Selected lineage",
    historyTitle: "Revision history for selected knowledge",
    revisionsTruncated: "Some older revisions were omitted because the display limit was reached.",
    sourcesTruncated: "Some sources were omitted because the display limit was reached.",
    currentStateAria: "Current knowledge state",
    currentState: "Current state",
    snapshotState: "Snapshot state",
    confirmationState: "Confirmation state",
    validFrom: "valid_from",
    validUntil: "valid_until",
    supersession: "Superseding record",
    snapshot: "Snapshot",
    revisions: "Revisions",
    changesFrom: "Changes from {id}",
    firstRecord: "Initial record",
    changesSincePrevious: "Changes from the previous record",
    noPreviousRevision: "There is no previous revision to compare.",
    missingSnapshots: "Field differences cannot be shown because both adjacent snapshots were not stored.",
    noComparableChanges: "No stored comparable fields changed.",
    before: "Before",
    after: "After",
    noRevisions: "No revisions have been stored.",
    relationsSourcesAria: "Relationships and sources",
    relations: "Relationships",
    noRelations: "No relationships have been stored.",
    sources: "Sources",
    noSources: "No sources have been stored.",
    unresolved: "Unresolved",
    attentionEyebrow: "Current attention",
    attentionTitle: "Items needing attention",
    viewDetails: "View details",
    noAttention: "No lineages currently need review.",
    dateUnknown: "Date unavailable",
    fieldMissing: "(field absent)",
    unrenderable: "(value cannot be displayed)",
    fieldLabels: {
      status: "Status",
      current_state: "Current state",
      lifecycle_state: "Lifecycle",
      extraction_state: "Extraction state",
      confirmation_state: "Confirmation state",
      confirmationState: "Confirmation state",
      valid_from: "Valid from",
      validFrom: "Valid from",
      valid_until: "Valid until",
      validUntil: "Valid until",
      superseded_by: "Superseding record",
      supersededBy: "Superseding record",
      partial: "Partial snapshot"
    },
    changeKinds: {
      added: "Added",
      removed: "Removed",
      changed: "Changed"
    },
    lanes: {
      canonical: { label: "Current truth", sublabel: "Canonical" },
      decision: { label: "Decisions", sublabel: "Decisions" },
      learning: { label: "Learnings and insights", sublabel: "Learnings" },
      assumption: { label: "Assumptions and hypotheses", sublabel: "Assumptions" },
      source: { label: "Primary sources", sublabel: "Sources" }
    }
  },
  routes: {
    nervousTitle: "Activity · Org Brain",
    constellationTitle: "Knowledge connections · Org Brain",
    strataTitle: "Knowledge history · Org Brain",
    activityError: "Activity could not be loaded",
    graphError: "The knowledge graph could not be loaded",
    strataError: "The complete knowledge history could not be loaded"
  }
} as const;

type WidenStrings<T> = {
  [K in keyof T]: T[K] extends string ? string : WidenStrings<T[K]>;
};

export type IntelligenceCopy = WidenStrings<typeof EN_COPY>;

export const INTELLIGENCE_PAGE_COPY: Record<Locale, IntelligenceCopy> = {
  en: EN_COPY,
  ja: {
    common: {
      unavailable: "未取得",
      notMeasured: "未計測",
      events: "件のイベント",
      critical: "重大",
      activeTasks: "件の実行中タスク",
      read: "読取",
      write: "書込",
      nodes: "ノード",
      edges: "エッジ",
      omitted: "ノードを省略",
      items: "件",
      links: "接続",
      global: "全体",
      revisions: "リビジョン",
      sources: "参照元",
      partial: "部分",
      complete: "完全",
      notRecorded: "スナップショットに未記録",
      severity: {
        info: "情報",
        warning: "警告",
        critical: "重大"
      }
    },
    nav: {
      memoriesAria: "メモリ表示",
      decisionsAria: "意思決定表示",
      constellation: "知識のつながり",
      explorer: "エクスプローラー",
      strata: "知識の履歴",
      decisionEditor: "意思決定エディター"
    },
    poller: {
      live: "ライブ",
      stale: "データが古い",
      lastUpdated: "最終更新",
      refresh: "更新",
      newData: "新しいデータを反映します。",
      retry: "更新に失敗しました。{seconds}秒後に再試行します。",
      refreshing: "更新中",
      reconnecting: "データが古い · 再接続中",
      paused: "一時停止",
      stopped: "停止"
    },
    nervous: {
      eyebrow: "活動 · 組織の神経系",
      title: "組織の活動",
      description: "あなたの組織がリアルタイムで学習する様子と、誰が知識を使い、どこに対応が必要かを確認できます。",
      reviewSignals: "シグナルを確認",
      replay24: "過去24時間をリプレイ",
      periodLabel: "表示期間",
      periods: { "24h": "24時間", "3d": "3日", "7d": "7日", "30d": "30日" },
      replayPeriod: "過去{period}をリプレイ",
      noActivityTitle: "表示できるアクティビティはまだありません",
      noActivityBody: "このテナント / プロジェクトでタスク・メモリ・意思決定のイベントが記録されると、ここに経路が現れます。",
      agentsHeading: "観測中のAIエージェント",
      brainHeading: "組織メモリ（Org Brain）",
      projectsHeading: "プロジェクト / 意思決定",
      topologyTitle: "エージェント、Org Brain、プロジェクト間のアクティビティ経路",
      topologyDescription: "線は直近24時間に観測された実イベントの流れを表します。詳細は直後のリストでも確認できます。",
      topologyDescriptionPeriod: "線は選択した過去{period}に観測された実イベントの流れを表します。詳細は直後のリストでも確認できます。",
      remember: "記憶する",
      storeStructure: "保存・構造化",
      understand: "理解する",
      searchRelate: "検索・関連付け",
      evaluate: "評価する",
      trustFreshness: "信頼・鮮度",
      use: "活用する",
      shareGenerate: "共有・生成",
      capabilitiesHeading: "Org Brainの活動分類",
      capabilityCount: "{count}件",
      noCapabilityActivity: "この期間の活動なし",
      filterByCapability: "タイムラインを「{capability}」で絞り込む",
      showAllActivity: "すべての活動を表示",
      filteredEventCount: "{capability}：{count} / {total}件",
      observedAgents: "観測中のエージェント",
      relatedProjects: "関連プロジェクト",
      attentionEyebrow: "注目",
      attentionTitle: "介入が必要なシグナル",
      selectedEvent: "選択中のイベント",
      target: "対象",
      status: "状態",
      occurredAt: "発生時刻",
      openTrace: "トレースを開く",
      openTask: "Taskを確認",
      replayEyebrow: "リプレイ",
      replayTitle: "過去24時間のイベント",
      replayTitlePeriod: "過去{period}のイベント",
      now: "現在",
      hoursAgo: "{hours}時間前",
      daysAgo: "{days}日前",
      eventTypes: "イベント種別",
      noPeriodEvents: "この期間のイベントはありません。",
      timeUnknown: "時刻不明",
      active: "稼働中",
      idle: "待機中",
      omittedSummary: "一部のアクティビティを要約表示しています",
      moreEventsAvailable: "読み込み済みページより前にもイベントがあります。",
      omittedAgents: "観測中のエージェントをさらに {count} 件省略",
      omittedProjects: "プロジェクトをさらに {count} 件省略",
      omittedSignals: "注目シグナルをさらに {count} 件省略",
      eventList: "すべてのイベントを一覧表示"
    },
    constellation: {
      eyebrow: "知識のつながり · ナレッジ・コンステレーション",
      title: "知識のつながり",
      description: "知識を選び、関連する判断・資料・プロジェクト・Taskと影響範囲を探索します。",
      area: "領域",
      search: "知識を検索",
      searchPlaceholder: "タイトル・要約・ID",
      apply: "適用",
      nodeTypes: {
        all: "すべての領域",
        memory: "メモリ",
        decision: "意思決定",
        resource: "資料",
        entity: "エンティティ",
        project: "プロジェクト",
        task: "タスク"
      },
      visualKinds: {
        memory: "メモリ",
        decision: "意思決定",
        lesson: "学び",
        warning: "警告",
        evidence: "根拠",
        project: "プロジェクト",
        task: "タスク"
      },
      pollerLabel: "30秒ごとに更新",
      nodeTypesAria: "ノード種別",
      mapTitle: "Org Brain ナレッジグラフ",
      mapDescription: "選択した知識を中心に、APIが返したノードと関係のみを表示しています。後続のリストからも同じ項目を操作できます。",
      emptyTitle: "表示できるノードがありません",
      emptyBody: "フィルタを変更するか、ナレッジグラフの生成後に再読み込みしてください。",
      relationsTruncated: "表示上限により、一部の関係を省略しています。",
      summary: "要約",
      noSummary: "要約は登録されていません。",
      trustUse: "信頼度・利用",
      confidence: "信頼度",
      usage30: "30日利用",
      degree: "接続数",
      lastUsed: "最終利用",
      impact: "インパクト",
      status: "状態",
      unset: "未設定",
      clusters: "クラスター",
      relatedEdges: "関連エッジ",
      openRecord: "内容を確認",
      exploreList: "関連を確認",
      selectNode: "ノードを選択してください。",
      accessibleList: "アクセシブルリスト",
      visibleKnowledge: "表示中の知識",
      visibleRelations: "表示中の関係",
      directed: "方向あり",
      mutual: "相互",
      mapEyebrow: "メモリ・コンステレーション · WebGL",
      memoryMapTitle: "3Dメモリマップ",
      mapAriaLabel: "3Dメモリマップ",
      allNodesMode: "閲覧可能な全ノード",
      topNodesMode: "代表ノード",
      allNodesAction: "全ノードを表示",
      topNodesAction: "代表表示に戻す",
      visibleNodes: "表示ノード",
      sourceMemories: "範囲内のメモリ",
      truncatedNodes: "表示上限により一部ノードを省略しています",
      searchFilters: "検索・フィルター",
      searchMap: "マップを検索",
      mapSearchPlaceholder: "メモリID・要約・所有者",
      presetsAria: "マップの色分け",
      projectPreset: "プロジェクト",
      ownerPreset: "所有者",
      utilizationPreset: "利用率",
      openList: "メモリ一覧を開く",
      allProjects: "すべてのプロジェクト",
      allOwners: "すべての所有者",
      myMemories: "自分のメモリ",
      from: "開始",
      to: "終了",
      anyPeriod: "期間指定なし",
      applyFilters: "フィルターを適用",
      fallbackTitle: "3D表示を利用できませんが、検索・一覧は利用できます",
      fallbackBody: "この画面でノードを検索・選択し、判断経路を確認できます。同じ条件のメモリ一覧も開けます。",
      openMemoryList: "メモリ一覧を開く",
      selectedNode: "選択したノード",
      nothingSelected: "未選択",
      selectNodeHint: "ノードを選択すると、所有者・参照数・純削減を確認できます。",
      projectLabel: "プロジェクト",
      ownerLabel: "所有者",
      referencesLabel: "参照数",
      utilizationLabel: "利用率",
      netSavedLabel: "純削減",
      tagsLabel: "タグ",
      contentLabel: "本文",
      historyLabel: "変更履歴",
      tenantRoot: "テナント直下",
      projectHub: "プロジェクトハブ",
      sharedConcept: "共有コンセプト",
      memoryKind: "メモリ",
      decisionKind: "意思決定",
      nodeKind: "ノード",
      noAssignment: "未割り当て",
      notSet: "未設定",
      unmeasured: "未計測",
      openMemory: "メモリライブラリで開く",
      creatorLabel: "作成者",
      decisionTypeLabel: "意思決定種別",
      relatedMemory: "関連メモリ",
      projectsLabel: "プロジェクト",
      memoriesLabel: "メモリ",
      membersLabel: "メンバー",
      linksLabel: "リンク",
      peopleLabel: "人",
      refsLabel: "参照",
      tokensLabel: "tokens",
      sourceNodeLegend: "線の色 = 起点ノード",
      directedRelationLegend: "方向付きの関係",
      mapInteractionHint: "リストからノードを選択できます。3D表示は視覚的な補助です。",
      fitAll: "全体を表示",
      fitAllAria: "メモリマップ全体を表示",
      legend: "マップの凡例",
      mapLegend: "マップの凡例",
      legendSelected: "選択中のノード",
      legendAmbient: "閲覧可能なノード",
      legendStageDecision: "決定",
      legendStageReason: "理由",
      legendStageEvidence: "根拠",
      legendStageArtifact: "成果物",
      loadingNodes: "ノードを描画中…",
      expandPanel: "詳細を開く",
      collapsePanel: "詳細を閉じる",
      idLabel: "ID",
      nodeTypeLabel: "ノード種別",
      labelLabel: "ラベル",
      summaryLabel: "概要",
      tenantLabel: "テナント",
      usedLabel: "使用回数",
      consumersLabel: "利用者数",
      injectedTokensLabel: "注入トークン",
      updatedLabel: "更新日時",
      clusterLabel: "クラスタ",
      entityTypeLabel: "エンティティ種別",
      confirmationLabel: "確認状態",
      confidenceLabel: "信頼度",
      sourceLabel: "ソース",
      externalKeyLabel: "外部キー",
      kindLabel: "種別",
      lifecycleLabel: "ライフサイクル",
      currentVersionLabel: "現行バージョン",
      actorLabel: "アクター",
      createdLabel: "作成日時",
      lastAccessedLabel: "最終アクセス",
      utilityLabel: "有用度",
      deletedAtLabel: "削除日時",
      deletedByLabel: "削除者",
      deleteReasonLabel: "削除理由",
      detailUsageIdLabel: "詳細利用ID",
      verificationSampledLabel: "検証サンプル取得",
      yesLabel: "はい",
      noLabel: "いいえ",
      loadingMemoryDetail: "本文・履歴・根拠を読み込んでいます…",
      detailFallback: "詳細を取得できないため、マップ上の情報を表示しています。",
      mapRenderFallback: "3D描画を確認できなかったため一覧表示にします。",
      trace: {
        eyebrow: "意思決定トレース",
        decision: "決定事項",
        decisionKey: "決定キー",
        decisionValue: "決定内容",
        status: "状態",
        reason: "判断理由・採用理由",
        reasonDetail: "判断理由",
        trigger: "きっかけ",
        question: "問い",
        alternatives: "却下した代替案",
        evidence: "根拠",
        outcome: "結果・再利用条件",
        outcomeValue: "結果",
        verifiedOutcome: "検証された結果",
        artifacts: "反映された成果物",
        sources: "判断の参照元",
        implementation: "実装成果物",
        verification: "検証成果物",
        source: "ソース",
        symptom: "発生した症状",
        rootCause: "根本原因",
        correction: "修正内容",
        avoidanceRule: "再発防止ルール",
        reuseWhen: "再利用条件",
        missingDecision: "決定事項が未記録です",
        missingReason: "判断理由が未記録です",
        missingAlternative: "却下した代替案が未記録です",
        missingEvidence: "根拠が未記録です",
        missingArtifact: "正式成果物リンク未登録です",
        missingVerification: "検証済みとして確認されていません",
        noRationales: "意思決定または失敗学習が紐付いていません。",
        noArtifacts: "閲覧可能なConfirmed成果物が紐付いていません。",
        unverified: "未検証",
        loading: "意思決定トレースを読み込んでいます…",
        error: "意思決定トレースを取得できませんでした。",
        manageArtifacts: "成果物リンクを管理",
        openResource: "資料レコードを開く",
        previewResource: "この画面で確認",
        resourcePreview: "成果物プレビュー",
        closePreview: "プレビューを閉じる",
        openDetailsNewTab: "資料詳細を別タブで開く",
        localReference: "ローカル参照",
        pinnedVersion: "固定バージョン",
        lifecycle: "ライフサイクル",
        locator: "位置",
        notAvailable: "利用できません",
        partial: "一部のトレース項目が不足しています"
        ,pathwayEyebrow: "判断の系譜"
        ,pathwayTitle: "判断の道筋"
        ,pathwayIntro: "何を決め、なぜ選び、何が支え、どこへ反映されたかを順に確認します。"
        ,stepDecision: "決定"
        ,stepDecisionDescription: "何を決めたか"
        ,stepReason: "理由"
        ,stepReasonDescription: "なぜその案を選んだか"
        ,stepEvidence: "根拠"
        ,stepEvidenceDescription: "何が判断を支えたか"
        ,stepArtifact: "成果物"
        ,stepArtifactDescription: "どこに反映されたか"
        ,conceptPrompt: "意思決定ノードを選んで実データを見てください。"
        ,instancePrompt: "4段階を使って、この判断の実データを確認できます。"
        ,currentPath: "この判断の道筋"
        ,technicalDetails: "技術情報"
        ,panelControls: "トレースパネル操作"
        ,expandPanel: "広げる"
        ,collapsePanel: "縮める"
        ,keyboardSelection: "ノードを検索・選択"
        ,keyboardSearch: "決定・メモリを絞り込む"
        ,keyboardSearchPlaceholder: "ノードを検索"
        ,availableState: "確認可能"
        ,confirmedState: "確認済み"
        ,evidenceCount: "根拠 {count}件"
        ,artifactCount: "成果物 {count}件"
        ,missingState: "未登録"
        ,unverifiedState: "未検証"
        ,truncatedState: "一部のみ"
        ,conceptDecisionDetail: "組織が採用した結論から確認します。"
        ,conceptReasonDetail: "判断理由、制約、却下した代替案を確認します。"
        ,conceptEvidenceDetail: "判断を支えたファイル、コマンド、発話、参照元を確認します。"
        ,conceptArtifactDetail: "判断が反映された実装、出力、検証結果を確認します。"
        ,failureDecision: "失敗・学び"
        ,failureKind: "失敗学習"
        ,failureDecisionDescription: "何が起きたか"
        ,failureReason: "根本原因"
        ,failureReasonDescription: "なぜ起きたか"
        ,failureEvidence: "検証"
        ,failureEvidenceDescription: "何で確かめたか"
        ,failureArtifact: "修正・再発防止"
        ,failureArtifactDescription: "何に反映したか"
        ,conceptFailureDecisionDetail: "観測された症状と、そこから得た学びを確認します。"
        ,conceptFailureReasonDetail: "表面上の症状と根本原因を分けて確認します。"
        ,conceptFailureEvidenceDetail: "失敗時と成功時の根拠を比較し、修正を検証します。"
        ,conceptFailureArtifactDetail: "修正内容、検証結果、再発防止ルールを確認します。"
        ,copyReference: "参照をコピー"
        ,copied: "コピーしました"
        ,resourceDetails: "資料の詳細"
        ,evidenceDetails: "根拠の詳細"
        ,previousStep: "前へ"
        ,nextStep: "次へ"
        ,inspectReason: "理由を確認する"
        ,supportsDecision: "決定を支持"
        ,supportsReason: "理由を支持"
        ,supportsCause: "原因を支持"
        ,supportsVerification: "検証を支持"
        ,supportsOther: "その他の根拠"
        ,decisionSelector: "判断を切り替える"
        ,failedApproach: "失敗した方法"
        ,constraints: "制約"
        ,reasonPreview: "理由の要約"
        ,traceLoadFailure: "実データを読み込めませんでした。マップの選択は継続できます。"
        ,outputArtifact: "出力成果物"
        ,resourceKindDocument: "文書"
        ,resourceKindTestResult: "テスト結果"
        ,resourceKindBuild: "ビルド"
        ,resourceKindOutput: "出力"
        ,resourceKindSourceFile: "ソースファイル"
        ,stateActive: "利用中"
        ,stateRetired: "廃止済み"
        ,stateArchived: "アーカイブ済み"
        ,stateCurrent: "現行"
        ,successfulCommand: "修正後の実行"
        ,failedCommand: "失敗した実行"
        ,commandEvidence: "コマンド"
        ,fileEvidence: "ファイル"
        ,userStatementEvidence: "ユーザー発話"
        ,toolCallEvidence: "ツール実行"
        ,pickerCount: "{total}件中{visible}件を表示"
        ,viewDecisionPath: "判断経路を見る"
      }
    },
    strata: {
      eyebrow: "知識の履歴 · メモリ地層",
      title: "知識の履歴",
      description: "現在採用されている内容と、その根拠になった意思決定・学び・仮説・一次情報を時間に沿って確認します。",
      reviewChanges: "今日の変更をレビュー",
      project: "プロジェクト",
      all: "すべて",
      lineageType: "系譜タイプ",
      apply: "適用",
      selected: "選択中",
      openCanonical: "現在の内容を確認",
      timelineAria: "組織知識の時間軸",
      today: "今日",
      legendCanonical: "現在採用されている内容",
      legendSupport: "サポート中",
      legendWarning: "上書き・矛盾の可能性",
      legendTruncated: "表示上限に達しています",
      mobileTitle: "知識の更新履歴",
      emptyTitle: "表示できる知識系譜がありません",
      emptyBody: "このスコープでリビジョンまたは現在状態が記録されると、ここに地層として表示されます。",
      selectedEyebrow: "選択した系譜",
      historyTitle: "選択した知識の変更履歴",
      revisionsTruncated: "古いリビジョンの一部は表示上限により省略されています。",
      sourcesTruncated: "参照元の一部は表示上限により省略されています。",
      currentStateAria: "現在の知識状態",
      currentState: "現在の状態",
      snapshotState: "スナップショットの状態",
      confirmationState: "確認状態",
      validFrom: "有効開始",
      validUntil: "有効終了",
      supersession: "後継レコード",
      snapshot: "スナップショット",
      revisions: "リビジョン",
      changesFrom: "{id} からの変更",
      firstRecord: "初回記録",
      changesSincePrevious: "直前の記録からの変更",
      noPreviousRevision: "比較対象となる以前のリビジョンはありません。",
      missingSnapshots: "隣接する両方のスナップショットが保存されていないため、項目差分は表示できません。",
      noComparableChanges: "保存されている比較可能な項目に変更はありません。",
      before: "前",
      after: "後",
      noRevisions: "保存されたリビジョンはありません。",
      relationsSourcesAria: "関係と参照元",
      relations: "関係",
      noRelations: "保存された関係はありません。",
      sources: "参照元",
      noSources: "保存された参照元はありません。",
      unresolved: "未解決",
      attentionEyebrow: "現在の注目",
      attentionTitle: "現在の注目事項",
      viewDetails: "詳細を表示",
      noAttention: "現在レビューが必要な系譜はありません。",
      dateUnknown: "日付不明",
      fieldMissing: "（フィールドなし）",
      unrenderable: "（表示できない値）",
      fieldLabels: {
        status: "ステータス",
        current_state: "現在の状態",
        lifecycle_state: "ライフサイクル",
        extraction_state: "抽出状態",
        confirmation_state: "確認状態",
        confirmationState: "確認状態",
        valid_from: "有効期間（開始）",
        validFrom: "有効期間（開始）",
        valid_until: "有効期間（終了）",
        validUntil: "有効期間（終了）",
        superseded_by: "後継レコード",
        supersededBy: "後継レコード",
        partial: "部分スナップショット"
      },
      changeKinds: {
        added: "追加",
        removed: "削除",
        changed: "変更"
      },
      lanes: {
        canonical: { label: "現在の真実", sublabel: "現在採用中" },
        decision: { label: "意思決定", sublabel: "意思決定" },
        learning: { label: "学びと洞察", sublabel: "学び" },
        assumption: { label: "前提と仮説", sublabel: "前提" },
        source: { label: "一次情報", sublabel: "参照元" }
      }
    },
    routes: {
      nervousTitle: "活動 · Org Brain",
      constellationTitle: "知識のつながり · Org Brain",
      strataTitle: "知識の履歴 · Org Brain",
      activityError: "アクティビティを取得できませんでした",
      graphError: "ナレッジグラフを取得できませんでした",
      strataError: "知識の履歴をすべて取得できませんでした"
    }
  },
  zh: {
    common: {
      unavailable: "未获取",
      notMeasured: "未测量",
      events: "个事件",
      critical: "严重",
      activeTasks: "个进行中的任务",
      read: "读取",
      write: "写入",
      nodes: "个节点",
      edges: "条边",
      omitted: "个节点已省略",
      items: "项",
      links: "个连接",
      global: "全局",
      revisions: "次修订",
      sources: "个来源",
      partial: "部分",
      complete: "完整",
      notRecorded: "快照中未记录",
      severity: {
        info: "信息",
        warning: "警告",
        critical: "严重"
      }
    },
    nav: {
      memoriesAria: "记忆视图",
      decisionsAria: "决策视图",
      constellation: "知识关联",
      explorer: "浏览器",
      strata: "知识历史",
      decisionEditor: "决策编辑器"
    },
    poller: {
      live: "实时",
      stale: "数据已过期",
      lastUpdated: "最后更新",
      refresh: "刷新",
      newData: "发现新数据，正在刷新。",
      retry: "刷新失败，将在 {seconds} 秒后重试。",
      refreshing: "刷新中",
      reconnecting: "数据已过期 · 正在重新连接",
      paused: "已暂停",
      stopped: "已停止"
    },
    nervous: {
      eyebrow: "活动 · 组织神经系统",
      title: "组织活动",
      description: "查看组织实时学习的过程、知识使用情况以及需要处理的信号。",
      reviewSignals: "查看信号",
      replay24: "回放过去 24 小时",
      periodLabel: "显示范围",
      periods: { "24h": "24 小时", "3d": "3 天", "7d": "7 天", "30d": "30 天" },
      replayPeriod: "回放过去{period}",
      noActivityTitle: "暂无可显示的活动",
      noActivityBody: "此租户 / 项目的任务、记忆和决策事件将显示在这里。",
      agentsHeading: "正在观测的 AI 智能体",
      brainHeading: "组织记忆（Org Brain）",
      projectsHeading: "项目 / 决策",
      topologyTitle: "智能体、Org Brain 与项目之间的活动路径",
      topologyDescription: "连线表示过去 24 小时内观测到的真实事件流。后面的列表也提供相同内容。",
      topologyDescriptionPeriod: "连线表示所选过去{period}内观测到的真实事件流。后面的列表也提供相同内容。",
      remember: "记忆",
      storeStructure: "存储 · 结构化",
      understand: "理解",
      searchRelate: "搜索 · 关联",
      evaluate: "评估",
      trustFreshness: "可信度 · 新鲜度",
      use: "应用",
      shareGenerate: "共享 · 生成",
      capabilitiesHeading: "Org Brain 活动分类",
      capabilityCount: "{count} 个事件",
      noCapabilityActivity: "此时间段内无活动",
      filterByCapability: "按“{capability}”筛选时间线",
      showAllActivity: "显示全部活动",
      filteredEventCount: "{capability}：{count} / {total} 个事件",
      observedAgents: "正在观测的智能体",
      relatedProjects: "相关项目",
      attentionEyebrow: "关注",
      attentionTitle: "需要介入的信号",
      selectedEvent: "已选事件",
      target: "对象",
      status: "状态",
      occurredAt: "发生时间",
      openTrace: "打开追踪",
      openTask: "查看任务",
      replayEyebrow: "回放",
      replayTitle: "过去 24 小时的事件",
      replayTitlePeriod: "过去{period}的事件",
      now: "现在",
      hoursAgo: "{hours} 小时前",
      daysAgo: "{days} 天前",
      eventTypes: "事件类型",
      noPeriodEvents: "此时间段内没有事件。",
      timeUnknown: "时间未知",
      active: "活跃",
      idle: "空闲",
      omittedSummary: "部分活动已汇总显示",
      moreEventsAvailable: "已加载页面之前还有更多事件。",
      omittedAgents: "另有 {count} 个已观测智能体",
      omittedProjects: "另有 {count} 个项目",
      omittedSignals: "另有 {count} 个关注信号",
      eventList: "浏览所有事件"
    },
    constellation: {
      eyebrow: "Knowledge Constellation · 知识星图",
      title: "知识关联",
      description: "选择知识，探索相关决策、资料、项目、任务及其影响范围。",
      area: "领域",
      search: "搜索知识",
      searchPlaceholder: "标题、摘要或 ID",
      apply: "应用",
      nodeTypes: {
        all: "所有领域",
        memory: "记忆",
        decision: "决策",
        resource: "资料",
        entity: "实体",
        project: "项目",
        task: "任务"
      },
      visualKinds: {
        memory: "记忆",
        decision: "决策",
        lesson: "经验",
        warning: "警告",
        evidence: "证据",
        project: "项目",
        task: "任务"
      },
      pollerLabel: "每 30 秒刷新",
      nodeTypesAria: "节点类型",
      mapTitle: "Org Brain 知识图谱",
      mapDescription: "仅显示 API 返回的、围绕所选知识的节点和关系。后面的列表也可操作相同内容。",
      emptyTitle: "暂无可显示的节点",
      emptyBody: "请更改筛选条件，或在知识图谱生成后刷新。",
      relationsTruncated: "部分关系因达到显示上限而被省略。",
      summary: "摘要",
      noSummary: "尚未记录摘要。",
      trustUse: "可信度与使用情况",
      confidence: "可信度",
      usage30: "30 天使用次数",
      degree: "连接数",
      lastUsed: "最后使用",
      impact: "影响",
      status: "状态",
      unset: "未设置",
      clusters: "集群",
      relatedEdges: "相关边",
      openRecord: "查看内容",
      exploreList: "查看关系",
      selectNode: "请选择一个节点。",
      accessibleList: "无障碍列表",
      visibleKnowledge: "当前知识",
      visibleRelations: "当前关系",
      directed: "有方向",
      mutual: "双向",
      mapEyebrow: "Memory 星图 · WebGL",
      memoryMapTitle: "3D 记忆地图",
      mapAriaLabel: "3D 记忆地图",
      allNodesMode: "全部可读节点",
      topNodesMode: "代表节点",
      allNodesAction: "显示全部节点",
      topNodesAction: "返回代表节点",
      visibleNodes: "显示节点",
      sourceMemories: "范围内记忆",
      truncatedNodes: "达到显示上限，部分节点已省略",
      searchFilters: "搜索与筛选",
      searchMap: "搜索地图",
      mapSearchPlaceholder: "记忆 ID / 摘要 / 所有者",
      presetsAria: "地图颜色预设",
      projectPreset: "项目",
      ownerPreset: "所有者",
      utilizationPreset: "使用率",
      openList: "打开记忆列表",
      allProjects: "所有项目",
      allOwners: "所有所有者",
      myMemories: "我的记忆",
      from: "从",
      to: "到",
      anyPeriod: "任意期间",
      applyFilters: "应用筛选",
      fallbackTitle: "3D视图不可用，但搜索和列表仍可使用",
      fallbackBody: "可在本页搜索和选择节点并查看决策路径，也可打开使用相同筛选条件的完整列表。",
      openMemoryList: "打开记忆列表",
      selectedNode: "已选节点",
      nothingSelected: "未选择",
      selectNodeHint: "选择节点以查看所有者、引用次数和净节省。",
      projectLabel: "项目",
      ownerLabel: "所有者",
      referencesLabel: "引用",
      utilizationLabel: "使用率",
      netSavedLabel: "净节省",
      tagsLabel: "标签",
      contentLabel: "正文",
      historyLabel: "变更历史",
      tenantRoot: "租户根节点",
      projectHub: "项目中心",
      sharedConcept: "共享概念",
      memoryKind: "记忆",
      decisionKind: "决策",
      nodeKind: "节点",
      noAssignment: "未分配",
      notSet: "未设置",
      unmeasured: "未测量",
      openMemory: "在记忆库中打开",
      creatorLabel: "创建者",
      decisionTypeLabel: "决策类型",
      relatedMemory: "相关记忆",
      projectsLabel: "项目",
      memoriesLabel: "记忆",
      membersLabel: "成员",
      linksLabel: "链接",
      peopleLabel: "人员",
      refsLabel: "引用",
      tokensLabel: "tokens",
      sourceNodeLegend: "线条颜色 = 起点节点",
      directedRelationLegend: "有向关系",
      mapInteractionHint: "请使用列表选择节点。3D视图仅用于视觉辅助。",
      fitAll: "显示全部节点",
      fitAllAria: "显示完整记忆地图",
      legend: "地图图例",
      mapLegend: "地图图例",
      legendSelected: "已选节点",
      legendAmbient: "可读取节点",
      legendStageDecision: "决策",
      legendStageReason: "理由",
      legendStageEvidence: "依据",
      legendStageArtifact: "成果物",
      loadingNodes: "正在绘制节点…",
      expandPanel: "打开详情",
      collapsePanel: "关闭详情",
      idLabel: "ID",
      nodeTypeLabel: "节点类型",
      labelLabel: "标签",
      summaryLabel: "摘要",
      tenantLabel: "租户",
      usedLabel: "使用次数",
      consumersLabel: "使用者数",
      injectedTokensLabel: "注入令牌",
      updatedLabel: "更新时间",
      clusterLabel: "集群",
      entityTypeLabel: "实体类型",
      confirmationLabel: "确认状态",
      confidenceLabel: "置信度",
      sourceLabel: "来源",
      externalKeyLabel: "外部键",
      kindLabel: "类型",
      lifecycleLabel: "生命周期",
      currentVersionLabel: "当前版本",
      actorLabel: "操作者",
      createdLabel: "创建时间",
      lastAccessedLabel: "最后访问",
      utilityLabel: "效用",
      deletedAtLabel: "删除时间",
      deletedByLabel: "删除者",
      deleteReasonLabel: "删除原因",
      detailUsageIdLabel: "详情使用ID",
      verificationSampledLabel: "已采样验证",
      yesLabel: "是",
      noLabel: "否",
      loadingMemoryDetail: "正在加载正文、历史和证据…",
      detailFallback: "无法加载详情，显示地图元数据。",
      mapRenderFallback: "无法渲染3D视图，已显示列表。",
      trace: {
        eyebrow: "决策追踪",
        decision: "决策事项",
        decisionKey: "决策键",
        decisionValue: "决策内容",
        status: "状态",
        reason: "判断理由",
        reasonDetail: "判断理由",
        trigger: "触发条件",
        question: "问题",
        alternatives: "被否决的替代方案",
        evidence: "证据",
        outcome: "结果与复用条件",
        outcomeValue: "结果",
        verifiedOutcome: "已验证结果",
        artifacts: "已反映的成果",
        sources: "判断来源",
        implementation: "实现成果",
        verification: "验证成果",
        source: "来源",
        symptom: "症状",
        rootCause: "根本原因",
        correction: "修正",
        avoidanceRule: "防止复发规则",
        reuseWhen: "复用条件",
        missingDecision: "未记录决策事项",
        missingReason: "未记录判断理由",
        missingAlternative: "未记录被否决的替代方案",
        missingEvidence: "未记录证据",
        missingArtifact: "尚未登记正式成果链接",
        missingVerification: "尚未确认验证完成",
        noRationales: "没有关联决策或失败学习。",
        noArtifacts: "没有可读取的已确认成果。",
        unverified: "未验证",
        loading: "正在加载决策追踪…",
        error: "无法加载决策追踪。",
        manageArtifacts: "管理成果链接",
        openResource: "打开资料记录",
        previewResource: "在此预览",
        resourcePreview: "成果预览",
        closePreview: "关闭预览",
        openDetailsNewTab: "在新标签页打开详情",
        localReference: "本地引用",
        pinnedVersion: "固定版本",
        lifecycle: "生命周期",
        locator: "定位",
        notAvailable: "不可用",
        partial: "部分追踪字段缺失"
        ,pathwayEyebrow: "决策脉络"
        ,pathwayTitle: "决策路径"
        ,pathwayIntro: "依次查看做了什么决定、为何选择、由什么支撑，以及反映到了哪里。"
        ,stepDecision: "决策"
        ,stepDecisionDescription: "决定了什么"
        ,stepReason: "理由"
        ,stepReasonDescription: "为何选择该方案"
        ,stepEvidence: "证据"
        ,stepEvidenceDescription: "什么支撑该判断"
        ,stepArtifact: "成果"
        ,stepArtifactDescription: "反映到了哪里"
        ,conceptPrompt: "请选择决策节点查看真实数据。"
        ,instancePrompt: "通过四个阶段查看此决策的真实数据。"
        ,currentPath: "此决策的路径"
        ,technicalDetails: "技术信息"
        ,panelControls: "追踪面板控制"
        ,expandPanel: "展开"
        ,collapsePanel: "收起"
        ,keyboardSelection: "搜索并选择节点"
        ,keyboardSearch: "筛选决策与记忆"
        ,keyboardSearchPlaceholder: "搜索节点"
        ,availableState: "可查看"
        ,confirmedState: "已确认"
        ,evidenceCount: "证据 {count} 条"
        ,artifactCount: "成果 {count} 项"
        ,missingState: "缺失"
        ,unverifiedState: "未验证"
        ,truncatedState: "部分"
        ,conceptDecisionDetail: "先查看组织采用的结论。"
        ,conceptReasonDetail: "查看判断理由、约束和被否决的替代方案。"
        ,conceptEvidenceDetail: "查看支撑主张的文件、命令、陈述和来源。"
        ,conceptArtifactDetail: "确认决策所落实到的实现、输出或验证结果。"
        ,failureDecision: "失败与学习"
        ,failureKind: "失败学习"
        ,failureDecisionDescription: "发生了什么"
        ,failureReason: "根本原因"
        ,failureReasonDescription: "为何发生"
        ,failureEvidence: "验证"
        ,failureEvidenceDescription: "如何确认"
        ,failureArtifact: "修正与防止复发"
        ,failureArtifactDescription: "改变了什么"
        ,conceptFailureDecisionDetail: "先查看观察到的症状以及由此记录的学习。"
        ,conceptFailureReasonDetail: "区分根本原因与表面症状。"
        ,conceptFailureEvidenceDetail: "比较失败和成功证据，以验证修正。"
        ,conceptFailureArtifactDetail: "确认修正、验证结果和防止复发规则。"
        ,copyReference: "复制引用"
        ,copied: "已复制"
        ,resourceDetails: "资料详情"
        ,evidenceDetails: "证据详情"
        ,previousStep: "上一步"
        ,nextStep: "下一步"
        ,inspectReason: "查看理由"
        ,supportsDecision: "支撑决策"
        ,supportsReason: "支撑理由"
        ,supportsCause: "支撑原因"
        ,supportsVerification: "支撑验证"
        ,supportsOther: "其他证据"
        ,decisionSelector: "切换决策"
        ,failedApproach: "失败的方法"
        ,constraints: "约束"
        ,reasonPreview: "理由摘要"
        ,traceLoadFailure: "无法加载真实数据。仍可继续在地图上选择节点。"
        ,outputArtifact: "输出成果"
        ,resourceKindDocument: "文档"
        ,resourceKindTestResult: "测试结果"
        ,resourceKindBuild: "构建"
        ,resourceKindOutput: "输出"
        ,resourceKindSourceFile: "源文件"
        ,stateActive: "使用中"
        ,stateRetired: "已停用"
        ,stateArchived: "已归档"
        ,stateCurrent: "当前"
        ,successfulCommand: "修正后的执行"
        ,failedCommand: "失败的执行"
        ,commandEvidence: "命令"
        ,fileEvidence: "文件"
        ,userStatementEvidence: "用户陈述"
        ,toolCallEvidence: "工具调用"
        ,pickerCount: "显示 {visible} / {total}"
        ,viewDecisionPath: "查看决策路径"
      }
    },
    strata: {
      eyebrow: "Memory Strata · 记忆地层",
      title: "知识历史",
      description: "查看当前采用的内容，以及支撑它的决策、学习、假设和一手资料。",
      reviewChanges: "查看今日变更",
      project: "项目",
      all: "全部",
      lineageType: "谱系类型",
      apply: "应用",
      selected: "已选择",
      openCanonical: "查看当前内容",
      timelineAria: "组织知识时间线",
      today: "今天",
      legendCanonical: "当前采用的内容",
      legendSupport: "支持中",
      legendWarning: "可能已被取代或存在冲突",
      legendTruncated: "已达到显示上限",
      mobileTitle: "知识修订历史",
      emptyTitle: "暂无可显示的知识谱系",
      emptyBody: "此范围内记录的修订或当前状态将以地层形式显示在这里。",
      selectedEyebrow: "已选谱系",
      historyTitle: "所选知识的变更历史",
      revisionsTruncated: "部分较早的修订因达到显示上限而被省略。",
      sourcesTruncated: "部分来源因达到显示上限而被省略。",
      currentStateAria: "当前知识状态",
      currentState: "当前状态",
      snapshotState: "快照状态",
      confirmationState: "确认状态",
      validFrom: "valid_from",
      validUntil: "valid_until",
      supersession: "后续记录",
      snapshot: "快照",
      revisions: "修订",
      changesFrom: "相对于 {id} 的变更",
      firstRecord: "首次记录",
      changesSincePrevious: "相对于上一条记录的变更",
      noPreviousRevision: "没有可比较的更早修订。",
      missingSnapshots: "由于相邻的两个快照未同时保存，无法显示字段差异。",
      noComparableChanges: "已保存的可比较字段没有变化。",
      before: "之前",
      after: "之后",
      noRevisions: "尚未保存修订。",
      relationsSourcesAria: "关系与来源",
      relations: "关系",
      noRelations: "尚未保存关系。",
      sources: "来源",
      noSources: "尚未保存来源。",
      unresolved: "未解析",
      attentionEyebrow: "当前关注",
      attentionTitle: "当前关注事项",
      viewDetails: "查看详情",
      noAttention: "当前没有需要审核的谱系。",
      dateUnknown: "日期未知",
      fieldMissing: "（字段不存在）",
      unrenderable: "（无法显示该值）",
      fieldLabels: {
        status: "状态",
        current_state: "当前状态",
        lifecycle_state: "生命周期",
        extraction_state: "提取状态",
        confirmation_state: "确认状态",
        confirmationState: "确认状态",
        valid_from: "有效期开始",
        validFrom: "有效期开始",
        valid_until: "有效期结束",
        validUntil: "有效期结束",
        superseded_by: "后续记录",
        supersededBy: "后续记录",
        partial: "部分快照"
      },
      changeKinds: {
        added: "新增",
        removed: "删除",
        changed: "变更"
      },
      lanes: {
        canonical: { label: "当前事实", sublabel: "权威知识" },
        decision: { label: "决策", sublabel: "决策" },
        learning: { label: "学习与洞察", sublabel: "学习" },
        assumption: { label: "假设与推测", sublabel: "假设" },
        source: { label: "一手资料", sublabel: "来源" }
      }
    },
    routes: {
      nervousTitle: "活动 · Org Brain",
      constellationTitle: "知识关联 · Org Brain",
      strataTitle: "知识历史 · Org Brain",
      activityError: "无法加载活动",
      graphError: "无法加载知识图谱",
      strataError: "无法加载完整的知识历史"
    }
  }
};

export const INTELLIGENCE_DATE_LOCALES: Record<Locale, string> = {
  en: "en-US",
  ja: "ja-JP",
  zh: "zh-CN"
};

export function intelligencePageCopy(value: string | null | undefined): IntelligenceCopy {
  return INTELLIGENCE_PAGE_COPY[normalizeLocale(value)];
}

export function intelligenceDateLocale(value: string | null | undefined): string {
  return INTELLIGENCE_DATE_LOCALES[normalizeLocale(value)];
}

export type { Locale as IntelligenceLocale };
