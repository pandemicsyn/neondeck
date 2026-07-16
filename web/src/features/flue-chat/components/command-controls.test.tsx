import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CommandTypeahead } from './command-controls';

describe('CommandTypeahead accessibility', () => {
  it('exposes the command menu as a selectable listbox', () => {
    const commands = [
      { command: '/review-pr', label: 'Review PR' },
      { command: '/briefing', label: 'Briefing' },
    ];
    const html = renderToStaticMarkup(
      <CommandTypeahead
        activeCommand={commands[1]}
        activeCommandIndex={1}
        commands={commands}
        id="command-menu"
        onSelect={vi.fn<(command: (typeof commands)[number]) => void>()}
        open
      />,
    );

    expect(html).toContain('id="command-menu"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('id="command-menu-option-1"');
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
  });
});
