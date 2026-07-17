import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getReports, stageDocsDriftFix, type ReportRecord } from '../api';
import { Badge, EmptyState, ScrollArea } from '../components/ui';
import { relativeTime } from '../lib/format';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';
import { parsePositiveIntegerConfig } from './config';

type ReportsPanelConfig = {
  limit: number;
  refreshSeconds: number;
};

const reportsPanelDefaultConfig = {
  limit: 12,
  refreshSeconds: 60,
};

export const ReportsPanelPlugin = {
  id: 'reports-panel',
  title: 'Reports',
  kind: 'data',
  defaultConfig: reportsPanelDefaultConfig,
  parseConfig: (config) =>
    parsePositiveIntegerConfig(reportsPanelDefaultConfig, config),
  Component({ config }) {
    const { data, error, isLoading } = useQuery({
      queryKey: [...queryKeys.reports, config.limit] as const,
      queryFn: () =>
        getReports({ excludeKind: 'pr-review', limit: config.limit }),
      refetchInterval: Math.max(10, config.refreshSeconds) * 1000,
    });

    if (isLoading) {
      return (
        <EmptyState title="Reports loading" detail="Reading local artifacts." />
      );
    }

    if (error) {
      return (
        <EmptyState
          title="Reports unavailable"
          detail={queryErrorMessage(error)}
          tone="alert"
        />
      );
    }

    const reports = data?.items ?? [];
    return (
      <div className="terminal-list flex h-full min-h-0 flex-col">
        <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
          <span className="text-primary">REPORTS</span>
          <Badge>{reports.length} local</Badge>
        </header>
        {reports.length === 0 ? (
          <EmptyState
            title="No reports"
            detail="Unlinked CI, drift, triage, and hygiene reports will appear here. Review artifacts stay with their review."
          />
        ) : (
          <ScrollArea className="flex-1">
            <div className="space-y-1.5 p-3">
              {reports.map((report) => (
                <ReportRow key={report.id} report={report} />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    );
  },
} satisfies DisplayPlugin<ReportsPanelConfig>;

function ReportRow({ report }: { report: ReportRecord }) {
  const summary = reportSummary(report.summary);
  const queryClient = useQueryClient();
  const stageDocs = useMutation({
    mutationFn: () => stageDocsDriftFix(report.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reports });
    },
  });
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {report.title}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {summary || report.sourceRef || report.repoId || report.createdBy}
          </p>
        </div>
        <Badge>{report.kind}</Badge>
      </div>
      <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-muted">
        <span className="min-w-0 flex-1 truncate">
          {report.sourceRef ?? report.repoId ?? report.createdBy} ·{' '}
          {relativeTime(report.createdAt)}
        </span>
        {report.kind === 'docs-drift' ? (
          <button
            className="shrink-0 border border-line px-1.5 py-0.5 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-wait disabled:opacity-60"
            disabled={stageDocs.isPending}
            onClick={() => stageDocs.mutate()}
            title={
              stageDocs.error
                ? queryErrorMessage(stageDocs.error)
                : 'Stage a docs-only Kilo fix'
            }
            type="button"
          >
            {stageDocs.isPending ? 'staging' : 'stage'}
          </button>
        ) : null}
        <a
          className="shrink-0 border border-line px-1.5 py-0.5 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
          href={`/reports/${encodeURIComponent(report.id)}`}
          rel="noreferrer"
          target="_blank"
        >
          open
        </a>
      </div>
    </article>
  );
}

function reportSummary(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => reportSummary(item))
      .filter(Boolean)
      .join(' · ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const summary = record.summary ?? record.message ?? record.title;
    if (typeof summary === 'string') return summary;
    return Object.entries(record)
      .slice(0, 3)
      .map(([key, item]) => `${key}: ${reportSummary(item) ?? 'n/a'}`)
      .join(' · ');
  }
  return null;
}
