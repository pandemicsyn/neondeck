export async function configActionsModule() {
  return import(
    new URL('../config-actions.ts', import.meta.url).href
  ) as Promise<typeof import('../config-actions')>;
}

export async function githubModule() {
  return import(new URL('../github.ts', import.meta.url).href) as Promise<
    typeof import('../github')
  >;
}

export async function devDoctorModule() {
  return import(new URL('../dev-doctor.ts', import.meta.url).href) as Promise<
    typeof import('../dev-doctor')
  >;
}

export async function learningOperatorModule() {
  return import(
    new URL('../learning-operator.ts', import.meta.url).href
  ) as Promise<typeof import('../learning-operator')>;
}

export async function memoryActionsModule() {
  return import(
    new URL('../memory-actions.ts', import.meta.url).href
  ) as Promise<typeof import('../memory-actions')>;
}

export async function modelDiscoveryModule() {
  return import(
    new URL('../model-discovery.ts', import.meta.url).href
  ) as Promise<typeof import('../model-discovery')>;
}

export async function reposModule() {
  return import(new URL('../repos.ts', import.meta.url).href) as Promise<
    typeof import('../repos')
  >;
}

export async function repoEditModule() {
  return import(
    new URL('../repo-edit/index.ts', import.meta.url).href
  ) as Promise<typeof import('../repo-edit')>;
}

export async function runtimeHomeModule() {
  return import(new URL('../runtime-home.ts', import.meta.url).href) as Promise<
    typeof import('../runtime-home')
  >;
}

export async function runtimeStatusModule() {
  return import(
    new URL('../runtime-status.ts', import.meta.url).href
  ) as Promise<typeof import('../runtime-status')>;
}

export async function schedulerModule() {
  return import(new URL('../scheduler.ts', import.meta.url).href) as Promise<
    typeof import('../scheduler')
  >;
}

export async function skillPatchesModule() {
  return import(new URL('../skill-patches.ts', import.meta.url).href) as Promise<
    typeof import('../skill-patches')
  >;
}

export async function watchActionsModule() {
  return import(new URL('../watch-actions.ts', import.meta.url).href) as Promise<
    typeof import('../watch-actions')
  >;
}
