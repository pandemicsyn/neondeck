---
name: roadmap-review
description: Use when reviewing local staged or unstaged implementation changes for a .plans/ROADMAP.md item in this repository. Performs a static-only code review without running tests, linters, builds, formatters, or app commands; checks roadmap alignment, .plans/DEVIATIONS.md quality, TypeScript/API boundary design, and React implementation quality.
---

# Roadmap Review

Use this skill to review local changes that implement a `.plans/ROADMAP.md` item.

## Review Scope

Review local git changes only:

- staged changes
- unstaged tracked changes
- untracked files relevant to the implementation

Use static inspection only. Do not run tests, linters, formatters, builds, typecheck, dev servers, app commands, package scripts, database migrations, or network calls. It is fine to run read-only inspection commands such as `git status`, `git diff`, `git diff --cached`, `git ls-files`, `rg`, `sed`, and `cat`.

## Required Context

Read these before judging the implementation:

- `.plans/ROADMAP.md`
- `.plans/DEVIATIONS.md` if present
- `AGENTS.md` if present
- the local diff and newly added files
- nearby source files needed to understand changed code

If the changed roadmap item is unclear, infer it from the diff and say so under assumptions.

## Review Priorities

Findings should lead the response. Focus on bugs, regressions, architecture drift, maintainability risks, and missing or poor deviations logging.

Flag issues where the implementation:

- does not match the selected roadmap item
- silently implements broad adjacent roadmap work
- defers important behavior without a reasonable note in `.plans/DEVIATIONS.md`
- records a deviation that seems unreasonable, misleading, too vague, or inconsistent with the code
- mutates config/state without the typed action/workflow direction established in the roadmap
- mixes Neondeck app state and Flue runtime state without an explicit roadmap-backed reason

## Deviations Log Review

Always inspect `.plans/DEVIATIONS.md`.

Flag:

- missing deviation entries when the diff clearly narrows, broadens, reorders, or substitutes the roadmap plan
- deferrals that hide required behavior behind vague follow-up language
- deviations that lack roadmap item, decision, reason, or follow-up
- deviations that appear to justify avoidable shortcuts
- significant implementation choices that should be recorded but are not

Do not require log entries for tiny implementation details that do not affect scope, order, architecture, or reviewability.

## TypeScript Standards

Review TypeScript for:

- clear, readable, composable modules
- small functions with explicit responsibilities
- DRY implementation without premature abstraction
- precise types rather than broad `any`, unsafe casts, or stringly typed contracts
- explicit error handling at IO and persistence boundaries
- stable schemas for config, API request/response bodies, persisted state, and external data
- Valibot validation at all API/IO boundaries, including local config files, environment-derived values, HTTP payloads, database rows, GitHub/API responses, and agent action inputs

Flag missing Valibot validation when changed code accepts data from outside trusted in-process callers.

## React Standards

Review React for:

- modern function components
- clear component boundaries
- hooks used correctly and predictably
- state kept as local as practical
- derived state computed rather than duplicated
- accessible interactive elements
- stable keys, memoization, and callbacks where they materially prevent churn
- higher-order/component composition patterns where they improve reuse without obscuring data flow

Flag class components, unnecessary global state, brittle prop drilling, effect misuse, duplicated rendering logic, and UI states that omit loading, empty, error, or normal cases.

## Output Format

Use code-review style:

1. Findings first, ordered by severity.
2. Include file and line references when possible.
3. Then list open questions or assumptions.
4. Then briefly summarize what looks aligned.

If there are no findings, say that clearly and mention residual risks, especially that this was static-only and no tests or linters were run.

Do not run verification commands. Do not suggest that a finding is cleared by tests unless the code itself proves it.
