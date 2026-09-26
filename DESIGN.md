---
name: Base Power Zeus
description: An evidence-first ranking instrument for Base Power outreach in Texas, built on Base's own design tokens.
colors:
  # Neutrals: Base's warm greys (basepowercompany.com tokens --color-grey-*)
  canvas: "#f0eeeb"
  surface: "#ffffff"
  surface-sunken: "#e6e4e0"
  divider: "#d8d7d5"
  control-border: "#7f7d7a"
  ink: "#292826"
  ink-muted: "#54524f"
  ink-disabled: "#a9a8a7"
  # Brand: Base greens
  brand: "#b2dd79"
  brand-subtle: "#d6f0b4"
  brand-strong: "#1e4d2b"
  brand-strong-hover: "#102a17"
  focus: "#048ee5"
  # Score ramp (sequential, choropleth + score bars), low -> high
  score-1: "#d6f0b4"
  score-2: "#b2dd79"
  score-3: "#77a45a"
  score-4: "#1e4d2b"
  score-5: "#102a17"
  # Signal categories (validated distinct under deutan/protan/tritan, min dE 39.6)
  signal-outage: "#bf5249"
  signal-grid: "#f7c33c"
  signal-grid-edge: "#aa8422"
  signal-install: "#06507e"
  signal-household: "#68baed"
  signal-household-edge: "#06507e"
  # States
  not-loaded-bg: "#e6e4e0"
  not-loaded-ink: "#54524f"
  stale-bg: "#fdf1d3"
  stale-ink: "#5e4507"
  error-bg: "#ffccc7"
  error-ink: "#c51808"
  excluded-fill: "#d8d7d5"
  # Dark theme
  dark-canvas: "#1b1a18"
  dark-surface: "#292826"
  dark-divider: "#54524f"
  dark-ink: "#f0eeeb"
  dark-ink-muted: "#a9a8a7"
  dark-brand: "#b2dd79"
typography:
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  heading:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.35
  figure:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  data:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: "4px"
  md: "12px"
  full: "9999px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  6: "24px"
  8: "32px"
  12: "48px"
components:
  button-primary:
    backgroundColor: "{colors.brand-strong}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.brand-strong-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
    height: "36px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "24px"
  chip-signal:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
  state-not-loaded:
    backgroundColor: "{colors.not-loaded-bg}"
    textColor: "{colors.not-loaded-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  badge-stale:
    backgroundColor: "{colors.stale-bg}"
    textColor: "{colors.stale-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  table-row-selected:
    backgroundColor: "{colors.brand-subtle}"
    textColor: "{colors.ink}"
---

# Design System: Base Power Zeus

## 1. Overview

**Creative North Star: "The audited instrument."** Zeus is Base Power's grid intelligence wearing Base's own clothes: the warm greys, forest and lime greens, gold and "grid off" red come straight from basepowercompany.com's token set (`--color-grey-*`, `--color-green-*`, `--color-grid-off`, `--color-brand-gold`). Where Base's marketing site is warm and persuasive, Zeus is calm and exact. It borrows the palette and the restraint, and drops the display type and the campaign energy.

Physical scene: an analyst at a desk in office daylight, and a bright hackathon hall where judges watch a projected laptop. Projectors wash out dark interfaces and thin grey text, so Zeus is **light by default**, with a dark theme for long desk sessions. Color strategy is **Restrained** for chrome (tinted neutrals, forest green only on primary actions and selection) and **Full palette** inside data (a green score ramp plus four named signal colors).

Layout is a product shell: a slim top bar (wordmark, county switcher, freshness summary, export), a content area that pairs the map with the ranked table, and detail that opens in place. Spacing follows a 4px grid. Tables are dense (36px rows) at the desk and scale with browser zoom for the projector. Motion is 150–250 ms, uses Base's ease-out `cubic-bezier(0, 0, .2, 1)`, and only ever signals a change of state: a re-rank, a drawer opening, a row landing in a new position.

## 2. Colors

Hex values are Base's own, extracted from the live site. Contrast was checked against WCAG 2.2.

### Primary
- **Forest** `brand-strong` #1e4d2b: primary buttons, selected tabs, links, the active slider track. It reaches 9.76:1 with white text.
- **Lime** `brand` #b2dd79: brand mark, active-selection fills, and the mid-high score step. It is a fill color only and never text on white (1.55:1). Forest text on lime reaches 6.28:1.

### Neutral
- **Canvas** #f0eeeb is the app background. **Surface** #ffffff is used for panels, tables and the map frame. **Ink** #292826 is for text (14.73:1 on white).
- **Ink muted** #54524f is for secondary text (7.79:1). Base's own muted grey #7f7d7a fails AA for text (4.10:1 on white, 3.54:1 on canvas), so it is used only as the **control border** (the 3:1 non-text minimum, met at 4.10:1).
- **Divider** #d8d7d5 is for hairlines between rows and panels. It is decorative, so it is never the only edge of an input.

### Tertiary: data colors
- **Score ramp**: #d6f0b4 → #b2dd79 → #77a45a → #1e4d2b → #102a17. A single hue with monotonic lightness, so it reads for every kind of color vision. It is used for the choropleth and score bars only.
- **Signals**:
  - outage exposure: Grid-off red #bf5249;
  - grid value: Gold #f7c33c, with a #aa8422 edge;
  - installability: Deep blue #06507e;
  - household fit: Sky #68baed, with a #06507e edge.

  The minimum pairwise ΔE is 39.6 under simulated deuteranopia, protanopia and tritanopia. Light fills always carry their edge color and a text label.

### Named Rules
**The Green Means Score Rule.** Green belongs to the ranking. Signals, states and chrome never use the score ramp, so a green cell always means "ranks higher".

**The Missing Is Grey Rule.** "Not loaded" (pipeline hasn't run) and "not available" (no public source, e.g. Harris permits) use `not-loaded-bg` and `not-loaded-ink` with a 45° hatch on maps. The reason is always written out. A missing value is never 0, blank, or a dash.

**The Neutral Report Card Rule.** Backtest and validation numbers are shown in ink on surface. Never green for good or red for bad.

## 3. Typography

**Family:** Geist for everything, and Geist Mono for tabular data (IDs, SHA-256s, coordinates, raw values). Numbers in Geist use `font-variant-numeric: tabular-nums` so columns align. Base's PP Neue Montreal and Clarendon Wide are licensed faces and are not used. Geist is the closest open neo-grotesque to Neue Montreal.

### Hierarchy
- **Title** (1.75rem/600): page title, one per page.
- **Heading** (1.25rem/600): panel titles.
- **Figure** (2.25rem/600, tabular): a headline value inside a sentence or panel, always followed by its unit in label size.
- **Body** (0.9375rem/400, 1.5): prose, capped at 70ch.
- **Label** (0.8125rem/500): controls, chips, table headers, units.
- **Data** (Geist Mono 0.8125rem): raw identifiers and hashes.

The scale uses a fixed rem ratio of about 1.2, not fluid type. `text-wrap: balance` applies to titles and headings.

### Named Rules
**The Unit Rule.** Every figure carries its unit: "customer-hours", "$/MWh", "per 1,000 homes", "days". A bare number is incomplete.

## 4. Elevation

The interface is flat at rest: panels sit on the canvas separated by surface color and one `divider` hairline. Only things that float get a shadow: popovers, the provenance popover, the detail drawer and toasts. They use Base's shadow `0 4px 12px #0000001a`. The z-index scale runs dropdown → sticky header → drawer backdrop → drawer → toast → tooltip.

## 5. Components

### Buttons
- Primary is forest, with a 4px radius and 36px height. Secondary is a white surface with a `control-border` edge.
- Focus is a 2px Base sky #048ee5 ring with a 2px offset. Disabled uses `ink-disabled` on `surface-sunken`. Loading keeps the button's width and swaps the label for a spinner.

### Chips (signals used)
- A pill with a 10px dot in the signal color, the signal name, and its weight when known.
- County- or zone-level signals get a label suffix ("same for all Travis homes"), because they cannot separate homes within a county.

### Cards / Containers
- A **panel** is a white surface with a 12px radius and 24px padding. Panels never nest.
- Stats never become a grid of identical cards. A headline figure lives inside a sentence ("Travis County homes averaged **4.2 customer-hours** without power in 2024") with its provenance link beside it.

### Inputs / Fields
- **Weight sliders:**
  - Each slider shows its label, its current weight as a percentage of the total, and a reset-to-equal action.
  - The track is `divider` and the fill is forest.
  - Changes re-rank the list live, and each row that moves shows its rank change (↑3, ↓2) for 2 s.
- **Text inputs** use a `control-border` edge and the same 36px height as buttons.

### Navigation
- The top bar holds the wordmark, the county switcher (Travis, Harris), the freshness summary (quiet unless something is stale) and Export.
- Routes are Overview, Ranking, a detail page per home, Segments and Sources.

### Signature component: Provenance popover
Every sourced number is a button styled as text with a dotted underline. Activating it opens a popover anchored to the number, using the native popover API so it is never clipped. It shows:
- the source dataset name and URL;
- the retrieval time;
- a truncated SHA-256 (full value on copy);
- the pipeline run ID and runner (cron or CLI);
- rows in and rows loaded.

A "View raw file" link goes to Storage. The full detail drawer is reserved for a home's whole record.

## 6. Do's and Don'ts

### Do:
- **Do** put the unit on every number, with tabular numerals throughout.
- **Do** make every sourced value open its provenance in one interaction.
- **Do** render "not loaded" and "not available" states with the reason written out, and a hatch on the map.
- **Do** pair every color signal with a text label or pattern. Color is never the only carrier of meaning.
- **Do** use a muted, low-chroma basemap so the choropleth carries the color.
- **Do** keep motion to 150–250 ms state transitions, with a `prefers-reduced-motion` fallback of instant changes.

### Don't:
- **Don't** use Base's #7f7d7a grey for text. It fails AA. Use #54524f.
- **Don't** put lime #b2dd79 text on white, or use it for anything that must be read.
- **Don't** use green for anything other than score.
- **Don't** build a hero-metric template (big number, small label, gradient accent) or a grid of identical stat cards.
- **Don't** use side-stripe borders, gradient text, glassmorphism, or small uppercase eyebrows over every panel.
- **Don't** show a 0, a blank or a dash where data is missing.
- **Don't** open a modal where an inline popover or an in-place expansion would do.
- **Don't** use Clarendon or any display face in UI labels, buttons or data.
