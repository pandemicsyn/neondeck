import { describe, expect, it } from 'vitest';
import {
  parseLaunchdPlist,
  parseSystemdUnit,
  renderLaunchdPlist,
  renderSystemdUnit,
  servicePaths,
} from './service';
import { runtimePaths } from '../runtime-home';

const definition = {
  nodePath: '/Users/tester/.fnm/node-versions/v26.4.0/bin/node',
  serverEntry: '/Users/tester/neondeck dist/dist/server.mjs',
  runtimeHome: '/Users/tester/.config/neondeck',
  logPath: '/Users/tester/.config/neondeck/data/logs/server.log',
  port: 3599,
  workingDirectory: '/Users/tester/neondeck dist',
};

describe('desktop service renderers', () => {
  it('renders a launchd plist with absolute executable, env, logs, and keepalive', () => {
    const plist = renderLaunchdPlist(definition);

    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>dev.neondeck.server</string>');
    expect(plist).toContain(`<string>${definition.nodePath}</string>`);
    expect(plist).toContain(`<string>${definition.serverEntry}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain(`<string>${definition.logPath}</string>`);
    expect(parseLaunchdPlist(plist)).toEqual({
      nodePath: definition.nodePath,
      serverEntry: definition.serverEntry,
      port: '3599',
      logPath: definition.logPath,
    });
  });

  it('renders a systemd user unit with quoted paths, restart policy, and env', () => {
    const unit = renderSystemdUnit(definition);

    expect(unit).toContain('[Unit]');
    expect(unit).toContain(
      `ExecStart="${definition.nodePath}" "${definition.serverEntry}"`,
    );
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain(
      `Environment="NEONDECK_HOME=${definition.runtimeHome}"`,
    );
    expect(unit).toContain(`StandardOutput=append:${definition.logPath}`);
    expect(parseSystemdUnit(unit)).toEqual({
      nodePath: definition.nodePath,
      serverEntry: definition.serverEntry,
      port: '3599',
      logPath: definition.logPath,
    });
  });

  it('resolves platform-specific service paths without using runtime home for unit files', () => {
    const paths = runtimePaths('/tmp/neondeck-home');

    expect(
      servicePaths(paths, {
        platform: 'darwin',
        homeDirectory: '/Users/tester',
      }).unitPath,
    ).toBe('/Users/tester/Library/LaunchAgents/dev.neondeck.server.plist');

    expect(
      servicePaths(paths, {
        platform: 'linux',
        homeDirectory: '/home/tester',
      }).unitPath,
    ).toBe('/home/tester/.config/systemd/user/neondeck.service');
  });
});
