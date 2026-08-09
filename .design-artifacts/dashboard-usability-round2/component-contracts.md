# Component Contracts — remediation round 2

## InsightScopeRail

Purpose: expose tenant, project, active window/depth, included/excluded records, and data state before any conclusion.

States: ready, empty, partial, stale, error. Error text must state that a decision cannot be made.

Responsive: four-column rail on desktop; one column below 720px.

Accessibility: semantic region and definition list; status text does not rely on color.

## ActivityPeriodComparison

Purpose: compare a wider selected period with its 24-hour baseline using event and agent counts plus newly observed agent names.

Do not: infer a trend when only one window was fetched.

## AgentProvenance

Purpose: distinguish currently executing work from an agent merely observed during the selected period. Show last seen time and observed event kinds.

## GraphRelationshipLabels

Purpose: label selected-node edges with relation and direction while keeping the full relationship list authoritative.

## ReviewStateSummary

Purpose: derive Mission briefing, history overview, and attention count from one deterministic action set.

## DataUnavailableState

Purpose: replace healthy/empty conclusions when initial data retrieval fails. Existing route alert may remain, but the surface must say “judgment unavailable,” not “nothing requires attention.”

## MobilePrimaryNavigation

Purpose: keep the brand and current section visible while moving the full primary navigation into one disclosure below 720px.
