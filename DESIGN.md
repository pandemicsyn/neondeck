---
name: neondeck Dashboard
description: A flat, dense, dual-theme cockpit for a 2560x720 companion display.
colors:
  bg: '#0c0d12'
  canvas: '#0a0b10'
  panel: '#0a0b10'
  field: '#070810'
  line: '#ffffff12'
  ink: '#d7f7ff'
  muted: '#d7f7ff80'
  primary: '#00b7c7'
  primary-strong: '#69e6ff'
  primary-ink: '#070810'
  accent: '#ff4fb8'
  violet: '#8b4dff'
  bg-light: '#edf5f8'
  field-light: '#dbeaef'
  ink-light: '#19232e'
  primary-light: '#0093a8'
  accent-light: '#d8248d'
typography:
  display:
    fontFamily: 'Chakra Petch, sans-serif'
    fontSize: '16px'
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: '0'
  title:
    fontFamily: 'IBM Plex Mono, monospace'
    fontSize: '11px'
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: '0.08em'
  body:
    fontFamily: 'IBM Plex Sans, system-ui, sans-serif'
    fontSize: '13px'
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: '0'
  label:
    fontFamily: 'IBM Plex Mono, monospace'
    fontSize: '10px'
    fontWeight: 500
    lineHeight: 1
    letterSpacing: '0.05em'
  code:
    fontFamily: 'IBM Plex Mono, monospace'
    fontSize: '11.5px'
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: '0'
rounded:
  none: '0'
spacing:
  row-x: '16px'
  row-y: '10px'
  chat-x: '20px'
  chat-y: '16px'
  chat-gap: '14px'
components:
  button:
    backgroundColor: '{colors.line}'
    textColor: '{colors.ink}'
    rounded: '{rounded.none}'
    padding: '6px 12px'
  button-hover:
    textColor: '{colors.primary}'
  panel:
    backgroundColor: '{colors.panel}'
    textColor: '{colors.ink}'
    rounded: '{rounded.none}'
  panel-header:
    textColor: '{colors.primary-strong}'
    typography: '{typography.title}'
    height: '36px'
  badge:
    backgroundColor: '{colors.line}'
    textColor: '{colors.muted}'
    rounded: '{rounded.none}'
    padding: '2px 6px'
  chat-message-user:
    backgroundColor: '#69e6ff1f'
    textColor: '{colors.ink}'
    rounded: '{rounded.none}'
    padding: '8px 12px'
  chat-message-assistant:
    backgroundColor: '#ffffff0a'
    textColor: '{colors.ink}'
    rounded: '{rounded.none}'
    padding: '9px 13px'
---

# Design System: neondeck Dashboard

## 1. Overview

**Creative North Star: "The Lit Cockpit"**

neondeck's dashboard is the instrument cluster of a developer's workstation: a 2560x720 strip of glass that sits beside the main monitor and stays lit all day. Every decision serves glanceability. Surfaces are flat and seamless, panels butt against each other with single-pixel hairlines instead of floating cards, and the type is dense, monospaced at the structural seams and humanist in the prose. The palette is a restrained Miami-at-night gradient — teal-cyan as the working voice, with pink and violet held in reserve as wash and signal — laid over near-black so the screen recedes into the bezel rather than competing with the primary display.

This system explicitly rejects the decorative SaaS dashboard: no oversized marketing cards, no ornamental gradients on content, no rounded-corner tile grids with drop shadows. It equally rejects the gamer/RGB sensor-panel aesthetic — no faux-hardware gauges, no rainbow telemetry — and the raw terminal dump that makes structured work harder to scan. The agent half (Flue chat) and the deterministic half (PRs, host metrics, runtime) live on the same surface but read as different materials: data is fast and tabular, conversation is calm and readable.

Density is configurable (compact / default / large) and theme is dual (a near-black dark and a cool-paper light), but the identity never changes: flat, hairline-ruled, mono-labelled, calm enough to leave running.

**Key Characteristics:**

- Zero border-radius. Every surface is a true rectangle.
- Hairline structure: 1px borders carry all separation; no shadows, no cards.
- Mono at the seams (panel headers, status line, labels), humanist sans for prose.
- Teal-cyan does the work; pink and violet are rare signal and wash.
- Density and theme are tokens, not redesigns.

## 2. Colors

A near-black cockpit lit by a teal-to-violet Miami wash, mirrored by a cool-paper light theme for daytime ambient light. Both themes must hit WCAG AA.

### Primary

- **Signal Cyan** (`#69e6ff`, light `#0093a8`): the brightest working color. Status-line values, panel-header titles, active markdown headings, links, focus rings. The voice of "this is live data."
- **Deck Teal** (`#00b7c7`, light `#0093a8`): the calmer primary. Borders on hover, the assistant-message left rule, secondary status text. Where cyan shouts, teal speaks.

### Secondary

- **Hot Pink** (`#ff4fb8`, light `#d8248d`): the signal accent and `--destructive`. The brand diamond, GitHub-panel wash, selection background, error/attention states. Used on a tiny fraction of any screen — its rarity is the alarm.

### Tertiary

- **Runtime Violet** (`#8b4dff`, light `#7044d8`): the third Miami stripe. Workflow chips, the runtime-panel wash, the diagonal background gradient's deep band. Marks agent/runtime work as distinct from deterministic data.

### Neutral

- **Near-Black Canvas** (`#0a0b10` / `#0c0d12`, light `#edf5f8`): the body and panel fill. So dark the screen disappears into the Xeneon bezel.
- **Field** (`#070810`, light `#dbeaef`): inputs, code blocks, sunken surfaces — one step darker than canvas in dark, one step bluer in light.
- **Ink** (`#d7f7ff`, light `#19232e`): primary text. A faintly cyan-tinted off-white, never pure `#fff`.
- **Muted** (`#d7f7ff` at 50%, light `#16202a` at 62%): secondary text, captions, placeholders. Verified ≥4.5:1 on canvas.
- **Line** (`#ffffff` at 7%, light `#142d3c` at 13%): the universal hairline. Three weaker steps (`line2`/`line3`) for nested rules.

### Named Rules

**The Reserve Rule.** Pink and violet together never exceed ~10% of any panel. They are wash, signal, and rare emphasis — never a content fill. The moment two panels are both pink-washed, the cockpit has become a toy.

**The Tinted-Ink Rule.** Text is never pure white or pure black. Dark-theme ink carries a cyan tint (`#d7f7ff`); light-theme ink is a deep slate (`#19232e`). The tint ties text to the Miami palette without costing contrast.

## 3. Typography

**Display Font:** Chakra Petch (sans-serif) — angular, technical, slightly squared. The brand voice.
**Body Font:** IBM Plex Sans (with system-ui fallback) — humanist, legible at small sizes.
**Label/Mono Font:** IBM Plex Mono — every structural seam and every number.

**Character:** A three-font system that splits by job, not by decoration: Chakra Petch for identity, Plex Sans for reading, Plex Mono for structure and figures. Sizes are deliberately small (10–13px base) because the user sits close to a short, wide panel and density beats generosity here.

### Hierarchy

- **Display** (Chakra Petch 600, ~16px, 1.2): the brand wordmark and a small number of marquee labels. Rare; this is a dashboard, not a landing page.
- **Title** (Plex Mono 600, 11px, 0.08em tracking): panel headers and the status line. Uppercase-feeling through tracking, not `text-transform`.
- **Body** (Plex Sans 400, 13px, 1.55): chat prose and list content. Chat bubbles capped at `min(82%, 74ch)`.
- **Label** (Plex Mono 500, 10px, 0.05em): badges, kbd hints, micro-captions.
- **Code** (Plex Mono 400, 11.5px, 1.55): code blocks inside chat; `pre` keeps `white-space: pre` and scrolls horizontally.

### Named Rules

**The Mono-Seam Rule.** Anything structural — panel headers, the powerline status bar, badges, numbers — is IBM Plex Mono. Prose is IBM Plex Sans. The font _is_ the signal for "chrome vs content," so never set a panel header in the sans.

**The Tabular-Numbers Rule.** Status values use `font-variant-numeric: tabular-nums` so live-updating figures don't reflow. Always.

## 4. Elevation

The dashboard is **flat by doctrine — there are no shadows**. `.panel` explicitly sets `box-shadow: none` and `border-radius: 0`. Depth is conveyed by tonal layering and hairlines only: canvas → panel → field steps darker, and 1px `--line` rules (with three weaker variants) divide everything. The single concession to glow is functional, not decorative — the brand diamond and a few signal marks carry a tight `box-shadow: 0 0 8px <color>` to read as "lit," and the focus ring is a 1px solid `--ring`.

### Named Rules

**The No-Card Rule.** Surfaces never float. If something needs separation, it gets a hairline border or a tonal step, never a shadow and never a radius. Nested cards are forbidden outright.

**The Lit-Not-Raised Rule.** The only glow allowed is a small color-matched halo on signal marks (the diamond, a status dot). Glow signals "live," it never signals "elevated."

## 5. Components

### Buttons

- **Shape:** hard rectangle (0 radius).
- **Default:** `bg-soft` fill, 1px `--line` border, `--ink` text, mono-medium, `6px 12px` padding.
- **Hover / Focus:** border and text shift to `--primary`; focus shows a 1px `--primary` ring (`focus:ring-1`), never an outline glow.
- **Disabled:** 45% opacity, `not-allowed` cursor.

### Badges / Chips

- **Style:** 1px `--line` border on `bg-soft`, mono 10px, `--muted` text, tight `2px 6px` padding, 0 radius.
- **Workflow chip (signature):** violet variant — `rgba(139,77,255,0.1)` fill, `rgba(139,77,255,0.28)` border, `--violet` text — marks agent workflow events.

### Panels / Containers

- **Corner Style:** square (0 radius), no shadow.
- **Background:** `--panel` over `--deck-bg`; GitHub/chat/runtime panels add a faint top-edge wash in pink/teal/violet respectively (`linear-gradient(180deg, rgba(...,0.04), transparent ~38%)`).
- **Header:** 36px tall, `--deck-chrome` at 86%, mono 11px / 0.08em, `--primary-strong` text.
- **Border:** hairline `--deck-line` between every panel.

### Inputs / Fields

- **Style:** borderless `Textarea` on transparent or `--field` background; the enclosing form row carries the border.
- **Placeholder:** `--deck-faint` (light enough to read as hint, still AA on field).
- **Focus:** handled at the container, 1px `--ring`; no glow.

### Status Line (signature: the powerline)

- A single 34px (compact 30 / large 38) horizontal bar, mono 12px, hairline bottom border, `--deck-chrome` fill. Segments are pipe-separated with `--deck-div` separators; the leftmost **brand segment** carries a pink-washed `brand-mark` diamond with a tight halo. Values use tabular-nums and ellipsize at `max-width: 15rem`.

### Chat Messages (signature)

- **User:** right-aligned, cyan-tinted fill (`--deck-user-bg`), 1px cyan border, capped at `min(82%, 74ch)`.
- **Assistant:** left-aligned, faint fill, 1px border with a 2px **teal left rule** (the one intentional accent stripe in the system — the assistant's "speaking" mark).
- Markdown headings render in mono `--primary-strong`; inline code in `--field` with cyan text; links underlined with a translucent teal decoration.

## 6. Do's and Don'ts

### Do:

- **Do** keep every corner square (`border-radius: 0`) and every surface flat (`box-shadow: none`). Separation is hairlines and tonal steps.
- **Do** set all structural chrome — headers, status line, badges, numbers — in IBM Plex Mono, and all prose in IBM Plex Sans.
- **Do** keep pink and violet under ~10% of a panel; let Signal Cyan and Deck Teal carry the working surface.
- **Do** use `font-variant-numeric: tabular-nums` on any live-updating figure.
- **Do** verify both themes at AA, and honor the existing `prefers-reduced-motion` block (animations clamp to 1ms) and visible focus rings.
- **Do** respect the density tokens (`--deck-*`) so compact/default/large stay consistent; size with the scale, don't hardcode.

### Don't:

- **Don't** use decorative SaaS dashboard styling: no oversized marketing cards, no rounded tile grids, no ornamental gradients on content.
- **Don't** use gamer/RGB sensor-panel styling: no faux gauges, no rainbow telemetry, no glowing bezels.
- **Don't** ship raw terminal screens that dump unstructured text where a scannable table or list belongs.
- **Don't** add shadows or radii to "lift" a panel. The only glow allowed is a small color-matched halo on a signal mark.
- **Don't** introduce a fourth typeface or set a panel header in the sans — the font is the chrome/content signal.
- **Don't** use a colored `border-left` wider than the single intentional 2px teal assistant rule as a decorative accent elsewhere.
- **Don't** use pure `#fff` or `#000` for text; ink is tinted (`#d7f7ff` dark / `#19232e` light).
