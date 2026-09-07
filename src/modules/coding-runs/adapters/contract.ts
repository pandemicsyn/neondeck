import type * as v from 'valibot';
import type {
  CodingAdapterId,
  CodingAdapterCapabilities,
} from '../../../../shared/coding-adapters.ts';
import type {
  LocalManifest,
  PrepareLocalAttemptInput,
} from '../host-contract.ts';
export type LocalConfig = PrepareLocalAttemptInput['config'];
export type SelectedAuth = NonNullable<
  PrepareLocalAttemptInput['selectedAuth']
>;
export interface CodingAdapterEvents {
  readonly sessionId: string | null;
  readonly terminal: 'completed' | 'failed' | null;
  accept(line: string): void;
}
export type CodingAdapterEnvironmentRule =
  | { key: string; kind: 'literal'; value: string }
  | { key: string; kind: 'private-path'; path: string }
  | { key: string; kind: 'test-scenario' }
  | { key: string; kind: 'json'; schema: v.GenericSchema };
export interface CodingAdapter {
  readonly id: CodingAdapterId;
  readonly contractVersion: 1;
  readonly label: string;
  readonly environmentRules?: readonly CodingAdapterEnvironmentRule[];
  readonly supportedPlatforms?: readonly NodeJS.Platform[];
  readonly supportedVersion: string;
  readonly credentialKinds: readonly SelectedAuth['kind'][];
  readonly versionArgs: readonly string[];
  readonly capabilities: CodingAdapterCapabilities;
  acceptsVersion(version: string, config: LocalConfig): boolean;
  launch(manifest: LocalManifest): {
    args: string[];
    env: Record<string, string>;
  };
  credentials(
    selected: SelectedAuth | undefined,
    config: LocalConfig,
  ): {
    files: { path: string; content: string }[];
    secrets: string[];
  };
  readonly forbiddenWorkspacePaths?: readonly string[];
  readonly credentialPaths: readonly string[];
  credentialSecrets(contents: readonly string[], config: LocalConfig): string[];
  createEvents(): CodingAdapterEvents;
}
