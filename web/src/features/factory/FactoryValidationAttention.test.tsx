// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryValidationAttention } from './FactoryValidationAttention';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(
  overrides: Partial<ComponentProps<typeof FactoryValidationAttention>> = {},
) {
  const props: ComponentProps<typeof FactoryValidationAttention> = {
    attention: {
      blocker: 'policy-changed',
      message: 'Approved validation settings or release authority changed.',
      observedAt: '2026-09-01T00:00:00.000Z',
      nextAction: 'review-plan',
    },
    runId: 'run-demo',
    releaseId: 'release-demo',
    workId: 'work/demo',
    canRetry: true,
    pending: false,
    stale: false,
    onRetry: vi.fn<() => void>(),
    ...overrides,
  };
  act(() => root.render(<FactoryValidationAttention {...props} />));
  return props;
}

it('offers explicit plan discussion for retained attention without a reason code', () => {
  const onDiscuss = vi.fn<(message: string) => void>();
  const props = render({ onDiscuss });
  expect(onDiscuss).not.toHaveBeenCalled();
  const button = container.querySelector('button')!;
  expect(button.textContent).toBe('Review validation with Neon');
  expect(button.disabled).toBe(false);
  act(() => button.click());
  expect(onDiscuss).toHaveBeenCalledExactlyOnceWith(
    `Validation admission needs a plan review: ${props.attention.message}`,
  );
  expect(props.onRetry).not.toHaveBeenCalled();
  expect(container.querySelector('a')).toBeNull();
});

it('falls back to task planning for retained attention without a reason code or discussion callback', () => {
  const props = render();
  const link = container.querySelector('a')!;
  expect(link.textContent).toBe('Open task planning');
  expect(link.getAttribute('href')).toBe('/factory?task=work%2Fdemo');
  expect(container.querySelector('button')).toBeNull();
  expect(props.onRetry).not.toHaveBeenCalled();
});

it.each(['pending', 'stale'] as const)(
  'keeps retained plan discussion disabled while %s',
  (state) => {
    const onDiscuss = vi.fn<(message: string) => void>();
    const props = render({ onDiscuss, [state]: true });
    const button = container.querySelector('button')!;
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(onDiscuss).not.toHaveBeenCalled();
    expect(props.onRetry).not.toHaveBeenCalled();
  },
);
