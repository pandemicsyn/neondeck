# Contributing to Neondeck

Neondeck is a personal, opinionated project led by
[@pandemicsyn](https://github.com/pandemicsyn). We welcome bug fixes and
thoughtfully prepared feature work, while product direction and architectural
decisions remain with the maintainer.

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

Feature pull requests are welcome, but are unlikely to be accepted unless the
feature has been discussed and approved before implementation. This keeps
contributor effort focused on work that fits Neondeck's direction.

If you want to propose a feature, open an **Ideas & Feature Development**
GitHub Discussion first. Work with the maintainer to develop a thorough
specification, implementation prompt, and plan, then receive approval before
starting the PR. The maintainer runs the resulting prompt and work. A proposal
should cover:

- the problem, who experiences it, and why the current behavior is inadequate;
- concrete user flows and acceptance criteria;
- proposed UX, API, data model, configuration, and runtime behavior where
  relevant;
- alternatives considered, tradeoffs, risks, and compatibility or migration
  concerns;
- security, privacy, operational, and maintenance implications; and
- validation plan, including tests and documentation changes.

Discussions alone do not imply that a feature is accepted or scheduled. A
feature PR without an approved discussion, prompt, and plan will likely be
closed. When Neondeck uses a contributor's discussion or resulting prompt to
develop a feature, that contributor will be credited for the feature.

## AI-assisted work

AI-assisted work is expected and welcome. In the pull request, disclose every
model used to develop the work and how it was used. We use that context to
calibrate review: different models have different strengths, failure modes, and
levels of reliability.

Regardless of the tools involved, contributors are responsible for
understanding and validating the code they submit.

## Maintainer authority

[@pandemicsyn](https://github.com/pandemicsyn) makes the final decisions on
scope, direction, and merging. Please respect those decisions when proposing or
implementing work.
