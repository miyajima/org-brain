# Org Brain dashboard usability design QA

## Comparison target

- Source visual truth:
  - Activity: `/Users/miyajimakazuhiro/.codex/visualizations/2026/08/08/019fdfec-c427-7c02-9f33-94e55fc95fe7/org-brain-dashboard-audit/01-overview.png`
  - Knowledge connections: `/Users/miyajimakazuhiro/.codex/visualizations/2026/08/08/019fdfec-c427-7c02-9f33-94e55fc95fe7/org-brain-dashboard-audit/02-constellation.png`
  - Knowledge history: `/Users/miyajimakazuhiro/.codex/visualizations/2026/08/08/019fdfec-c427-7c02-9f33-94e55fc95fe7/org-brain-dashboard-audit/03-strata.png`
- Browser-rendered implementation screenshots:
  - `/Users/miyajimakazuhiro/.codex/visualizations/2026/08/08/019fdfec-c427-7c02-9f33-94e55fc95fe7/dashboard-usability-qa/01-activity-desktop.png`
  - `/Users/miyajimakazuhiro/.codex/visualizations/2026/08/08/019fdfec-c427-7c02-9f33-94e55fc95fe7/dashboard-usability-qa/02-connections-desktop.png`
  - `/Users/miyajimakazuhiro/.codex/visualizations/2026/08/08/019fdfec-c427-7c02-9f33-94e55fc95fe7/dashboard-usability-qa/03-history-desktop.png`
  - `/Users/miyajimakazuhiro/.codex/visualizations/2026/08/08/019fdfec-c427-7c02-9f33-94e55fc95fe7/dashboard-usability-qa/01-activity-mobile.png`
  - `/Users/miyajimakazuhiro/.codex/visualizations/2026/08/08/019fdfec-c427-7c02-9f33-94e55fc95fe7/dashboard-usability-qa/02-connections-mobile.png`
  - `/Users/miyajimakazuhiro/.codex/visualizations/2026/08/08/019fdfec-c427-7c02-9f33-94e55fc95fe7/dashboard-usability-qa/03-history-mobile.png`
- Normalized side-by-side evidence, source on the left and implementation on the right:
  - `/Users/miyajimakazuhiro/.codex/visualizations/2026/08/08/019fdfec-c427-7c02-9f33-94e55fc95fe7/dashboard-usability-qa/comparison-activity.png`
  - `/Users/miyajimakazuhiro/.codex/visualizations/2026/08/08/019fdfec-c427-7c02-9f33-94e55fc95fe7/dashboard-usability-qa/comparison-connections.png`
  - `/Users/miyajimakazuhiro/.codex/visualizations/2026/08/08/019fdfec-c427-7c02-9f33-94e55fc95fe7/dashboard-usability-qa/comparison-history.png`
  - `/Users/miyajimakazuhiro/.codex/visualizations/2026/08/08/019fdfec-c427-7c02-9f33-94e55fc95fe7/dashboard-usability-qa/comparison-mobile.png`
- State: `INSIGHTS_UI_MODE=on`, Japanese locale, `default/org-brain` mock data, dark theme, default selection.
- Desktop viewport and pixels: 1440 × 1024 CSS px and 1440 × 1024 screenshot px. Comparison captures were normalized to 1280 × 1234 px per side; the taller source screenshots were top-cropped without scaling.
- Mobile viewport and pixels: 390 × 844 CSS px and 390 × 844 screenshot px.
- Density normalization: the in-app Browser screenshot output is CSS-pixel normalized; no density resampling was required.

## Findings

- No actionable P0, P1, or P2 differences remain.
- The added guide and mission briefing intentionally move each visualization downward, but the focal visualization still starts within the desktop viewport and remains the dominant visual region. This is an accepted product change, not unintended drift.

## Required fidelity surfaces

- Fonts and typography: the existing Inter/system and Fira Code hierarchy is retained. New guide and briefing labels use the existing monospace accent. Body, heading, and metadata weights remain consistent; clipped graph labels were removed by fitting the sparse graph to its viewport.
- Spacing and layout rhythm: existing 32 px desktop page margins, glass navigation, card radii, thin borders, and dark surface spacing are retained. The action rail is compact when only one action exists. Desktop graph proportions are approximately two-thirds graph and one-third inspector.
- Colors and visual tokens: the existing navy/black surfaces, blue glow, cyan labels, amber warnings, and red critical state remain. Representative measured contrast ratios were 18.46:1 for headings, 6.86:1 for muted body text, 11.49:1 for action reasons, 9.22:1 for history summary notes, and 7.38:1 for timeline metadata.
- Image quality and asset fidelity: the existing Org Brain brand mark is retained at native clarity. The focal topology, graph, and timeline are code-native product visualizations already present in the source implementation; no reference image or product asset was replaced.
- Copy and content: page names and guidance are plain Japanese while original technical names remain as eyebrows or folded technical details. Empty states do not claim that a nonexistent selection is healthy. CTAs name their actual destination.
- Responsiveness and accessibility: 390, 720 (200% zoom proxy), 768, 1280, and 1440 px checks showed no page-level horizontal overflow. Mobile navigation wraps without clipping. Graph nodes, timeline events, and strata items are keyboard reachable; Enter selection was verified for graph nodes. Reduced-motion behavior keeps static glow, line, and label meaning while continuous animation rules remain under `prefers-reduced-motion: no-preference`.

## Full-view comparison evidence

- Activity: the topology, path glow, central Org Brain mark, event detail, and timeline retain the original brand. The new guide and single-row briefing establish use and next action before the topology.
- Knowledge connections: the original constellation aesthetic remains, while the implementation reduces the oversized introductory area, keeps the graph fully within its column, and exposes plain-language metrics in the inspector.
- Knowledge history: the colored strata and current-time line remain. The implementation adds a compact current-state summary and moves raw status, snapshot, and validity fields behind technical-detail disclosures.
- Mobile: the three-screen contact sheet confirms readable headings, full navigation labels, guide stacking, and zero horizontal overflow at 390 px.

## Focused-region comparison evidence

- Mission briefing: verified one-action, healthy, critical, empty, and truncated-history states. The single action uses the full rail width and links directly to the named Task destination.
- Knowledge graph: verified selected-node 1.08 scale, blue glow, highlighted related edges, 2/3–1/3 desktop split, fitted sparse canvas, and equivalent relation list.
- History timeline: verified first and last cards are clamped inside the track, plain-language state labels, current marker, selected lineage animation, and folded technical metadata.
- Mobile navigation: verified all four main destinations and Management are visible without hidden horizontal scrolling.

## Primary interactions and console check

- Keyboard-selected a graph node with Enter and confirmed the selected deep link, glow/scale state, and highlighted edges.
- Opened and closed the history technical-details disclosure and confirmed validity fields appear only when expanded.
- Verified `Taskを確認` resolves to `/tasks/task-failed` with tenant, project, and language scope preserved.
- Verified empty knowledge/history briefings and truncated-history review candidates.
- Browser console warnings/errors on the three final desktop captures: none.

## Comparison history

- Iteration 1 findings:
  - [P2] A single recommended action occupied only one third of a wide rail, leaving a large empty region.
  - [P2] The earliest history card was clipped against the left edge of the timeline.
  - [P2] Mobile navigation hid part of `Task一覧` behind a horizontal scroller.
  - [P2] Timeline metadata was too small and low contrast.
- Fixes made:
  - Added action-count-aware rail layouts and a compact single-action row.
  - Clamped timeline card positions and aligned selected lineage paths to the clamped coordinates.
  - Replaced hidden horizontal navigation scrolling with an explicit wrapped layout.
  - Increased timeline metadata size and contrast; representative contrast now measures 7.38:1.
- Post-fix evidence:
  - The normalized desktop comparison images and final mobile contact sheet listed above show the corrected layouts.
  - Browser measurements report no horizontal overflow at all tested widths.
  - No actionable P0/P1/P2 issue was found in the post-fix comparison.

## Follow-up polish

- [P3] A future content pass could shorten the longest Japanese guide sentences on mobile, but current wrapping is readable and does not clip.

final result: passed
