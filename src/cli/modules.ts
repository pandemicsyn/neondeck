export async function configActionsModule() {
  return import(
    new URL('../modules/config/index.ts', import.meta.url).href
  ) as Promise<typeof import('../modules/config')>;
}

export async function githubModule() {
  return import(
    new URL('../modules/github/index.ts', import.meta.url).href
  ) as Promise<typeof import('../modules/github')>;
}

export async function handoffModule() {
  return import(
    new URL('../modules/handoff/index.ts', import.meta.url).href
  ) as Promise<typeof import('../modules/handoff')>;
}

export async function devDoctorModule() {
  return import(
    new URL('../modules/runtime/index.ts', import.meta.url).href
  ) as Promise<typeof import('../modules/runtime')>;
}

export async function appDbModule() {
  return import(
    new URL('../runtime-home/app-db/migrate.ts', import.meta.url).href
  ) as Promise<typeof import('../runtime-home/app-db/migrate')>;
}

export async function learningOperatorModule() {
  return import(
    new URL('../modules/learning/index.ts', import.meta.url).href
  ) as Promise<typeof import('../modules/learning')>;
}

export async function openModule() {
  return import(new URL('../desktop/open.ts', import.meta.url).href) as Promise<
    typeof import('../desktop/open')
  >;
}

export async function memoryActionsModule() {
  return import(
    new URL('../modules/memory/index.ts', import.meta.url).href
  ) as Promise<typeof import('../modules/memory')>;
}

export async function mcpModule() {
  return import(
    new URL('../domains/mcp/index.ts', import.meta.url).href
  ) as Promise<typeof import('../domains/mcp')>;
}

export async function modelDiscoveryModule() {
  return import(
    new URL('../modules/repos/index.ts', import.meta.url).href
  ) as Promise<typeof import('../modules/repos')>;
}

export async function reposModule() {
  return import(
    new URL('../modules/repos/index.ts', import.meta.url).href
  ) as Promise<typeof import('../modules/repos')>;
}

export async function repoEditModule() {
  return import(
    new URL('../repo-edit/index.ts', import.meta.url).href
  ) as Promise<typeof import('../repo-edit')>;
}

export async function runtimeHomeModule() {
  return import(
    new URL('../runtime-home/index.ts', import.meta.url).href
  ) as Promise<typeof import('../runtime-home')>;
}

export async function runtimeStatusModule() {
  return import(
    new URL('../modules/runtime/index.ts', import.meta.url).href
  ) as Promise<typeof import('../modules/runtime')>;
}

export async function serverModule() {
  return import(new URL('../server/serve.ts', import.meta.url).href) as Promise<
    typeof import('../server/serve')
  >;
}

export async function schedulerModule() {
  return import(
    new URL('../modules/scheduler/index.ts', import.meta.url).href
  ) as Promise<typeof import('../modules/scheduler')>;
}

export async function serviceModule() {
  return import(
    new URL('../desktop/service.ts', import.meta.url).href
  ) as Promise<typeof import('../desktop/service')>;
}

export async function skillPatchesModule() {
  return import(
    new URL('../modules/learning/skill-patches/index.ts', import.meta.url).href
  ) as Promise<typeof import('../modules/learning/skill-patches')>;
}

export async function watchActionsModule() {
  return import(
    new URL('../modules/watches/index.ts', import.meta.url).href
  ) as Promise<typeof import('../modules/watches')>;
}
