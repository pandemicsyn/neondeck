import {
  QueryClient,
  QueryClientProvider,
  useQueries,
} from '@tanstack/react-query';
import { Virtualizer } from '@pierre/diffs/react';
import { Profiler, useMemo, useState, type ChangeEvent } from 'react';
import { Badge, Card } from '../components/ui';
import { MarkdownMessage } from '../components/MarkdownMessage';
import {
  DiffWorkerProvider,
  UnifiedPatchView,
} from '../features/diff-viewer/DiffViewer';
import { MultiFileView } from '../features/diff-viewer/MultiFileView';
import type { DiffReviewAnnotation } from '../features/diff-viewer/types';
import {
  createChatMessages,
  createDiffFiles,
  createDiffFixture,
} from './fixtures';
import {
  recordBenchmarkCommit,
  recordMarkdownRender,
  recordQueryAbort,
  recordQueryRequest,
} from './metrics';

export type BenchmarkConfig = ReturnType<typeof readBenchmarkConfig>;

export function readBenchmarkConfig(search: string) {
  const params = new URLSearchParams(search);
  const surface = params.get('surface') ?? 'diff';
  return {
    surface,
    tier: params.get('tier') ?? defaultTier(surface),
    variant: params.get('variant') ?? 'baseline',
    count: positiveInteger(params.get('count')),
  };
}

export function benchmarkFixtureMetadata(
  config: BenchmarkConfig,
): Record<string, string | number | boolean> {
  if (config.surface === 'chat') {
    return { messages: config.count ?? positiveInteger(config.tier) ?? 100 };
  }
  if (config.surface === 'runtime') {
    return { panels: config.count ?? positiveInteger(config.tier) ?? 1 };
  }
  if (config.surface === 'review') {
    return { threads: config.count ?? positiveInteger(config.tier) ?? 50 };
  }
  if (config.tier === 'tree') {
    return { files: 180, changedLinesPerFile: 120 };
  }
  const preset = diffPreset(config.tier);
  return {
    changedLines: preset.changedLines,
    fileCount: preset.fileCount,
    lineWidth: preset.lineWidth,
    annotations: preset.annotationCount,
    virtualized: config.variant === 'virtualized',
  };
}

export function BenchmarkApp({ config }: { config: BenchmarkConfig }) {
  return (
    <main className="perf-page">
      <BenchmarkHeader config={config} />
      <Profiler id={config.surface} onRender={recordBenchmarkCommit}>
        <section
          aria-label={`${config.surface} benchmark surface`}
          className="perf-surface"
          data-benchmark-surface={config.surface}
        >
          {renderSurface(config)}
        </section>
      </Profiler>
    </main>
  );
}

function renderSurface(config: BenchmarkConfig) {
  if (config.surface === 'chat') {
    return (
      <ChatBenchmark
        count={config.count ?? positiveInteger(config.tier) ?? 100}
      />
    );
  }
  if (config.surface === 'runtime') {
    return (
      <RuntimeBenchmark
        panelCount={config.count ?? positiveInteger(config.tier) ?? 1}
      />
    );
  }
  if (config.surface === 'review') {
    return (
      <ReviewBenchmark
        threadCount={config.count ?? positiveInteger(config.tier) ?? 50}
      />
    );
  }
  return <DiffBenchmark tier={config.tier} variant={config.variant} />;
}

function BenchmarkHeader({ config }: { config: BenchmarkConfig }) {
  const scenarios = [
    ['diff', 'typical'],
    ['diff', 'large'],
    ['diff', 'huge'],
    ['diff', 'tree'],
    ['diff', 'threads'],
    ['chat', '10'],
    ['chat', '100'],
    ['chat', '500'],
    ['runtime', '1'],
    ['runtime', '4'],
    ['review', '50'],
  ];
  return (
    <header className="perf-header">
      <div>
        <p className="perf-kicker">NEONDECK · MEASUREMENT ONLY</p>
        <h1>Frontend performance harness</h1>
        <p>
          {config.surface} / {config.tier} / {config.variant}
        </p>
      </div>
      <nav aria-label="Benchmark scenarios" className="perf-nav">
        {scenarios.map(([surface, tier]) => (
          <a
            aria-current={
              surface === config.surface && tier === config.tier
                ? 'page'
                : undefined
            }
            href={`/perf.html?surface=${surface}&tier=${tier}`}
            key={`${surface}-${tier}`}
          >
            {surface}:{tier}
          </a>
        ))}
      </nav>
    </header>
  );
}

function DiffBenchmark({ tier, variant }: { tier: string; variant: string }) {
  if (tier === 'tree') {
    const files = useMemo(() => createDiffFiles(180, 120), []);
    return (
      <MultiFileView
        detail="180 files × 120 changed lines; all patches resident"
        files={files}
        title="Pierre file-tree fixture"
      />
    );
  }

  const fixture = useMemo(() => createDiffFixture(diffPreset(tier)), [tier]);
  const content = (
    <UnifiedPatchView
      detail={`${fixture.changedLines.toLocaleString()} changed lines · ${fixture.fileCount} files`}
      lineAnnotations={fixture.annotations}
      patch={fixture.patch}
      renderAnnotation={renderBenchmarkAnnotation}
      title="Pierre patch fixture"
    />
  );

  return (
    <DiffWorkerProvider>
      {variant === 'virtualized' ? (
        <Virtualizer
          className="perf-virtualizer perf-virtualized"
          config={{ overscrollSize: 600 }}
          contentClassName="perf-virtualizer-content"
        >
          {content}
        </Virtualizer>
      ) : (
        content
      )}
    </DiffWorkerProvider>
  );
}

function ChatBenchmark({ count }: { count: number }) {
  const messages = useMemo(() => createChatMessages(count), [count]);
  const [input, setInput] = useState('');
  return (
    <div className="perf-chat-shell">
      <div className="perf-chat-timeline">
        {messages.map((message) => (
          <article
            className={`chat-message chat-message-${message.role}`}
            key={message.id}
          >
            <p className="perf-message-role">{message.role}</p>
            <MeasuredMarkdownMessage>{message.body}</MeasuredMarkdownMessage>
          </article>
        ))}
      </div>
      <label className="perf-composer">
        <span>Benchmark composer</span>
        <textarea
          data-benchmark-input
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            setInput(event.target.value)
          }
          rows={2}
          value={input}
        />
      </label>
    </div>
  );
}

function MeasuredMarkdownMessage({ children }: { children: string }) {
  recordMarkdownRender();
  return <MarkdownMessage>{children}</MarkdownMessage>;
}

function RuntimeBenchmark({ panelCount }: { panelCount: number }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <div className="perf-runtime-grid">
        {Array.from({ length: panelCount }, (_, index) => (
          <RuntimePanel index={index} key={index} />
        ))}
      </div>
    </QueryClientProvider>
  );
}

function RuntimePanel({ index }: { index: number }) {
  const queries = useQueries({
    queries: runtimeQueryNames.map((name, queryIndex) => ({
      queryKey: ['perf-runtime', name],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        mockRuntimeQuery(name, signal),
      refetchInterval: queryIndex === 12 ? 150 : 300,
    })),
  });
  const ready = queries.filter((query) => query.data).length;
  return (
    <Card className="perf-runtime-panel">
      <div className="perf-runtime-heading">
        <span>runtime panel {index + 1}</span>
        <Badge>{ready}/15 ready</Badge>
      </div>
      {queries.map((query, queryIndex) => (
        <div className="perf-runtime-row" key={runtimeQueryNames[queryIndex]}>
          <span>{runtimeQueryNames[queryIndex]}</span>
          <span>{query.fetchStatus}</span>
        </div>
      ))}
    </Card>
  );
}

function ReviewBenchmark({ threadCount }: { threadCount: number }) {
  return (
    <div className="pr-review-shell-standalone perf-review-layout">
      <div className="diff-inspector-pane">
        <ReviewDetails label="Inspector copy" threadCount={threadCount} />
      </div>
      <div className="pr-review-compact-panels">
        <ReviewDetails label="Compact copy" threadCount={threadCount} />
      </div>
    </div>
  );
}

function ReviewDetails({
  label,
  threadCount,
}: {
  label: string;
  threadCount: number;
}) {
  return (
    <section className="pr-review-inspector" data-review-copy={label}>
      <div className="pr-review-inspector-section">
        <div className="pr-review-inspector-heading">
          <span>{label}</span>
          <span>{threadCount} threads</span>
        </div>
      </div>
      {Array.from({ length: threadCount }, (_, index) => (
        <article className="pr-review-inspector-section" key={index}>
          <div className="pr-review-inspector-heading">
            <span>Thread {index + 1}</span>
            <span>open</span>
          </div>
          <p className="pr-review-inspector-path">
            src/fixtures/review-{index}.tsx:L{index + 10}
          </p>
          <p className="pr-review-inspector-copy">
            Deterministic review feedback with enough text to exercise wrapping,
            reconciliation, and the narrow responsive layout.
          </p>
          <div className="pr-review-inspector-metrics">
            <span>2 replies</span>
            <span>unresolved</span>
          </div>
        </article>
      ))}
    </section>
  );
}

const runtimeQueryNames = [
  'status',
  'registry',
  'repo-health',
  'scheduled-tasks',
  'skills',
  'memories',
  'notifications',
  'execution-approvals',
  'mcp-servers',
  'mcp-approvals',
  'safety',
  'workflows',
  'kilo-tasks',
  'repo-edits',
  'worktrees',
];

async function mockRuntimeQuery(name: string, signal: AbortSignal) {
  recordQueryRequest();
  return new Promise<{ name: string; updatedAt: number }>((resolve, reject) => {
    const timer = window.setTimeout(
      () => resolve({ name, updatedAt: performance.now() }),
      8,
    );
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        recordQueryAbort();
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function renderBenchmarkAnnotation(annotation: DiffReviewAnnotation) {
  return (
    <div data-neondeck-review-annotation>
      <div data-neondeck-review-annotation-title>
        <span>{annotation.metadata.title}</span>
        <span>{annotation.metadata.kind}</span>
      </div>
      <p>{annotation.metadata.body}</p>
    </div>
  );
}

function diffPreset(tier: string) {
  if (tier === 'large') {
    return {
      changedLines: 5_000,
      fileCount: 1,
      lineWidth: 72,
      annotationCount: 0,
    };
  }
  if (tier === 'huge') {
    return {
      changedLines: 10_000,
      fileCount: 1,
      lineWidth: 72,
      annotationCount: 0,
    };
  }
  if (tier === 'fifty-k') {
    return {
      changedLines: 50_000,
      fileCount: 1,
      lineWidth: 72,
      annotationCount: 0,
    };
  }
  if (tier === 'wrapped') {
    return {
      changedLines: 500,
      fileCount: 1,
      lineWidth: 1_200,
      annotationCount: 0,
    };
  }
  if (tier === 'threads') {
    return {
      changedLines: 500,
      fileCount: 1,
      lineWidth: 72,
      annotationCount: 50,
    };
  }
  return {
    changedLines: 400,
    fileCount: 1,
    lineWidth: 72,
    annotationCount: 0,
  };
}

function defaultTier(surface: string) {
  if (surface === 'chat') return '100';
  if (surface === 'runtime') return '1';
  if (surface === 'review') return '50';
  return 'typical';
}

function positiveInteger(value: string | null) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
