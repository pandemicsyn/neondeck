import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import {
  clampSlashCommandIndex,
  filterSlashCommands,
  slashCommandCompletion,
  slashCommandMenuKeyAction,
  slashCommandQueryFromInput,
} from './commands';
import type { ChatSlashCommand } from './types';

export function useSlashCommandMenu({
  commands,
  enabled = true,
  input,
  maxVisible = 6,
  onComplete,
}: {
  commands: readonly ChatSlashCommand[];
  enabled?: boolean;
  input: string;
  maxVisible?: number;
  onComplete: (input: string) => void;
}) {
  const id = useId();
  const [requestedIndex, setRequestedIndex] = useState(0);
  const [dismissedInput, setDismissedInput] = useState('');
  const query = enabled ? slashCommandQueryFromInput(input) : undefined;
  const matchingCommands = useMemo(
    () => filterSlashCommands(commands, query),
    [commands, query],
  );
  const visibleCommands = matchingCommands.slice(0, maxVisible);
  const open =
    query !== undefined &&
    dismissedInput !== input &&
    visibleCommands.length > 0;
  const activeIndex = clampSlashCommandIndex(
    requestedIndex,
    visibleCommands.length,
  );
  const activeCommand = visibleCommands[activeIndex];

  useEffect(() => setRequestedIndex(0), [query]);

  function complete(command: ChatSlashCommand) {
    onComplete(slashCommandCompletion(command));
    setDismissedInput('');
  }

  function resetDismissal() {
    setDismissedInput('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return false;
    const action = slashCommandMenuKeyAction({
      activeCommand,
      input,
      key: event.key,
      menuOpen: open,
      shiftKey: event.shiftKey,
    });
    if (!action) return false;
    event.preventDefault();
    if (action === 'complete') complete(activeCommand!);
    if (action === 'dismiss') setDismissedInput(input);
    if (action === 'next') {
      setRequestedIndex((activeIndex + 1) % visibleCommands.length);
    }
    if (action === 'previous') {
      setRequestedIndex(
        (activeIndex - 1 + visibleCommands.length) % visibleCommands.length,
      );
    }
    return true;
  }

  return {
    activeCommand,
    activeIndex,
    activeOptionId: open ? `${id}-option-${activeIndex}` : undefined,
    complete,
    handleKeyDown,
    id,
    open,
    resetDismissal,
    visibleCommands,
  };
}
