import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getHostMetrics } from '../api';
import { EmptyState } from '../App';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';

export const HostMetricsPlugin = {
  id: 'host-metrics',
  title: 'Host metrics',
  kind: 'status',
  defaultConfig: {},
  Component() {
    const [now, setNow] = useState(() => new Date());
    const {
      data: metrics,
      error,
      isLoading,
    } = useQuery({
      queryKey: queryKeys.hostMetrics,
      queryFn: getHostMetrics,
      refetchInterval: 1_000,
    });

    useEffect(() => {
      const timer = window.setInterval(() => setNow(new Date()), 1_000);
      return () => window.clearInterval(timer);
    }, []);

    if (isLoading) {
      return (
        <div className="powerline h-full">
          {Array.from({ length: 6 }).map((_, index) => (
            <div className="status-segment min-w-36" key={index}>
              <span className="h-3 w-20 rounded-sm bg-line" />
            </div>
          ))}
        </div>
      );
    }

    if (error) {
      return (
        <EmptyState
          title="Metrics unavailable"
          detail={queryErrorMessage(error)}
        />
      );
    }

    if (!metrics) {
      return <EmptyState title="Metrics unavailable" detail="No data." />;
    }

    const memoryPercent = Math.round(metrics.memory.usedRatio * 100);
    const cpuPercent =
      metrics.cpu.loadPercent ??
      Math.min(
        100,
        Math.round(
          (metrics.loadAverage[0] / Math.max(1, metrics.cpuCount)) * 100,
        ),
      );
    const temperatureC =
      metrics.gpu.temperatureC ??
      metrics.temperature.cpuC ??
      metrics.temperature.maxC;

    return (
      <div className="powerline h-full">
        <div className="brand-segment px-3.5">
          <span className="brand-mark" />
          <span>neondeck</span>
          <span className="text-[11px] font-normal text-muted">v0.4.1</span>
        </div>
        <StatusDivider />
        <StatusSegment
          label="CPU"
          tone="cyan"
          value={`${Math.round(cpuPercent)}%`}
        />
        <StatusDivider />
        <StatusSegment
          label="MEM"
          tone={memoryPercent > 90 ? 'pink' : 'cyan'}
          value={`${formatGiB(metrics.memory.used)}/${formatGiB(metrics.memory.total)}`}
        />
        <StatusDivider />
        <StatusSegment
          label="GPU"
          tone="teal"
          value={formatPercent(metrics.gpu.utilizationPercent)}
        />
        <StatusDivider />
        <StatusSegment
          label=""
          tone="teal"
          value={formatTemperature(temperatureC)}
        />
        <StatusDivider />
        <StatusSegment
          label="NET"
          tone="violet"
          value={`↓${formatNetwork(metrics.network.downBytesPerSecond)} ↑${formatNetwork(metrics.network.upBytesPerSecond)}`}
        />
        <StatusDivider />
        <span className="flex items-center gap-1.5 px-3 text-primary">
          <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--primary)] [animation:nd-pulse_2.4s_ease-in-out_infinite]" />
          flue:online
        </span>
        <p className="ml-auto px-3.5 text-ink tabular-nums">
          {clockParts(now).hourMinute}
          <span className="[animation:nd-blink_1.1s_step-end_infinite]">:</span>
          {clockParts(now).seconds}
        </p>
      </div>
    );
  },
} satisfies DisplayPlugin;

function StatusDivider() {
  return <span className="status-separator">│</span>;
}

function StatusSegment({
  label,
  tone,
  value,
}: {
  label: string;
  tone: 'cyan' | 'muted' | 'pink' | 'teal' | 'violet';
  value: string;
}) {
  return (
    <div className="status-segment">
      {label ? (
        <span className={`status-label status-${tone}`}>{label}</span>
      ) : null}
      <span className="status-value">{value}</span>
    </div>
  );
}

function formatGiB(value: number) {
  const amount = value / 1024 / 1024 / 1024;
  return `${amount.toFixed(amount >= 10 ? 0 : 1)}G`;
}

function formatPercent(value: number | null) {
  if (value == null) return 'n/a';
  return `${Math.round(value)}%`;
}

function formatTemperature(value: number | null) {
  if (value == null) return 'n/a °C';
  return `${Math.round(value)} °C`;
}

function formatNetwork(value: number | null) {
  if (value == null) return 'n/a';
  const mbps = (value * 8) / 1_000_000;
  if (mbps < 0.05) return '0.0';
  if (mbps < 10) return mbps.toFixed(1);
  return Math.round(mbps).toString();
}

function clockParts(value: Date) {
  const [hourMinute = '', seconds = ''] = value
    .toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    .split(/:(?=\d{2}$)/);

  return { hourMinute, seconds };
}
