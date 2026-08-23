# Contributing to Neondeck

Neondeck is a personal, opinionated project maintained solely by
[@pandemicsyn](https://github.com/pandemicsyn). The project is deliberately
built differently from a conventional open-source project: its product
direction, architecture, and feature work are maintained by the owner.

## What we accept

Bug-fix pull requests are welcome when they provide convincing, reproducible
evidence of a problem. A useful PR includes:

- a clear description of the observed behavior and the expected behavior;
- steps, a minimal reproduction, logs, screenshots, or another form of
  evidence that lets us verify the bug;
- focused changes that address that evidence; and
- tests that demonstrate the failure and fix when the codebase can reasonably
  support them.

Please keep bug fixes narrowly scoped. PRs without evidence, or PRs that
combine an unrelated cleanup with a fix, may be closed.

## Features and product changes

Feature pull requests will be closed. This is not a judgment on the quality of
the work; Neondeck's feature set is planned and implemented by
[@pandemicsyn](https://github.com/pandemicsyn).

If you want to propose a feature, open a **Feature specifications** GitHub
Discussion first. Do not start implementation until there is a discussion
outcome. We use that discussion to develop an implementation prompt; the
maintainer runs the resulting prompt and work. A proposal should be a thorough
specification covering:

- the problem, who experiences it, and why the current behavior is inadequate;
- concrete user flows and acceptance criteria;
- proposed UX, API, data model, configuration, and runtime behavior where
  relevant;
- alternatives considered, tradeoffs, risks, and compatibility or migration
  concerns;
- security, privacy, operational, and maintenance implications; and
- validation plan, including tests and documentation changes.

Discussions are for design input and do not imply that a feature will be
accepted or scheduled. When Neondeck uses a contributor's discussion or
resulting prompt to develop a feature, that contributor will be credited for
the feature.

## Maintainer authority

Only [@pandemicsyn](https://github.com/pandemicsyn) is authorized to merge
changes, make product decisions, and add features to this repository. Please
respect final maintainer decisions on scope and direction.
