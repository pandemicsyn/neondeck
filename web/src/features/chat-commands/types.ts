export type ChatSlashCommandScope = 'main' | 'pr-reviewer';

export type ChatSlashCommandDispatch =
  | { kind: 'app-command' }
  | { kind: 'agent-message'; intent: string }
  | { kind: 'surface-action'; action: string };

export type ChatSlashCommand = {
  aliases?: readonly string[];
  completion?: string;
  description: string;
  dispatch: ChatSlashCommandDispatch;
  label: string;
  name: string;
  scope: ChatSlashCommandScope;
  usage: string;
};

export function slashCommandToken(command: ChatSlashCommand) {
  return `/${command.name}`;
}

export function slashCommandDisplay(command: ChatSlashCommand) {
  return command.completion ?? slashCommandToken(command);
}

export function slashCommandTokens(command: ChatSlashCommand) {
  return [command.name, ...(command.aliases ?? [])].map(
    (name) => `/${name.toLowerCase()}`,
  );
}
