// @vitest-environment jsdom

import type { FlueConversationMessage } from '@flue/react';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionTimelineItems } from '../lib/timeline';
import { ChatTimelineItems } from './chat-timeline';
import { renderMessagePart } from './message-parts';

vi.mock('./message-parts', () => ({
  ChatPartEvent: () => <span>empty</span>,
  renderMessagePart: vi.fn<(part: { text?: string }, key: string) => ReactNode>(
    (part: { text?: string }, key: string): ReactNode => (
      <span key={key}>{part.text}</span>
    ),
  ),
}));

const renderMessagePartMock = vi.mocked(renderMessagePart);

describe('ChatTimelineItems', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    renderMessagePartMock.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps stable messages out of unrelated parent renders', () => {
    const firstMessages = [message('first'), message('second')];
    const firstItems = sessionTimelineItems(firstMessages, []);

    render(firstItems);
    expect(renderMessagePartMock).toHaveBeenCalledTimes(2);

    render(firstItems);
    expect(renderMessagePartMock).toHaveBeenCalledTimes(2);

    render(sessionTimelineItems([...firstMessages, message('third')], []));
    expect(renderMessagePartMock).toHaveBeenCalledTimes(3);
  });

  function render(items: ReturnType<typeof sessionTimelineItems>) {
    act(() => root.render(<ChatTimelineItems hasSession items={items} />));
  }
});

function message(id: string): FlueConversationMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', state: 'done', text: id }],
  };
}
