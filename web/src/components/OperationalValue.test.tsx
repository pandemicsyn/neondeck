// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationalValue } from './OperationalValue';

describe('OperationalValue', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('leaves fully visible short values as plain text', () => {
    const html = renderToStaticMarkup(
      <OperationalValue label="command" value="npm run check" />,
    );

    expect(html).toContain('npm run check');
    expect(html).not.toContain('<details');
  });

  it('preserves and discloses long values instead of trimming them', () => {
    const value = `npm run diagnostic -- ${'x'.repeat(200)} tail-marker`;
    const html = renderToStaticMarkup(
      <OperationalValue label="diagnostic command" value={value} />,
    );

    expect(html).toContain('<details');
    expect(html).not.toContain('aria-label="Show full diagnostic command"');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('…');
    expect(html).not.toContain('tail-marker');
    expect(html).not.toContain('aria-label="Copy diagnostic command"');
  });

  it('names a disclosure with both its action and operational preview', () => {
    const value = `npm run diagnostic -- ${'x'.repeat(100)}`;

    act(() =>
      root.render(
        <OperationalValue label="diagnostic command" value={value} />,
      ),
    );

    const summary = container.querySelector('summary') as HTMLElement;
    const labelledBy = summary.getAttribute('aria-labelledby')?.split(' ');
    const accessibleName = labelledBy
      ?.map((id) => document.getElementById(id)?.textContent)
      .join(' ');

    expect(accessibleName).toContain('Show full diagnostic command.');
    expect(accessibleName).toContain('npm run diagnostic --');
  });

  it('copies the complete value and announces success', async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const value = `full command ${'x'.repeat(100)}`;

    act(() => root.render(<OperationalValue label="command" value={value} />));

    await act(async () => {
      const details = container.querySelector('details') as HTMLDetailsElement;
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Copy command"]')
        ?.click();
    });

    expect(writeText).toHaveBeenCalledWith(value);
    expect(container.querySelector('output')?.textContent).toBe(
      'command copied.',
    );
  });
});
