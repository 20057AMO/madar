/**
 * server-port-core.test.ts
 * Pure unit coverage for the listening-port rules. No server, no Docker —
 * offline like serve-core.test.ts / jwt-secret.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_SERVER_PORT,
  resolveServerPort,
  boundServerPort,
} from '../src/services/server-port-core.ts';

describe('resolveServerPort', () => {
  test('missing or blank PORT keeps the production default', () => {
    assert.strictEqual(resolveServerPort(undefined), DEFAULT_SERVER_PORT);
    assert.strictEqual(resolveServerPort(''), DEFAULT_SERVER_PORT);
    assert.strictEqual(resolveServerPort('   '), DEFAULT_SERVER_PORT);
  });

  test('the explicit string 0 requests an OS-assigned port', () => {
    assert.strictEqual(resolveServerPort('0'), 0);
    assert.strictEqual(resolveServerPort(' 0 '), 0);
  });

  test('valid integers are honored, including the ceiling', () => {
    assert.strictEqual(resolveServerPort('3000'), 3000);
    assert.strictEqual(resolveServerPort('8080'), 8080);
    assert.strictEqual(resolveServerPort('65535'), 65535);
    assert.strictEqual(resolveServerPort('080'), 80);
  });

  test('out-of-range and malformed values fall back without throwing', () => {
    for (const junk of ['65536', '-1', '1.5', 'abc', '1e3', '0x10', 'NaN', 'Infinity', '00']) {
      assert.strictEqual(resolveServerPort(junk), DEFAULT_SERVER_PORT, `PORT=${junk}`);
    }
  });

  test('non-string values fall back without throwing', () => {
    const asUnknown = (value: unknown): string | undefined => value as string | undefined;
    assert.strictEqual(resolveServerPort(asUnknown(null)), DEFAULT_SERVER_PORT);
    assert.strictEqual(resolveServerPort(asUnknown(3000)), DEFAULT_SERVER_PORT);
    assert.strictEqual(resolveServerPort(asUnknown({})), DEFAULT_SERVER_PORT);
  });
});

describe('boundServerPort', () => {
  test('a bound address object reports the real kernel-assigned port', () => {
    assert.strictEqual(boundServerPort({ port: 41023 }, 0), 41023);
    assert.strictEqual(boundServerPort({ port: 3000 }, 0), 3000);
  });

  test('string / null / undefined addresses keep the configured fallback', () => {
    assert.strictEqual(boundServerPort('/tmp/madar.sock', 3000), 3000);
    assert.strictEqual(boundServerPort(null, 3000), 3000);
    assert.strictEqual(boundServerPort(undefined, 3000), 3000);
  });

  test('junk address ports never override the fallback', () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      assert.strictEqual(boundServerPort({ port }, 3000), 3000, `port=${port}`);
    }
  });

  test('the fallback is returned verbatim (including an unresolved ephemeral port)', () => {
    assert.strictEqual(boundServerPort(null, 0), 0);
  });
});
