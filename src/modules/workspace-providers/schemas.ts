import type { Sandbox, SandboxFactory } from '@flue/runtime';
import { sanitizeExecutionText } from '../execution/utils';

export type WorkspaceProviderLocation = 'local' | 'remote';
export type WorkspaceResourceLifecycle = 'per-run' | 'reuse-task' | 'existing';

export type WorkspaceProviderDescriptor = {
  id: string;
  label: string;
  location: WorkspaceProviderLocation;
  capabilities: {
    provision: boolean;
    attachExisting: boolean;
    persistentResources: boolean;
    snapshots: boolean;
    commandCancellation: 'native' | 'orphan-possible';
  };
};

export type WorkspaceResource = {
  providerId: string;
  externalId: string;
  root: string;
  metadata: Record<string, unknown>;
};

export type WorkspaceProviderSnapshot =
  | { version: 1; providerId: 'local'; driver: 'local' }
  | {
      version: 1;
      providerId: string;
      driver: 'exe.dev';
      config: Extract<
        import('../../runtime-home').WorkspaceProviderConfig,
        { driver: 'exe.dev' }
      >;
    }
  | {
      version: 1;
      providerId: string;
      driver: 'ssh';
      config: Extract<
        import('../../runtime-home').WorkspaceProviderConfig,
        { driver: 'ssh' }
      >;
    };

export type WorkspaceDestroyContext = {
  signal?: AbortSignal;
  assertLease(): void;
};

export type WorkspaceSandboxContext = {
  onTransportCloseError?(message: string): Promise<void> | void;
  onOperationUncertain?(
    error: WorkspaceOperationUncertainError,
  ): Promise<void> | void;
};

export type ProviderValidation = { ok: true } | { ok: false; issues: string[] };

export type ProviderReadiness = {
  ready: boolean;
  message: string;
  missingEnvironment: string[];
};

export type ProviderReadinessContext = {
  lifecycle?: WorkspaceResourceLifecycle;
};

export type ProviderResourceStatus = {
  status: 'ready' | 'missing' | 'unavailable';
  message: string;
};

export type ProvisionWorkspaceInput = {
  resourceId: string;
  lifecycle: Exclude<WorkspaceResourceLifecycle, 'existing'>;
};

export type AttachWorkspaceInput = {
  externalId: string;
  root?: string;
  /** Application-only escape hatch for approved commands targeting the provider root. */
  allowProviderRoot?: boolean;
  /** Separates the credential-isolated HOME identity from the selected resource. */
  privateHomeIdentity?: string;
};

export type WorkspaceConnection = {
  env: Sandbox;
  close(): Promise<void>;
};

export interface WorkspaceProvider {
  readonly descriptor: WorkspaceProviderDescriptor;
  validateConfig(): ProviderValidation;
  readiness(context?: ProviderReadinessContext): Promise<ProviderReadiness>;
  planProvision(input: ProvisionWorkspaceInput): WorkspaceResource;
  provision(input: ProvisionWorkspaceInput): Promise<WorkspaceResource>;
  attach(input: AttachWorkspaceInput): Promise<WorkspaceResource>;
  connect(resource: WorkspaceResource): Promise<WorkspaceConnection>;
  sandbox(
    resource: WorkspaceResource,
    context?: WorkspaceSandboxContext,
  ): SandboxFactory;
  inspect(resource: WorkspaceResource): Promise<ProviderResourceStatus>;
  destroy(
    resource: WorkspaceResource,
    context?: WorkspaceDestroyContext,
  ): Promise<void>;
}

export class WorkspaceProviderError extends Error {
  override name = 'WorkspaceProviderError';

  constructor(
    readonly code:
      | 'unknown-provider'
      | 'invalid-config'
      | 'not-ready'
      | 'unsupported-capability'
      | 'resource-unavailable'
      | 'provider-operation-failed',
    message: string,
    readonly providerId?: string,
  ) {
    super(sanitizeExecutionText(message, 16 * 1024).content);
  }
}

export type WorkspaceOperationUncertainty = {
  kind: 'abort' | 'timeout' | 'output-limit' | 'transport' | 'authority-loss';
  operation: string;
  message: string;
};

export class WorkspaceOperationUncertainError extends WorkspaceProviderError {
  override name = 'WorkspaceOperationUncertainError';

  constructor(
    readonly uncertainty: WorkspaceOperationUncertainty,
    providerId?: string,
  ) {
    super('provider-operation-failed', uncertainty.message, providerId);
  }
}

export function isWorkspaceOperationUncertainError(
  error: unknown,
): error is WorkspaceOperationUncertainError {
  return error instanceof WorkspaceOperationUncertainError;
}
