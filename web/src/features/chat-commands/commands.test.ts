import { describe, expect, it } from 'vitest';
import {
  filterSlashCommands,
  slashCommandCompletion,
  slashCommandMenuKeyAction,
  slashCommandQueryFromInput,
} from './commands';
import type { ChatSlashCommand } from './types';

const showMe: ChatSlashCommand = {
  aliases: ['tour'],
  description: 'trace a flow as a guided tour',
  dispatch: { kind: 'agent-message', intent: 'guided-explanation' },
  label: 'Guided explanation',
  name: 'show-me',
  scope: 'pr-reviewer',
  usage: '/show-me <flow>',
};

describe('shared slash-command interaction', () => {
  it('opens only for a command token without arguments', () => {
    expect(slashCommandQueryFromInput('/')).toBe('');
    expect(slashCommandQueryFromInput(' /sho')).toBe('sho');
    expect(slashCommandQueryFromInput('/show-me auth')).toBeUndefined();
    expect(slashCommandQueryFromInput('explain this')).toBeUndefined();
  });

  it('filters by name, alias, label, and description', () => {
    expect(filterSlashCommands([showMe], 'show')).toEqual([showMe]);
    expect(filterSlashCommands([showMe], 'tour')).toEqual([showMe]);
    expect(filterSlashCommands([showMe], 'guided')).toEqual([showMe]);
    expect(filterSlashCommands([showMe], 'trace')).toEqual([showMe]);
  });

  it('maps shared keyboard behavior without completing exact commands', () => {
    const input = '/sho';
    const menu = { activeCommand: showMe, input, menuOpen: true };
    expect(slashCommandMenuKeyAction({ ...menu, key: 'ArrowDown' })).toBe(
      'next',
    );
    expect(slashCommandMenuKeyAction({ ...menu, key: 'ArrowUp' })).toBe(
      'previous',
    );
    expect(slashCommandMenuKeyAction({ ...menu, key: 'Tab' })).toBe('complete');
    expect(slashCommandMenuKeyAction({ ...menu, key: 'Enter' })).toBe(
      'complete',
    );
    expect(
      slashCommandMenuKeyAction({ ...menu, input: '/show-me', key: 'Enter' }),
    ).toBeNull();
    expect(slashCommandMenuKeyAction({ ...menu, key: 'Escape' })).toBe(
      'dismiss',
    );
  });

  it('preserves an explicit configured completion', () => {
    const configured = {
      ...showMe,
      completion: '/show-me src/cache.ts',
    };
    expect(slashCommandCompletion(configured)).toBe('/show-me src/cache.ts ');
    expect(
      slashCommandMenuKeyAction({
        activeCommand: configured,
        input: '/show-me',
        key: 'Enter',
        menuOpen: true,
      }),
    ).toBe('complete');
  });
});
