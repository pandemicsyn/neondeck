# Product

## Register

brand

## Users

Developers and maintainers who want a local-first companion agent to keep pull
requests moving. They own several active PRs, review other people's work, and do
not want feedback, requested changes, or CI failures to disappear into browser
tabs. They want an always-visible work console on a companion display, vertical
panel, ultrawide strip, or ordinary monitor, but special hardware is not
required.

They are comfortable with repositories, GitHub, terminals, and local developer
tooling. They want useful autonomy without ambiguous authority, inspectable
state instead of a hosted black box, and clear boundaries around what Neon can
change or deliver. They are skeptical of hype and want to understand what
Neondeck does, where it runs, how human review remains in control, and how to
install it quickly.

## Product Purpose

Neondeck is a local-first companion agent for keeping pull requests moving. Its
current product focus is one connected PR workflow:

- Surface authored PRs, review requests, failing checks, stale work, and active
  watches in a glanceable queue.
- Watch complete PR state, including commits, review threads, requested
  changes, conversation comments, checks, branch freshness, and mergeability.
  Semantic watermarks keep unchanged polls quiet, and the user explicitly
  chooses whether existing feedback should be processed or treated as the
  starting baseline.
- Give a watched PR one continuing Neon owner and one managed worktree.
  Autopilot can notify only, prepare a local commit for review, wait for direct
  human approval before delivery, or autonomously deliver when the owner judges
  the change reasonable, appropriately scoped, and sufficiently validated.
- Provide a focused human review workbench for reading diffs, navigating files
  and threads, drafting inline comments, and submitting Comment, Approve, or
  Request changes. Neon reviews an exact revision through bounded read-only
  access and creates local reports and draft findings; the human owns every
  GitHub review action and verdict.

Autopilot authority must remain explicit. Increasing authority requires
confirmation, delivery rechecks the expected PR head and destination, and
Autopilot never force-pushes. Coding happens through a trusted local shell in a
Neondeck-managed worktree. The worktree keeps intended autonomous changes out
of the user's primary checkout, but it is not an operating-system security
sandbox.

The optional `exe.dev` integration is work in progress. It can mediate explicit
commands on a configured remote VM, but it does not host Neondeck's main
runtime, scheduled work, PR watches, human review workflow, or Autopilot owner.
The product and website must not imply that enabling it moves all agent work to
an isolated remote environment.

Durable chat sessions, schedules, morning briefings, memory, runtime skills,
notifications, readiness checks, self-configuration, release watches, and
handoffs to coding agents support the PR loop. They should be presented as
supporting capabilities rather than separate products competing for equal
attention. GitHub is currently the primary PR and check integration, the web
dashboard is the current operator surface, and release watching follows GitHub
checks rather than provider-specific deployment systems.

Neondeck.dev is the project's public face: a marketing-and-docs site that shows
the real deck and this PR lifecycle, explains the available authority modes and
trust boundaries, and gets a developer to the install command and detailed docs
with minimal friction. Success is a developer who lands, immediately
understands that Neondeck watches PRs, can keep authored work moving, supports
human review, runs locally, and provides explicit control over external
changes.

## Brand Personality

Confident, technical, calm, and a little neon. Where the dashboard product is a
quiet cockpit, the marketing surface is allowed to turn the same Miami palette
up: cyan, pink, and violet over near-black, with a signature warped tiger-stripe
"camo" hero. The voice is direct and developer-to-developer: precise about
capabilities, plain about limitations, and free of growth-marketing fluff or
enterprise platitudes. Three words: electric, precise, local.

## Anti-references

Avoid generic SaaS landing-page clichés: the hero-metric template, endless
identical feature-card grids, stock illustrations, gradient-everything, and
"trusted by" logo walls. Avoid enterprise blandness and gamer/RGB styling that
reads as a peripheral ad rather than a serious developer tool. The neon is
intentional and restrained, not a rainbow.

Avoid generic "autonomous developer" claims that hide what the agent watches,
which mode is active, what remains local, or who owns review submission. Do not
describe managed worktrees as security sandboxes, and do not imply that all work
runs remotely because an experimental sandbox integration exists.

## Design Principles

- Show the deck and the PR loop, not just an abstract agent: the queue, watch
  state, Autopilot owner, prepared diff, review findings, and blocked work
  should feel concrete.
- Lead with keeping PRs moving. Watching, Autopilot, and human review are the
  primary product story; chat, schedules, memory, and handoffs support it.
- Make authority legible: users should be able to see what Neon may do, what
  needs approval, what was delivered, and why work was held.
- Keep human review human-owned: Neon may investigate and draft, but the
  reviewer chooses and submits the verdict.
- Sell local-first as a headline value while accurately explaining that a
  managed worktree is not operating-system isolation.
- Treat the Xeneon Edge aspect ratio as a signature example while making clear
  that vertical, horizontal, primary-display, and custom layouts are supported.
- Get to the command fast: the install/run command is a first-class, copyable
  hero element.
- Let the brand be louder than the product UI, but keep it the _same_ brand:
  same fonts and palette, turned up.
- Docs and marketing share one shell: reading the docs should feel like the
  same site, not a bolted-on wiki.

## Accessibility & Inclusion

Target WCAG AA contrast across the dark/camo and light themes. Keep the
warped-stripe hero decorative and behind a vignette so it never reduces text
contrast. Support keyboard navigation and visible focus, honor
`prefers-reduced-motion`, and keep copy, theme, watch, review, approval, and
submission controls fully operable and labeled.
