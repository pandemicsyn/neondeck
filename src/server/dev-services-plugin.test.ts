import { createServer, type Plugin } from 'vite';
import { expect, it } from 'vitest';
import { devServicesPlugin } from './dev-services-plugin';

it('wraps the dev loader with all managed services and survives module invalidation', async () => {
  const mocks: Plugin = {
    name: 'mock-flue-and-services',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'virtual:flue/server') return '\0test:bootstrap';
      if (id.endsWith('/managed-services.ts')) return '\0test:services';
      if (id.endsWith('/runtime-home/index.ts')) return '\0test:paths';
    },
    load(id) {
      if (id === '\0test:bootstrap')
        return `
        export async function loadFlueNodeApplication() {
          return { fetch() {}, stop: async () => {}, closeSync() {}, pauseAdmissions() {}, enterActivity() {} };
        }`;
      if (id === '\0test:services')
        return `
        export const events = [];
        export function startManagedServices(paths, app) {
          events.push('start');
          return async () => { events.push('stop'); };
        }`;
      if (id === '\0test:paths')
        return 'export const runtimePaths = () => ({});';
    },
  };
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [devServicesPlugin(), mocks],
    server: { middlewareMode: true, watch: null, ws: false },
    appType: 'custom',
  });
  try {
    const services = await server.ssrLoadModule('\0test:services');
    const first = await server.ssrLoadModule('virtual:flue/server');
    const app = await first.loadFlueNodeApplication();
    expect(services.events).toEqual(['start']);
    // Flue reloads the bootstrap, then stops the previous application.
    const entry = await server.moduleGraph.getModuleByUrl(
      'virtual:flue/server',
    );
    server.moduleGraph.invalidateModule(entry!);
    const second = await server.ssrLoadModule('virtual:flue/server');
    const next = await second.loadFlueNodeApplication();
    await app.stop();
    expect(services.events).toEqual(['start', 'stop', 'start']);
    await next.stop();
    expect(services.events).toEqual(['start', 'stop', 'start', 'stop']);
  } finally {
    await server.close();
  }
});

it('does not wrap production builds or previews', () => {
  const apply = devServicesPlugin().apply;
  if (typeof apply !== 'function')
    throw new Error('Expected conditional plugin');
  expect(apply({}, { command: 'build', mode: 'production' })).toBe(false);
  expect(
    apply({}, { command: 'serve', mode: 'production', isPreview: true }),
  ).toBe(false);
  expect(apply({}, { command: 'serve', mode: 'development' })).toBe(true);
});
