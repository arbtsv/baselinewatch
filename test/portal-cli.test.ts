// Tests for the demo portal launch interface: flag parsing and process exit codes.
// Run: node --test test/portal-cli.test.ts
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPortalModule, runPortalCli, startPortal } from './helpers/portal.ts';
import type { PortalModule } from './helpers/portal.ts';

describe('parseCli', () => {
  let portalModule: PortalModule;
  before(async () => {
    portalModule = await loadPortalModule();
  });

  const valid: Array<[string, string[], { port: number; mode: string }]> = [
    ['separate values', ['--port', '0', '--mode', 'ok'], { port: 0, mode: 'ok' }],
    ['equals form', ['--port=4101', '--mode=broken'], { port: 4101, mode: 'broken' }],
    ['the highest port', ['--port', '65535', '--mode', 'slowOnce'], { port: 65535, mode: 'slowOnce' }],
    ['slowAlways', ['--port', '1', '--mode', 'slowAlways'], { port: 1, mode: 'slowAlways' }],
    ['loginError', ['--port', '8080', '--mode', 'loginError'], { port: 8080, mode: 'loginError' }],
  ];
  for (const [name, argv, expected] of valid) {
    test(`accepts ${name}`, () => {
      assert.deepEqual(portalModule.parseCli(argv), expected);
    });
  }

  const badPorts: Array<[string, string[]]> = [
    ['a negative port', ['--port', '-1', '--mode', 'ok']],
    ['a port above 65535', ['--port', '65536', '--mode', 'ok']],
    ['a fractional port', ['--port', '1.5', '--mode', 'ok']],
    ['a non-numeric port', ['--port', 'abc', '--mode', 'ok']],
    ['an empty port', ['--port', '', '--mode', 'ok']],
    ['a negative port in equals form', ['--port=-1', '--mode', 'ok']],
    ['a port flag without a value', ['--mode', 'ok', '--port']],
    ['a missing port', ['--mode', 'ok']],
  ];
  for (const [name, argv] of badPorts) {
    test(`rejects ${name}`, () => {
      assert.throws(() => portalModule.parseCli(argv), /invalid --port/);
    });
  }

  const badModes: Array<[string, string[]]> = [
    ['an upper-cased mode', ['--port', '0', '--mode', 'OK']],
    ['an unknown mode', ['--port', '0', '--mode', 'fast']],
    ['an empty mode', ['--port', '0', '--mode', '']],
    ['a missing mode', ['--port', '0']],
  ];
  for (const [name, argv] of badModes) {
    test(`rejects ${name}`, () => {
      assert.throws(() => portalModule.parseCli(argv), /invalid --mode/);
    });
  }

  test('rejects an unknown flag and names it', () => {
    assert.throws(() => portalModule.parseCli(['--port', '0', '--mode', 'ok', '--verbose']), /--verbose/);
  });
});

describe('process exit codes', () => {
  test('a bad port exits with 2 and names the flag', () => {
    const result = runPortalCli(['--port', '99999', '--mode', 'ok']);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /invalid --port/);
    assert.equal(result.stdout, '');
  });

  test('a bad mode exits with 2 and names the flag', () => {
    const result = runPortalCli(['--port', '0', '--mode', 'fast']);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /invalid --mode/);
  });

  test('an unknown flag exits with 2', () => {
    const result = runPortalCli(['--port', '0', '--mode', 'ok', '--verbose']);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--verbose/);
  });

  test('no arguments exit with 2', () => {
    const result = runPortalCli([]);
    assert.equal(result.status, 2, result.stderr);
  });

  test('a port that is already in use exits with 1 and says it cannot listen', async () => {
    const portal = await startPortal('ok');
    try {
      const result = runPortalCli(['--port', String(portal.port), '--mode', 'ok']);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /cannot listen/);
    } finally {
      await portal.stop();
    }
  });

  test('a good launch reports the real port and the mode', async () => {
    const portal = await startPortal('slowOnce');
    try {
      assert.ok(portal.port > 0);
      assert.equal(portal.mode, 'slowOnce');
      assert.equal(portal.url, `http://127.0.0.1:${portal.port}/`);
    } finally {
      await portal.stop();
    }
  });
});
