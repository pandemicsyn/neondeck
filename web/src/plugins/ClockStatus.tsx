import { useEffect, useState } from 'react';
import type { DisplayPlugin } from '../types';

export const ClockStatusPlugin = {
  id: 'clock-status',
  title: 'Clock and status',
  kind: 'status',
  defaultConfig: {},
  Component() {
    const [now, setNow] = useState(() => new Date());

    useEffect(() => {
      const timer = window.setInterval(() => setNow(new Date()), 1_000);
      return () => window.clearInterval(timer);
    }, []);

    return (
      <div className="flex h-full items-center justify-between px-3">
        <div>
          <p className="font-mono text-2xl font-semibold tabular-nums text-ink">
            {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </p>
          <p className="text-xs text-muted">
            {now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold text-ink">neondeck</p>
          <p className="text-xs text-muted">neondeck.dev · Flue</p>
        </div>
      </div>
    );
  },
} satisfies DisplayPlugin;
