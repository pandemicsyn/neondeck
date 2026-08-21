export async function configActionsModule() {
  return import('../modules/config/index.ts');
}

export async function githubModule() {
  return import('../modules/github/index.ts');
}

export async function handoffModule() {
  return import('../modules/handoff/index.ts');
}

export async function devDoctorModule() {
  return import('../modules/runtime/index.ts');
}

export async function appDbModule() {
  return import('../runtime-home/app-db/migrate.ts');
}

export async function autopilotModule() {
  return import('../modules/autopilot/index.ts');
}

export async function learningOperatorModule() {
  return import('../modules/learning/index.ts');
}

export async function openModule() {
  return import('../desktop/open.ts');
}

export async function memoryActionsModule() {
  return import('../modules/memory/index.ts');
}

export async function mcpModule() {
  return import('../domains/mcp/index.ts');
}

export async function modelDiscoveryModule() {
  return import('../modules/repos/index.ts');
}

export async function reposModule() {
  return import('../modules/repos/index.ts');
}

export async function repoEditModule() {
  return import('../repo-edit/index.ts');
}

export async function runtimeHomeModule() {
  return import('../runtime-home/index.ts');
}

export async function runtimeStatusModule() {
  return import('../modules/runtime/index.ts');
}

export async function serverModule() {
  return import('../server/serve.ts');
}

export async function sessionsModule() {
  return import('../modules/sessions/index.ts');
}

export async function serviceModule() {
  return import('../desktop/service.ts');
}

export async function skillPatchesModule() {
  return import('../modules/learning/skill-patches/index.ts');
}

export async function watchActionsModule() {
  return import('../modules/watches/index.ts');
}
