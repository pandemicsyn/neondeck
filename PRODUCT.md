# Product

## Register

product

## Users

The primary user is a developer running neondeck on a Corsair Xeneon Edge as a dedicated companion display beside their main monitor. They are already in the middle of work and need a dense, glanceable surface for active pull requests, local host state, and ongoing agent conversations.

## Product Purpose

neondeck is a local dashboard and agent console for a 2560 x 720 companion display, with a project website at neondeck.dev. It should keep useful operational context visible without competing with the primary monitor, and it should make persistent Flue chat sessions available from the same surface.

## Brand Personality

Quiet, technical, focused. The interface should feel like a restrained cockpit: compact, legible, configurable, and calm enough to leave running all day.

## Anti-references

Avoid decorative SaaS dashboard styling, oversized marketing cards, ornamental gradients, gamer/RGB sensor-panel styling, and raw terminal screens that make structured work harder to scan.

## Design Principles

- Keep the display glanceable: prioritize compact hierarchy, strong labels, and stable panel positions.
- Separate deterministic data from agent work: API-backed panels should be fast and predictable, while Flue handles conversations and bounded agent tasks.
- Favor configuration over editing: v1 layouts should be reliable JSON presets, not a full dashboard builder.
- Preserve all-day readability: light and dark themes must both be usable on a small companion display.
- Make plugins boring to add: typed in-repo display plugins should have clear contracts and safe defaults.

## Accessibility & Inclusion

Target WCAG AA contrast for text and controls in both light and dark themes. Support keyboard navigation, visible focus states, reduced motion preferences, and clear loading, empty, and error states.
