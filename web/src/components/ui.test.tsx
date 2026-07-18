import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState, Metric, StatusPill } from './ui';

describe('EmptyState accessibility', () => {
  it('announces ordinary loading and empty states politely', () => {
    const html = renderToStaticMarkup(
      <EmptyState detail="Reading durable state." title="Loading" />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it('announces failures assertively', () => {
    const html = renderToStaticMarkup(
      <EmptyState
        detail="The request failed."
        title="Unavailable"
        tone="alert"
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
  });
});

describe('live metric typography', () => {
  it('uses tabular numerals for shared metric and status values', () => {
    const html = renderToStaticMarkup(
      <>
        <Metric label="runs" value={12} />
        <StatusPill label="healthy" ok value="3/10" />
      </>,
    );

    expect(html.match(/tabular-nums/g)).toHaveLength(2);
  });
});
