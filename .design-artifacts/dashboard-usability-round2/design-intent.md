# Design Intent — 15-point usability remediation

## Business Goal

Raise the dashboard from an attractive exploratory surface to a trustworthy operational instrument. Users must know the active scope, whether the data can support a decision, why an item is shown, and where each action leads.

## Target User

Any organization member without knowledge of Org Brain internal vocabulary.

## Primary User Action

Confirm the current scope and data state, identify one evidence-backed review candidate, then open its authoritative Task, Memory, Decision, Resource, or review detail.

## Desired Impression

Keep the living-system feeling: near-black depth, glass navigation, blue signal paths, node glow, and strata. Add precision through compact scope/status rails, explicit provenance, and plain-language state explanations.

## Information Priority

1. Scope and whether a judgment is currently possible.
2. Evidence-backed review candidate and destination.
3. Animated topology, graph, or timeline for exploration.
4. Technical metadata and complete lists.

## Content Constraints

- Do not change dashboard/v1 public contracts or routes.
- Never render a healthy or empty conclusion when initial data retrieval failed.
- Distinguish zero from missing data and current activity from period observation.
- Preserve tenant, project, language, period, and selection parameters.

## Must Avoid

- New KPI-card grids.
- Hidden scope rules or silent deep-link fallbacks.
- Self-link CTAs that appear to perform work.
- Overlays that cover topology entities.
- English lifecycle terms as primary Japanese labels.
