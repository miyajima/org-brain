<!-- task: Org Brain 3-view insight dashboard -->

# Component Contracts

## NervousSystem

Purpose: Render a truthful, refreshable view of observed organizational activity.

Content: Observed agent lanes, central memory functions, project/task outcomes, attention signals, selected event, and time window.

Props / Inputs: `ActivityResponse`, tenant/project/lang scope, initial feature mode.

States: loading, current, stale/backing-off, partial warning, empty, hard error, selected event.

Responsive behavior: three-column flow at wide sizes; ordered cards plus timeline at narrow sizes.

Accessibility: all events and attention items are buttons or links; connections are decorative; refresh announcements are polite and manual/error only.

Interaction: 30s visible-tab polling with cursor, abort overlap, exponential backoff capped at 5m, retain last-good data, manual refresh and selection.

Do Not: expose sensitive event payloads, label observed identity as live presence, or blank the page after a poll error.

## KnowledgeConstellation

Purpose: Render a bounded, deterministic graph of recorded knowledge relations.

Content: Typed nodes/edges, project clusters, selection inspector, query/depth controls, truncation notice, equivalent relationship list.

Props / Inputs: `KnowledgeGraphResponse`, focus query state, tenant/project/lang scope.

States: loading, focused, no-focus, empty, truncated, focus-not-readable, error.

Responsive behavior: graph plus sticky inspector on desktop; graph, inspector, and list stacked on mobile.

Accessibility: node controls use native buttons, visible labels and shapes; Enter/Space select; SVG edges are `aria-hidden`; fallback list contains the same relations.

Interaction: selection writes `focus_type`/`focus_id` to the URL and reloads the bounded neighborhood; inspector deep-links to existing authoritative screens.

Do Not: calculate new semantic relations, use force simulation, hide omitted counts, or encode type only by color.

## MemoryStrata

Purpose: Show provenance and revision history behind current knowledge.

Content: Canonical, Decision, Learning, Assumption, Source lanes; revisions, links, validity, status, confirmations, diffs, and truncation.

Props / Inputs: `StrataCollectionResponse` plus lazy `StrataDetailResponse`, tenant/project/lang scope.

States: loading, empty, sparse, dense, partial revision, truncated, selected chain, error.

Responsive behavior: horizontal time lanes on desktop; chronological vertical timeline below 760px.

Accessibility: lane headings precede list semantics, connections are decorative, selected revision is programmatically indicated, dates include machine-readable values.

Interaction: filters and selection persist in URL; selecting an item loads bounded detail and exposes links to Decisions, Memories, or Resources.

Do Not: infer assumptions from confidence alone, return raw snapshots, or compress the desktop lane layout until text becomes unreadable.
