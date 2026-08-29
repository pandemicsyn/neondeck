import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SlashCommandTypeahead } from '../../chat-commands/SlashCommandTypeahead';
import type { ChatSlashCommand } from '../../chat-commands/types';

describe('SlashCommandTypeahead accessibility', () => {
  it('exposes the command menu as a selectable listbox', () => {
    const commands: ChatSlashCommand[] = [
      command('review-pr', 'Review PR'),
      command('briefing', 'Briefing'),
    ];
    const html = renderToStaticMarkup(
      <SlashCommandTypeahead
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

function command(name: string, label: string): ChatSlashCommand {
  return {
    description: label,
    dispatch: { kind: 'app-command' },
    label,
    name,
    scope: 'main',
    usage: `/${name}`,
  };
}
