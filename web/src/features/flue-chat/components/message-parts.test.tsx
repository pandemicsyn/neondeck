// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderMessagePart } from './message-parts';

describe('renderMessagePart', () => {
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
  });

  it('retains the full operational payload behind a disclosure', () => {
    const output = `\n diagnostic ${'x'.repeat(200)} tail-marker \n`;
    const part = renderMessagePart(
      { name: 'read-diff', output, type: 'tool-result' },
      'part-1',
    );
    const html = renderToStaticMarkup(part);

    expect(html).toContain('<details');
    expect(html).not.toContain('tail-marker');

    act(() => root.render(part));
    act(() => {
      const details = container.querySelector('details') as HTMLDetailsElement;
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });

    expect(container.querySelector('code')?.textContent).toBe(output);
    expect(
      container.querySelector(
        'button[aria-label="Copy read-diff tool details"]',
      ),
    ).not.toBeNull();
  });
});
