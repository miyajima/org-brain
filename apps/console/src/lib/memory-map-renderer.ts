import type { MapNode, GraphLink, MemoryMapData } from "./memory-map-controller";
import type { TraceStepId } from "./memory-map-trace-view";

export type MemoryMapRenderInput = {
  selectedId: string;
  selectedRelatedIds: ReadonlySet<string>;
  activeTraceStep: TraceStepId;
  preset: string;
  query: string;
};
export function memoryMapColors(data: MemoryMapData, state: () => { preset: string; selectedId: string; selectedRelatedIds: ReadonlySet<string> }) {
    const palette = [
      "#4bb8ff", "#9c87ff", "#ffb454", "#42d6ac",
      "#ff6f91", "#d9e85f", "#6f98ff", "#ef8fd1",
      "#56d6dc", "#ff8d5c", "#9bd95b", "#c6a0ff",
      "#f4ce5f", "#5fa8ff", "#ff9dbb", "#72d9ad"
    ];
    const projectKeys = [...new Set(
      data.nodes
        .filter((node) => node.node_type === "project" && node.project_id)
        .map((node) => node.project_id as string)
    )].sort((left, right) => left.localeCompare(right));
    const projectColorIndex = new Map(projectKeys.map((key, index) => [key, index % palette.length]));
    const hashColor = (value: string | null | undefined) => {
      const key = String(value || "unassigned");
      const assignedIndex = projectColorIndex.get(key);
      if (assignedIndex !== undefined) return palette[assignedIndex];
      let hash = 0;
      for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
      return palette[hash % palette.length];
    };
    const baseColorFor = (node: MapNode) => {
      if (node.node_type === "tenant") return "#f4d58b";
      if (node.node_type === "entity") return state().preset === "utilization" ? "#8496a3" : "#d8e6ee";
      if (node.node_type === "project") {
        if (state().preset === "owner") return "#c3a7ff";
        if (state().preset === "utilization") return "#8d9aa3";
        return hashColor(node.project_id);
      }
      if (node.node_type === "decision") {
        if (state().preset === "owner") return "#ffbf72";
        if (state().preset === "utilization") return "#8c7a68";
        return hashColor(node.project_id);
      }
      if (state().preset === "owner") return hashColor(node.owner_principal);
      if (state().preset === "utilization") {
        if (node.utilization_rate === null) return "#5e7180";
        const hue = Math.max(0, Math.min(125, node.utilization_rate * 125));
        return `hsl(${hue} 84% 62%)`;
      }
      return hashColor(node.project_id);
    };
    const colorFor = (node: MapNode) => {
      if (node.id === state().selectedId) return "#ffffff";
      if (state().selectedId && !state().selectedRelatedIds.has(node.id)) return "rgba(107,135,158,.2)";
      return baseColorFor(node);
    };
    const nodeValue = (node: MapNode) => {
      const base = node.node_type === "tenant"
        ? Math.max(14, Math.log2((node.member_count || node.reference_count) + 2) * 3.2)
        : node.node_type === "project"
          ? Math.max(7, Math.log2((node.member_count || node.reference_count) + 2) * 5)
        : node.node_type === "entity"
          ? Math.max(1.7, Math.log2(node.reference_count + 2) * 1.8)
          : node.node_type === "decision" ? 1.4 : Math.max(1.5, Math.log2(node.reference_count + 2) * 2.4);
      return base;
    };
    return { projectKeys, hashColor, baseColorFor, colorFor, nodeValue };
}

export function createMemoryMapRenderer(root: HTMLElement, data: MemoryMapData, initial: MemoryMapRenderInput,
  mapText: (key: string, fallback: string) => string,
  selectNode: (id: string | null) => void, redirectToList: (reason: string) => void) {
  let { selectedId, selectedRelatedIds, activeTraceStep, preset, query } = initial;
  const { baseColorFor, colorFor, nodeValue } = memoryMapColors(data, () => ({ selectedId, selectedRelatedIds, preset }));
  const stage = root.querySelector<HTMLElement>("[data-map-stage]");
  const glowOverlay = root.querySelector<SVGSVGElement>("[data-map-glow-overlay]");
  const svgGlowGroup = root.querySelector<SVGGElement>("[data-map-svg-glow]");
  const fallback = root.querySelector<HTMLElement>("[data-map-fallback]");
  const renderStatus = root.querySelector<HTMLElement>("[data-map-render-status]");
  const events = new AbortController();
  let disposed = false;
  const timeouts = new Set<number>();
  const frames = new Set<number>();
  const later = (callback: () => void, delay: number) => {
    const id = window.setTimeout(() => { timeouts.delete(id); if (!disposed) callback(); }, delay);
    timeouts.add(id); return id;
  };
  const clearLater = (id: number) => { window.clearTimeout(id); timeouts.delete(id); };
  const scheduleFrame = (callback: FrameRequestCallback) => {
    const id = window.requestAnimationFrame((time) => { frames.delete(id); if (!disposed) callback(time); });
    frames.add(id); return id;
  };
    type GraphInstance = {
      backgroundColor(value: string): GraphInstance;
      width(value: number): GraphInstance;
      height(value: number): GraphInstance;
      showNavInfo(value: boolean): GraphInstance;
      nodeLabel(fn: (node: MapNode) => string): GraphInstance;
      nodeVal(fn: (node: MapNode) => number): GraphInstance;
      nodeColor(fn: (node: MapNode) => string): GraphInstance;
      nodeThreeObject(fn: (node: MapNode) => unknown): GraphInstance;
      nodeThreeObjectExtend(value: boolean): GraphInstance;
      enablePointerInteraction?(value: boolean): GraphInstance;
      nodeOpacity(value: number): GraphInstance;
      nodeVisibility(fn: (node: MapNode) => boolean): GraphInstance;
      linkColor(fn: (link: GraphLink) => string): GraphInstance;
      linkVisibility(fn: (link: GraphLink) => boolean): GraphInstance;
      linkWidth(fn: (link: GraphLink) => number): GraphInstance;
      linkCurvature(fn: (link: GraphLink) => number): GraphInstance;
      linkOpacity(value: number): GraphInstance;
      linkDirectionalArrowLength(value: number | ((link: GraphLink) => number)): GraphInstance;
      linkDirectionalArrowRelPos(value: number): GraphInstance;
      linkDirectionalParticles(fn: (link: GraphLink) => number): GraphInstance;
      linkDirectionalParticleSpeed(value: number): GraphInstance;
      linkDirectionalParticleWidth(value: number): GraphInstance;
      linkDirectionalParticleColor(fn: (link: GraphLink) => string): GraphInstance;
      onBackgroundClick(fn: (event: MouseEvent) => void): GraphInstance;
      d3Force(name: string): { strength?(value: number): unknown } | null;
      camera(): unknown;
      cameraPosition(): { x: number; y: number; z: number };
      cameraPosition(position: { x?: number; y?: number; z?: number }, lookAt?: { x: number; y: number; z: number }, transitionMs?: number): GraphInstance;
      zoomToFit(durationMs?: number, padding?: number, nodeFilter?: (node: MapNode) => boolean): GraphInstance;
      onNodeClick(fn: (node: MapNode) => void): GraphInstance;
      graphData(value: { nodes: MapNode[]; links: GraphLink[] }): GraphInstance;
      pauseAnimation(): GraphInstance;
      resumeAnimation(): GraphInstance;
      _destructor(): void;
    };
    let graph: GraphInstance | null = null;
    let threeInstance: any = null;
    let svgProjectionVector: any = null;
    let glowPhase = 0;
    let pendingFocusId = "";
    let hasFocusedNode = false;
    let svgGlowLoopActive = false;
    let glowFrame: number | null = null;
    let mapVisible = document.visibilityState === "visible";
    let glowTimer: number | null = null;
    type GlowLayer = {
      scale: { set(x: number, y: number, z: number): void };
      material: { color: { set(value: string): void }; opacity: number };
      coreSize: number;
    };
    const glowLayers = new Map<string, { core: GlowLayer; halo: GlowLayer; outer: GlowLayer }>();
    let glowTexture: any = null;
    const nodeId = (item: string | MapNode) => typeof item === "string" ? item : item.id;
    const isSelectedLink = (link: GraphLink) => Boolean(selectedId && [link.source, link.target].some((item) => nodeId(item) === selectedId));
    const isCrossProjectLink = (link: GraphLink) => Boolean(link.cross_project) || link.relation?.startsWith("shared-cross:") || link.relation?.startsWith("entity-cross:") || link.relation?.startsWith("cross:");
    const isTenantLink = (link: GraphLink) => link.relation?.startsWith("tenant:") ?? false;
    const directRelatedNodeIdsFor = (id: string) => {
      const related = new Set<string>(id ? [id] : []);
      if (!id) return related;
      for (const link of data.links) {
        const source = nodeId(link.source);
        const target = nodeId(link.target);
        if (source === id) related.add(target);
        if (target === id) related.add(source);
      }
      return related;
    };
    const totalNodeCount = Number(data.total_count ?? data.nodes.length);
    // Calculate once at display start: sparse maps need a readable halo, while
    // dense maps keep the same visual language without turning into a light wall.
    const denseGraph = totalNodeCount > 1000 || data.nodes.length > 1000 || data.links.length > 2200;
    const budgetedGlow = denseGraph || totalNodeCount > 1500 || data.nodes.length > 1500;
    const ambientGlowIntensity = Math.max(0.78, Math.min(1.5, 2.2 - Math.log10(Math.max(1, totalNodeCount)) * 0.25));
    const ambientGlowSize = 0.82 + ambientGlowIntensity * 0.28;
    const svgAmbientOpacity = Math.min(budgetedGlow ? 0.4 : 0.62, (budgetedGlow ? 0.26 : 0.28) * ambientGlowIntensity);
    const svgGlowBudget = budgetedGlow ? 192 : 256;
    const glowImportance = (node: MapNode) => {
      const typeWeight = node.node_type === "tenant"
        ? 1_000_000_000
        : node.node_type === "project"
          ? 100_000_000
          : node.node_type === "entity" || node.node_type === "decision" ? 10_000_000 : 0;
      return typeWeight + node.reference_count * 100 + node.consumer_count * 10 + Math.max(0, node.net_saved_tokens);
    };
    const svgGlowNodes = [...data.nodes]
      .sort((left, right) => glowImportance(right) - glowImportance(left))
      .slice(0, svgGlowBudget);
    const svgGlowCircles = new Map<string, SVGCircleElement>();
    const svgSelectedGlow = glowOverlay && svgGlowGroup
      ? document.createElementNS("http://www.w3.org/2000/svg", "circle")
      : null;
    if (svgGlowGroup) {
      for (const node of svgGlowNodes) {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.dataset.nodeId = node.id;
        svgGlowGroup.appendChild(circle);
        svgGlowCircles.set(node.id, circle);
      }
      if (svgSelectedGlow) {
        svgSelectedGlow.dataset.selectedGlow = "true";
        svgGlowGroup.appendChild(svgSelectedGlow);
      }
    }
    const setSvgCirclePosition = (circle: SVGCircleElement, node: MapNode, selected = false) => {
      if (!graph || !threeInstance || !stage || !visible(node)) {
        circle.setAttribute("display", "none");
        return;
      }
      const positionedNode = node as MapNode & { x?: number; y?: number; z?: number };
      if (![positionedNode.x, positionedNode.y, positionedNode.z].every((value) => typeof value === "number" && Number.isFinite(value))) {
        circle.setAttribute("display", "none");
        return;
      }
      const projected = (svgProjectionVector || (svgProjectionVector = new threeInstance.Vector3()))
        .set(positionedNode.x, positionedNode.y, positionedNode.z)
        .project(graph.camera());
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      const x = (projected.x + 1) * 0.5 * width;
      const y = (1 - projected.y) * 0.5 * height;
      const inViewport = projected.z >= -1 && projected.z <= 1 && x >= -24 && x <= width + 24 && y >= -24 && y <= height + 24;
      if (!inViewport) {
        circle.setAttribute("display", "none");
        return;
      }
      const radius = selected
        ? 8.5 + glowPhase * 0.8
        : (node.node_type === "project" || node.node_type === "tenant" ? 3.6 : 2.4) * ambientGlowSize;
      circle.setAttribute("display", "inline");
      circle.setAttribute("cx", x.toFixed(1));
      circle.setAttribute("cy", y.toFixed(1));
      circle.setAttribute("r", radius.toFixed(1));
      circle.setAttribute("fill", selected ? "#ffffff" : baseColorFor(node));
      circle.setAttribute("fill-opacity", selected ? "0.95" : svgAmbientOpacity.toFixed(2));
    };
    const updateSvgGlow = () => {
      if (!glowOverlay || !svgGlowGroup || !graph || !threeInstance) return;
      for (const node of svgGlowNodes) {
        const circle = svgGlowCircles.get(node.id);
        if (circle) setSvgCirclePosition(circle, node);
      }
      if (svgSelectedGlow) {
        const selectedNode = data.nodes.find((node) => node.id === selectedId);
        if (selectedNode) {
          setSvgCirclePosition(svgSelectedGlow, selectedNode, true);
        } else {
          svgSelectedGlow.setAttribute("display", "none");
        }
      }
    };
    const startSvgGlowLoop = () => {
      if (svgGlowLoopActive || !glowOverlay || !mapVisible || document.visibilityState !== "visible") return;
      svgGlowLoopActive = true;
      glowOverlay.removeAttribute("hidden");
      const frame = () => {
        if (!svgGlowLoopActive || !mapVisible || document.visibilityState !== "visible") {
          svgGlowLoopActive = false;
          return;
        }
        if (budgetedGlow) glowPhase = (Math.sin(Date.now() / 560) + 1) / 2;
        updateSvgGlow();
        glowFrame = scheduleFrame(frame);
      };
      glowFrame = scheduleFrame(frame);
    };
    const updateGlowAppearance = () => {
      if (budgetedGlow) return;
      for (const node of data.nodes) {
        const layers = glowLayers.get(node.id);
        if (!layers) continue;
        const selected = node.id === selectedId;
        const dimmed = Boolean(selectedId && !selected && !selectedRelatedIds.has(node.id));
        const color = selected ? "#ffffff" : dimmed ? "#6b879e" : baseColorFor(node);
        const pulse = selected ? 0.5 + glowPhase * 0.5 : 0.5;
        layers.core.material.color.set(color);
        layers.halo.material.color.set(color);
        layers.outer.material.color.set(color);
        layers.core.material.opacity = selected ? 1 : dimmed ? 0.58 : 0.88;
        layers.halo.material.opacity = selected ? 0.62 + pulse * 0.14 : dimmed ? 0.12 : Math.min(0.36, 0.2 * ambientGlowIntensity);
        layers.outer.material.opacity = selected ? 0.24 + pulse * 0.08 : dimmed ? 0.04 : Math.min(0.11, 0.06 * ambientGlowIntensity);
        const coreScale = selected ? 1.28 + pulse * 0.08 : dimmed ? 0.94 : 1;
        layers.core.scale.set(coreScale, coreScale, coreScale);
        const haloSize = layers.core.coreSize * (selected ? 11 + pulse * 0.5 : dimmed ? 4 : 5.4 * ambientGlowSize);
        const outerSize = layers.core.coreSize * (selected ? 18 + pulse * 0.8 : dimmed ? 6.2 : 8.5 * ambientGlowSize);
        layers.halo.scale.set(haloSize, haloSize, 1);
        layers.outer.scale.set(outerSize, outerSize, 1);
      }
    };
    const stopGlowTimer = () => {
      if (glowTimer !== null) window.clearInterval(glowTimer);
      glowTimer = null;
    };
    const startGlowTimer = () => {
      if (budgetedGlow || glowTimer !== null || !mapVisible || document.visibilityState !== "visible" || data.nodes.length === 0) return;
      glowTimer = window.setInterval(() => {
        glowPhase = (Math.sin(Date.now() / 560) + 1) / 2;
        updateGlowAppearance();
        graph?.nodeColor?.(colorFor);
        graph?.nodeVal?.(nodeValue);
      }, 180);
    };
    const setMapVisibility = (visible: boolean) => {
      if (disposed || mapVisible === visible) return;
      mapVisible = visible;
      if (visible) {
        graph?.resumeAnimation();
        startSvgGlowLoop();
        startGlowTimer();
      } else {
        graph?.pauseAnimation();
        svgGlowLoopActive = false;
        if (glowFrame !== null) {
          window.cancelAnimationFrame(glowFrame);
          frames.delete(glowFrame);
          glowFrame = null;
        }
        stopGlowTimer();
      }
    };
    const createGlowNodeObject = (node: MapNode, THREE: typeof import("three")) => {
      const coreSize = Math.max(1.1, Math.cbrt(nodeValue(node)) * 1.3);
      const coreMaterial = new THREE.MeshBasicMaterial({
        color: baseColorFor(node),
        transparent: true,
        opacity: 0.9,
        depthWrite: false
      });
      const core = new THREE.Mesh(new THREE.SphereGeometry(coreSize, budgetedGlow ? 8 : 18, budgetedGlow ? 8 : 18), coreMaterial);
      core.renderOrder = 2;
      const group = new THREE.Group();
      if (budgetedGlow) {
        group.add(core);
        return group;
      }
      if (!glowTexture) {
        const canvas = document.createElement("canvas");
        canvas.width = 128;
        canvas.height = 128;
        const context = canvas.getContext("2d");
        if (!context) return null;
        const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
        gradient.addColorStop(0, "rgba(255,255,255,.95)");
        gradient.addColorStop(0.18, "rgba(255,255,255,.58)");
        gradient.addColorStop(0.5, "rgba(255,255,255,.18)");
        gradient.addColorStop(1, "rgba(255,255,255,0)");
        context.fillStyle = gradient;
        context.fillRect(0, 0, 128, 128);
        glowTexture = new THREE.CanvasTexture(canvas);
      }
      const haloMaterial = new THREE.SpriteMaterial({
        map: glowTexture,
        color: baseColorFor(node),
        transparent: true,
        opacity: 0.1,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending
      });
      const outerMaterial = new THREE.SpriteMaterial({
        map: glowTexture,
        color: baseColorFor(node),
        transparent: true,
        opacity: 0.025,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending
      });
      const halo = new THREE.Sprite(haloMaterial);
      const outer = new THREE.Sprite(outerMaterial);
      halo.scale.set(coreSize * 3.1, coreSize * 3.1, 1);
      outer.scale.set(coreSize * 4.8, coreSize * 4.8, 1);
      outer.renderOrder = 0;
      halo.renderOrder = 1;
      group.add(outer, halo, core);
      glowLayers.set(node.id, {
        core: { scale: core.scale, material: coreMaterial, coreSize },
        halo: { scale: halo.scale, material: haloMaterial, coreSize },
        outer: { scale: outer.scale, material: outerMaterial, coreSize }
      });
      return group;
    };
    const sourceNodeFor = (link: GraphLink) => typeof link.source === "string"
      ? data.nodes.find((candidate) => candidate.id === link.source)
      : link.source;
    const traceAccent = () => ({ decision: "#63bdff", reason: "#ffb84d", evidence: "#43dcad", artifact: "#ecf8ff" })[activeTraceStep];
    const linkColorFor = (link: GraphLink) => {
      if (selectedId && isSelectedLink(link)) return traceAccent();
      const source = sourceNodeFor(link);
      return source
        ? baseColorFor(source)
        : link.inferred ? "rgba(145,190,220,.48)" : "rgba(120,180,220,.66)";
    };
    const linkWidthFor = (link: GraphLink) => selectedId && isSelectedLink(link)
      ? 1.8
      : isCrossProjectLink(link)
      ? 1.25
      : isTenantLink(link)
        ? 1.5
        : link.relation?.startsWith("project:")
          ? 0.4
          : link.relation?.startsWith("entity:")
            ? 0.7
            : link.relation?.startsWith("shared:")
              ? 0.55
              : link.relation?.startsWith("decision:") ? 0.9 : 0.55;
    const linkCurvatureFor = (link: GraphLink) => isCrossProjectLink(link) ? 0.28 : isTenantLink(link) ? 0.04 : link.relation?.startsWith("shared:") ? 0.06 : 0;
    const linkParticlesFor = (link: GraphLink) => isCrossProjectLink(link) ? 2 : 0;
    const linkVisible = (link: GraphLink) => visibleNode(link.source) && visibleNode(link.target) && (!selectedId || isSelectedLink(link));
    function visibleNode(item: string | MapNode) {
      const node = typeof item === "string" ? data.nodes.find((candidate) => candidate.id === item) : item;
      return Boolean(node && visible(node));
    }
    const visible = (node: MapNode) => {
      const normalizedQuery = query.trim().toLowerCase();
      if (!normalizedQuery) return true;
      return [node.id, node.label, node.project_id, node.owner_principal, node.decision_type, node.entity_type].filter(Boolean).some((value) => String(value).toLowerCase().includes(normalizedQuery));
    };
    const focusGraphNode = (nodeId: string) => {
      const node = data.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) return;
      if (!graph) {
        pendingFocusId = node.id;
        return;
      }
      hasFocusedNode = true;
      pendingFocusId = "";
      const focusIds = directRelatedNodeIdsFor(node.id);
      graph.zoomToFit(800, node.node_type === "project" ? 72 : 52, (candidate) => focusIds.has(candidate.id));
    };
    const updateGraph = () => {
      if (!graph) return;
      updateGlowAppearance();
      graph?.nodeColor?.(colorFor);
      graph?.nodeVal?.(nodeValue);
      graph?.nodeVisibility?.(visible);
      graph?.linkColor?.(linkColorFor);
      graph?.linkVisibility?.(linkVisible);
      graph?.linkWidth?.(linkWidthFor);
    };
    const centerGraph = (durationMs = 450) => {
      if (!graph) return false;
      graph.zoomToFit(durationMs, 32);
      later(() => {
        if (!graph) return;
        const positionedNodes = data.nodes as Array<MapNode & { x?: number; y?: number; z?: number }>;
        const placed = positionedNodes.filter((node) => [node.x, node.y, node.z].every((value) => typeof value === "number" && Number.isFinite(value)));
        if (placed.length === 0) return;
        const bounds = placed.reduce((acc, node) => ({
          minX: Math.min(acc.minX, node.x as number),
          maxX: Math.max(acc.maxX, node.x as number),
          minY: Math.min(acc.minY, node.y as number),
          maxY: Math.max(acc.maxY, node.y as number),
          minZ: Math.min(acc.minZ, node.z as number),
          maxZ: Math.max(acc.maxZ, node.z as number)
        }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity });
        const center = {
          x: (bounds.minX + bounds.maxX) / 2,
          y: (bounds.minY + bounds.maxY) / 2,
          z: (bounds.minZ + bounds.maxZ) / 2
        };
        if (!Object.values(center).every((value) => Number.isFinite(value))) return;
        const camera = graph.cameraPosition();
        graph.cameraPosition({ x: camera.x + center.x, y: camera.y + center.y, z: camera.z + center.z }, center, durationMs);
      }, Math.max(120, durationMs));
      return true;
    };
    let resizeTimer = 0;
    const resizeObserver = stage && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (!graph || !stage) return;
          graph.width(stage.clientWidth).height(stage.clientHeight);
          clearLater(resizeTimer);
          resizeTimer = later(() => centerGraph(350), 120);
        })
      : null;
    const supports3D = () => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) return false;
      const canvas = document.createElement("canvas");
      try {
        return Boolean(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
      } catch {
        return false;
      }
    };
    stage?.setAttribute("aria-busy", "true");
    if (!supports3D()) {
      redirectToList(mapText("fallbackTitle", "3D view is unavailable; the accessible list remains available"));
    } else if (stage) {
      (async () => {
        try {
          const [module, THREE] = await Promise.race([
            Promise.all([
              import("3d-force-graph"),
              import("three")
            ]),
            new Promise<never>((_, reject) => later(() => reject(new Error("3D library load timeout")), 15000))
          ]);
          if (disposed) return;
          const ForceGraph3D = module.default as unknown as new (element: HTMLElement) => GraphInstance;
          threeInstance = THREE;
          svgProjectionVector = new THREE.Vector3();
          graph = new ForceGraph3D(stage);
          graph.backgroundColor("#050a12")
            .showNavInfo(false)
            .nodeLabel((node: MapNode) => {
              if (denseGraph) return "";
              if (node.node_type === "tenant") return `${mapText("tenantRoot", "Tenant root")} · ${node.label}<br/>${node.member_count || 0} ${mapText("projectsLabel", "projects")} · ${node.reference_count || 0} ${mapText("memoriesLabel", "memories")}`;
              if (node.node_type === "project") return `${mapText("projectHub", "Project hub")} · ${node.label}<br/>${node.member_count || node.reference_count} ${mapText("membersLabel", "members")}`;
              if (node.node_type === "entity") return `${mapText("sharedConcept", "Shared concept")} · ${node.label}<br/>${node.reference_count} ${mapText("memoriesLabel", "memories")}`;
              if (node.node_type === "decision") return `${mapText("decisionKind", "Decision")} · ${node.label}<br/>${node.confirmation_state || mapText("notSet", "unconfirmed")}`;
              return `${node.label}<br/>${node.owner_principal || mapText("noAssignment", "Unassigned")} · ${node.reference_count} ${mapText("refsLabel", "refs")}`;
            })
            .nodeThreeObject((node: MapNode) => createGlowNodeObject(node, THREE))
            .nodeThreeObjectExtend(false)
            .nodeVal(nodeValue)
            .nodeColor(colorFor)
            .nodeOpacity(0.92)
            .linkColor(linkColorFor)
            .linkVisibility(linkVisible)
            .linkWidth(linkWidthFor)
            .linkCurvature(linkCurvatureFor)
            .linkOpacity(denseGraph ? 0.42 : 0.6)
            .linkDirectionalArrowLength((link: GraphLink) => link.directed === false ? 0 : 2.4)
            .linkDirectionalArrowRelPos(1)
            .linkDirectionalParticles(denseGraph ? (() => 0) : linkParticlesFor)
            .linkDirectionalParticleSpeed(denseGraph ? 0 : 0.012)
            .linkDirectionalParticleWidth(denseGraph ? 0 : 1.3)
            .linkDirectionalParticleColor(linkColorFor)
            .onNodeClick((node: MapNode) => selectNode(node.id))
            .onBackgroundClick(() => selectNode(null))
            .graphData({ nodes: data.nodes, links: data.links });
          if (denseGraph) {
            graph.enablePointerInteraction?.(false);
            if (renderStatus) renderStatus.textContent = mapText("denseMapHint", "High-density mode: use the accessible list to select nodes.");
          }
          updateGlowAppearance();
          graph.width(stage.clientWidth).height(stage.clientHeight);
          graph.d3Force("charge")?.strength?.(-65);
          later(() => {
            if (pendingFocusId) return;
            if (!hasFocusedNode) centerGraph(650);
          }, 900);
          later(() => {
            if (pendingFocusId) return;
            if (!hasFocusedNode) centerGraph(500);
          }, 2400);
          if (pendingFocusId) {
            const pendingNode = data.nodes.find((node) => node.id === pendingFocusId);
            if (pendingNode) later(() => focusGraphNode(pendingNode.id), 1100);
          }
          stage.hidden = false;
          stage.setAttribute("aria-busy", "false");
          if (renderStatus) renderStatus.textContent = "";
          if (fallback) fallback.hidden = true;
          if (!mapVisible) graph.pauseAnimation();
          else { startSvgGlowLoop(); startGlowTimer(); }
          resizeObserver?.observe(stage);
          stage.querySelector("canvas")?.addEventListener("webglcontextlost", () => {
            fail(mapText("fallbackTitle", "3D view is unavailable; the accessible list remains available"));
          }, { once: true, signal: events.signal });
          later(() => {
            const canvas = stage.querySelector("canvas");
            const bounds = stage.getBoundingClientRect();
            if (!canvas || canvas.width < 2 || canvas.height < 2 || bounds.width < 10 || bounds.height < 10) {
              fail(mapText("mapRenderFallback", "The 3D view could not be rendered, so the list is shown."));
            }
          }, 2500);
          startGlowTimer();
        } catch (error) {
          if (disposed) return;
          console.error("MemoryMap3D initialization failed", error);
          fail(mapText("mapRenderFallback", "The 3D view could not be rendered, so the list is shown."));
        }
      })();
    }
    function fail(reason: string) {
      dispose();
      redirectToList(reason);
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      events.abort();
      resizeObserver?.disconnect();
      stopGlowTimer();
      svgGlowLoopActive = false;
      for (const id of timeouts) window.clearTimeout(id);
      for (const id of frames) window.cancelAnimationFrame(id);
      graph?._destructor();
      graph = null;
      stage?.replaceChildren();
      glowTexture?.dispose();
      glowLayers.clear();
      svgGlowGroup?.replaceChildren();
    }
    const update = (input: MemoryMapRenderInput) => {
      ({ selectedId, selectedRelatedIds, activeTraceStep, preset, query } = input);
      updateGraph();
    };
    return { update, focus: focusGraphNode, fit: centerGraph, setVisible: setMapVisibility, dispose };
}
