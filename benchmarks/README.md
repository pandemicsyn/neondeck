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
/perf.html?surface=chat&tier=500
/perf.html?surface=runtime&tier=4
/perf.html?surface=review&tier=50
```

The suite records React Profiler commits, Markdown render counts, long tasks,
DOM/shadow-DOM nodes, heap estimates, scroll/typing latency, TanStack Query
request counts, and production bundle sizes. Results are machine-local evidence,
not CI gates. The fixture entry uses React's production profiling renderer so
Profiler callbacks remain enabled; the application entry is unchanged. Results
default to the ignored `benchmarks/results/frontend-performance-local.json`.

The 50,000-line Pierre tier is opt-in because the unvirtualized baseline can
take minutes or exhaust memory:

```sh
npm run bench:frontend -- --samples 1 --include-fifty-k
```
