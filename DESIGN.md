# Org Brain Design System

This is the canonical UI design system for the repository.
It adapts the public Apple design language to an operator console for tasks, workflows, and memory inspection.

## 1. Visual Intent

- Calm authority over spectacle.
- Strong hierarchy with very few competing accents.
- Dark hero moments, light informational surfaces, and one chromatic accent.
- The interface should feel like a premium product console, not a generic admin dashboard.

## 2. Core Palette

- `--sk-black`: `#000000`
- `--sk-graphite`: `#1d1d1f`
- `--sk-gray`: `#f5f5f7`
- `--sk-white`: `#ffffff`
- `--sk-text`: `#1d1d1f`
- `--sk-text-muted`: `rgba(0, 0, 0, 0.72)`
- `--sk-link`: `#0066cc`
- `--sk-blue`: `#0071e3`
- `--sk-blue-bright`: `#2997ff`
- `--sk-divider`: `rgba(0, 0, 0, 0.08)`
- `--sk-divider-strong`: `rgba(0, 0, 0, 0.14)`
- `--sk-shadow`: `rgba(0, 0, 0, 0.22) 0 12px 30px`
- `--sk-focus`: `#0071e3`

Rules:

- Use black, near-black, white, gray, and one blue accent.
- Do not introduce decorative gradients, noise, textures, or extra brand colors.
- Use warning surfaces sparingly and keep them neutral.

## 3. Typography

- Use an Apple-like system stack: `-apple-system`, `BlinkMacSystemFont`, `"SF Pro Display"`, `"Helvetica Neue"`, `Helvetica`, `Arial`, `sans-serif`.
- Use the same family for display and body text; shift tone through size, weight, and letter-spacing.
- Keep text tight and deliberate. Negative tracking should appear at most sizes.

Suggested scale:

- Hero: `56px`, `600`, `line-height: 1.07`
- Section heading: `40px`, `600`, `line-height: 1.1`
- Card title: `21px`, `600` or `700`, `line-height: 1.19`
- Body: `17px`, `400`, `line-height: 1.47`
- Caption: `14px`, `400`, `line-height: 1.29`
- Micro: `12px`, `400`, `line-height: 1.33`

## 4. Shell and Navigation

- Navigation should be a compact translucent glass rail.
- Prefer a dark floating nav with blur and a visible active state.
- Keep the shell centered and restrained, with generous side padding.
- The global content width should stay around `1180px` for console work.

Navigation rules:

- Height should stay compact, around `48px`.
- Links should be understated and readable.
- Active state must remain visible on every routed page.
- Hover should brighten subtly, not animate aggressively.

## 5. Surface and Depth

- Cards should use soft lift, not hard borders.
- Border radius should cluster around `8px`, `11px`, and `18px`.
- Elevated surfaces should use a single diffused shadow.
- Flat sections should rely on contrast and spacing, not decoration.
- Sticky detail panels are allowed when they support single-screen comprehension.

## 6. Buttons and Controls

Primary button:

- Background: `--sk-blue`
- Text: `--sk-white`
- Radius: `8px`
- Padding: `8px 15px`
- Focus ring: `2px solid --sk-focus`

Secondary button:

- Background: `--sk-graphite`
- Text: `--sk-white`
- Radius: `8px`

Pill link:

- Background: transparent or near-transparent
- Text: `--sk-link` on light backgrounds, `--sk-blue-bright` on dark backgrounds
- Radius: `980px`

Filter and search controls:

- Height: at least `48px`
- Radius: `11px`
- Border: subtle and mostly neutral
- Inputs should feel immediate, not buried in chrome
- Inputs should never look browser-default; treat text fields as first-class surfaces.
- Use Tailwind CSS v4 in the console so the shared field treatment is consistent across pages.

## 7. Layout

- Use a clear first viewport: hero, command bar, metrics strip, workspace.
- Desktop workspace should be two-column when it improves scan speed.
- Mobile should collapse to a single column with content first, detail second.
- White space should separate scenes; do not overpack panels.

`/memories` guidance:

- Hero: concise title, one-line framing, and compact status chips.
- Command bar: dominant query input, visible tenant and project filters, secondary view switches.
- Search should surface recent memory context before the user types anything.
- Search should offer suggestion chips or autocomplete derived from actual memory/tag data.
- Metrics strip: visible rows, canonical rows, digest rows, compacted rows, durable count, recent count.
- Search results: rank, source, type, title, preview, created date, score.
- Profile: durable lane and recent lane should feel parallel but distinct.
- Maintenance: highlight structural change with counts and project footprint.
- Detail drawer: title, id, source, project, created date, score, external key, tags, preview, raw content.

## 8. Interaction and Motion

- Every interactive element needs visible hover and focus treatment.
- Use short transitions only: roughly `150-220ms`.
- Respect `prefers-reduced-motion`.
- Selected states must use at least two cues, such as background plus accent line.
- Touch targets should stay comfortably above `44x44`.

## 9. Accessibility

- Maintain AA contrast in light mode.
- Labels must be explicit.
- Keyboard order must follow visual order.
- The page must remain usable without hover.
- Long text should wrap into readable line lengths instead of spanning the viewport.

## 10. Do and Don't

Do:

- Use Apple Blue only for interactive emphasis.
- Keep card chrome light and sparse.
- Alternate dark hero surfaces with light content surfaces when a section needs drama.
- Use simple, sharp hierarchy for data-heavy views.

Don't:

- Don't add extra accent colors.
- Don't use heavy borders, glossy effects, or noisy textures.
- Don't rely on custom web fonts that fight the Apple language.
- Don't over-round rectangular surfaces beyond the pill system.
- Don't hide key filters or state behind drawers on desktop.

## 11. Canonical Usage

- `apps/console/src/layouts/BaseLayout.astro` should carry the shell tokens and global component defaults.
- Page-level views should layer on top of the same shell rather than inventing new visual languages.
- The `memories` surface is the strongest expression of this system and should be used as the reference implementation.
