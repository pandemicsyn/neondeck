export type RuntimeStatus = Awaited<
  ReturnType<(typeof import('../modules/runtime'))['readRuntimeStatus']>
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
  from?: string;
  json?: boolean;
};

export type HandoffNoteOptions = {
  repo?: string;
  pr?: string;
  level?: string;
  from?: string;
  json?: boolean;
};

export type RegisterPrOptions = {
  review?: boolean;
  watch?: boolean;
  note?: string;
  from?: string;
  json?: boolean;
};

export type ServeOptions = {
  port?: string;
};

export type ServiceInstallOptions = {
  port?: string;
};

export type OpenOptions = {
  port?: string;
  width?: string;
  height?: string;
  x?: string;
  y?: string;
  kiosk?: boolean;
  browser?: string;
};
