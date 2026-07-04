export type RuntimeStatus = Awaited<
  ReturnType<(typeof import('../runtime-status'))['readRuntimeStatus']>
>;

export type EnvMap = Map<string, string>;

export type GlobalOptions = {
  home?: string;
  json?: boolean;
};

export type RepoAddOptions = {
  id?: string;
  githubOwner?: string;
  githubName?: string;
  defaultBranch?: string;
  productionTarget?: string;
};

export type WatchPrOptions = {
  until?: string;
  interval?: string;
};

export type ScheduleOptions = {
  morningBriefing?: boolean;
  reviewQueueDigest?: boolean;
  interval?: string;
};
