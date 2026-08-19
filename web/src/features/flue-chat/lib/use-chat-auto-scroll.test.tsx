// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useChatAutoScroll } from './use-chat-auto-scroll';

function AutoScrollHarness({
  content,
  sessionId,
}: {
  content: string;
  sessionId: string;
}) {
  const autoScroll = useChatAutoScroll(sessionId);
  const [renderCount, setRenderCount] = useState(0);

  return (
    <>
      <div
        data-testid="transcript"
        onScroll={autoScroll.handleScroll}
        ref={autoScroll.transcriptRef}
      >
        {content} · {renderCount}
      </div>
      {!autoScroll.followsLatest ? (
        <button
          aria-label={
            autoScroll.hasNewActivity ? 'New activity' : 'Jump to latest'
          }
          onClick={autoScroll.jumpToLatest}
          type="button"
        >
          Latest
        </button>
      ) : null}
      <button
        aria-label="Stream content"
        onClick={() => setRenderCount((count) => count + 1)}
        type="button"
      >
        Stream content
      </button>
    </>
  );
}

describe('useChatAutoScroll', () => {
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

  it('follows content mutations while the transcript is at the bottom', async () => {
    render('Initial', 'session-1');
    const transcript = getTranscript();
    setTranscriptGeometry(transcript, { clientHeight: 100, scrollHeight: 400 });

    await click('Stream content');

    expect(transcript.scrollTop).toBe(400);
    expect(button('Jump to latest')).toBeNull();
  });

  it('preserves manual scrollback and flags content arriving offscreen', async () => {
    render('Initial', 'session-1');
    const transcript = getTranscript();
    setTranscriptGeometry(transcript, { clientHeight: 100, scrollHeight: 500 });
    transcript.scrollTop = 100;
    act(() => transcript.dispatchEvent(new Event('scroll', { bubbles: true })));

    expect(button('Jump to latest')).not.toBeNull();

    setTranscriptGeometry(transcript, { clientHeight: 100, scrollHeight: 600 });
    await click('Stream content');

    expect(button('New activity')).not.toBeNull();
    expect(transcript.scrollTop).toBe(100);

    await click('New activity');
    expect(transcript.scrollTop).toBe(600);
    expect(button('New activity')).toBeNull();
  });

  it('returns to the bottom when the active session changes', () => {
    render('Initial', 'session-1');
    const transcript = getTranscript();
    setTranscriptGeometry(transcript, { clientHeight: 100, scrollHeight: 500 });
    transcript.scrollTop = 100;
    act(() => transcript.dispatchEvent(new Event('scroll', { bubbles: true })));

    setTranscriptGeometry(transcript, { clientHeight: 100, scrollHeight: 700 });
    render('Other', 'session-2');

    expect(transcript.scrollTop).toBe(700);
    expect(button('Jump to latest')).toBeNull();
  });

  function render(content: string, sessionId: string) {
    act(() =>
      root.render(
        <AutoScrollHarness content={content} sessionId={sessionId} />,
      ),
    );
  }

  async function click(label: string) {
    const target = button(label);
    if (!target) throw new Error(`Missing button: ${label}`);
    await act(async () => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
  }

  function button(label: string) {
    return container.querySelector(`button[aria-label="${label}"]`);
  }

  function getTranscript() {
    return container.querySelector(
      '[data-testid="transcript"]',
    ) as HTMLDivElement;
  }
});

function setTranscriptGeometry(
  transcript: HTMLElement,
  {
    clientHeight,
    scrollHeight,
  }: { clientHeight: number; scrollHeight: number },
) {
  Object.defineProperties(transcript, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
  });
}
