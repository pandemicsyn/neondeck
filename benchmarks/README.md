# Frontend performance benchmarks

This directory contains local, measurement-only diagnostics. The benchmark page
is a separate Vite entry at `web/perf.html`; it imports production Neondeck
components but is not reachable from the production `web/index.html` entry.

Run the repeatable headless suite:

```sh
npm run bench:frontend -- --samples 3
```

Open the fixture lab manually:

```sh
npm run bench:frontend:page
```

Then visit `http://127.0.0.1:4179/perf.html`. Query parameters select the
surface, tier, and experimental harness-only variant, for example:

```text
/perf.html?surface=diff&tier=huge
/perf.html?surface=diff&tier=huge&variant=virtualized
/perf.html?surface=diff&tier=huge&variant=codeview
/perf.html?surface=diff&tier=huge&variant=auto
/perf.html?surface=chat&tier=500
/perf.html?surface=chat&tier=500&variant=isolated
/perf.html?surface=runtime&tier=4
/perf.html?surface=review&tier=50
```

The suite records React Profiler commits, Markdown render counts, long tasks,
DOM/shadow-DOM nodes, heap estimates, scroll/typing latency, TanStack Query
request counts, and production bundle sizes. Results are machine-local evidence,
not CI gates. The fixture entry uses React's production profiling renderer so
Profiler callbacks remain enabled; the application entry is unchanged. Results
default to the ignored `benchmarks/results/frontend-performance-local.json`.
The chat `isolated` variant keeps the original fixture mounted while applying
the same stable timeline boundary as production, so the default and isolated
rows remain a repeatable before/after pair.
The diff `codeview` variant measures Pierre CodeView directly, while `auto`
exercises Neondeck's production threshold and selection adapter. The original
baseline and lower-level `virtualized` variants remain as comparison controls.

The 50,000-line Pierre tier is opt-in because the unvirtualized baseline can
take minutes or exhaust memory:

```sh
npm run bench:frontend -- --samples 1 --include-fifty-k
```

## Real PR review

Run the production server with the target repository registered in
`NEONDECK_HOME`, then point the real-PR harness at a specific immutable
revision:

```sh
npm run bench:pr-review -- \
  --origin http://127.0.0.1:3000 \
  --repo owner/name \
  --number 123 \
  --head <head-sha> \
  --base <base-sha> \
  --base-ref main \
  --title "PR title" \
  --samples 3
```

The harness measures the initial and warm local file-list calls, a sequential
first patch, the real unresolved-thread fanout, and production-browser time to
tree, threads, and first patch. It also records duplicate/aborted requests and
API transfer bytes. Add `--include-github-fallback` only when the extra GitHub
API traffic is intentional. The initial local call is a valid cold measurement
only if the target head/base objects were absent before the run. Results default
to the ignored `benchmarks/results/pr-review-real-local.json`.
