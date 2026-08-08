<!-- task: Org Brain 3-view insight dashboard -->

# Design Intent

## Business Goal

Turn Org Brain's existing memory, decision, task, and provenance records into an operational cockpit: users should immediately see what the organization is learning, where attention is required, and how current knowledge came to be.

## Target User

Engineering leads, operators, and AI-agent users who already use the Memory Explorer, Decision Editor, and Tasks screens.

## Primary User Action

Select an observed event, knowledge node, or historical stratum and follow its deep link to the existing source-of-truth screen.

## Desired Impression

An organizational instrument panel rather than a generic SaaS dashboard: black/navy depth, precise electric-blue signals, restrained glow only where live or selected data needs emphasis, and dense but legible information.

## Information Priority

1. Attention signals and the currently selected record.
2. Relationship, lineage, and temporal context around that record.
3. Secondary counts, filters, freshness, and management navigation.

## Primary CTA

Open the selected Task, Memory, Decision, or Resource in its existing authoritative view.

## Secondary CTA

Change project/focus/window, switch between visualization and accessible list, or manually refresh activity.

## Content Constraints

Render only records returned by the API after ACL filtering. Never substitute demo nodes or synthetic events for empty data. Do not expose task payloads, search text, message bodies, memory bodies, or principals in logs.

## Brand / Tone Notes

Match the supplied Knowledge Constellation, Organizational Nervous System, and Memory Strata references. Use Japanese/English/Chinese through the existing locale pattern. System font only; blue is the primary accent, amber/red are reserved for warning/critical semantics.

## Must Avoid

- Generic KPI-card grids as the dominant composition.
- Decorative glow, gradients, animation, or connector lines that do not encode data.
- Invented semantic edges, agent presence, assumptions, or project metadata.
- Color-only meaning, inaccessible canvas-only controls, and horizontal mobile shrink-to-fit.
