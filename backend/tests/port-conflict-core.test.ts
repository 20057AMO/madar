/**
 * port-conflict-core.test.ts
 * Pure unit coverage for Docker port-conflict classification. No server, no
 * Docker — fully offline, mirroring serve-core.test.ts / alerts-core tests.
 */
import fs from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { isPortConflictError, PORTS_IN_USE_MESSAGE } from '../src/services/port-conflict-core.ts';

const readSource = (relative: string) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

const CONFLICT_PHRASES = [
  'port is already allocated',
  'Only one usage of each socket address',
  'Address already in use',
  'EADDRINUSE',
];

describe('isPortConflictError', () => {
  test('every supported Docker/Node phrase is a conflict', () => {
    for (const phrase of CONFLICT_PHRASES) {
      assert.strictEqual(isPortConflictError(`(HTTP code 500) server error - ${phrase}`), true, phrase);
    }
  });

  test('matching is case-insensitive', () => {
    assert.strictEqual(isPortConflictError('PORT IS ALREADY ALLOCATED'), true);
    assert.strictEqual(isPortConflictError('AdDrEsS AlReAdY In UsE'), true);
    assert.strictEqual(isPortConflictError('eaddrinuse'), true);
  });

  test('whitespace is normalized before matching', () => {
    assert.strictEqual(isPortConflictError('port   is\nalready\tallocated'), true);
    assert.strictEqual(isPortConflictError('  Only   one  usage of each socket address  '), true);
  });

  test('the original Linux phrase is still classified as a conflict', () => {
    assert.strictEqual(isPortConflictError('port is already allocated'), true);
  });

  test('the exact raw Docker Desktop bind error is a conflict', () => {
    const raw = 'ports are not available: exposing port TCP 0.0.0.0:59994 -> 127.0.0.1:0: listen tcp4 0.0.0.0:59994: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.';
    assert.strictEqual(isPortConflictError(raw), true);
  });

  test('a non-conflict publish error is not a conflict even with the Docker preamble', () => {
    assert.strictEqual(
      isPortConflictError('ports are not available: exposing port TCP 0.0.0.0:8080: bind: permission denied'),
      false,
    );
  });

  test('null, undefined, primitives, objects and junk return false without throwing', () => {
    const junk: unknown[] = [null, undefined, 42, true, {}, [], { message: 'port is already allocated' }, '', '   ', Symbol('port is already allocated')];
    for (const value of junk) {
      assert.doesNotThrow(() => isPortConflictError(value));
      assert.strictEqual(isPortConflictError(value), false);
    }
  });

  test('unrelated Docker errors and partial words return false', () => {
    const unrelated = [
      'no such container: abc',
      'Error response from daemon: permission denied while trying to connect to the Docker daemon socket',
      'port',
      'address',
      'XEADDRINUSEY',
      'listen tcp4 0.0.0.0:1234: bind: permission denied',
    ];
    for (const value of unrelated) {
      assert.strictEqual(isPortConflictError(value), false, value);
    }
  });
});

describe('PORTS_IN_USE_MESSAGE', () => {
  test('is the exact shared 409 message', () => {
    assert.strictEqual(PORTS_IN_USE_MESSAGE, 'One or more requested ports are already in use by another project or service.');
  });
});

describe('port conflict 409 wiring — offline contract', () => {
  test('createProject maps a classified start error to HttpError(409, PORTS_IN_USE_MESSAGE)', () => {
    const dmSrc = readSource('../src/services/docker-manager.ts');
    const start = dmSrc.indexOf('export async function createProject(');
    const end = dmSrc.indexOf('export async function listProjects(', start);
    assert.ok(start >= 0 && end > start, 'createProject source must be present');
    const body = dmSrc.slice(start, end);
    const startAt = body.indexOf('await container.start()');
    assert.ok(startAt >= 0, 'createProject must start the container');
    const branchEnd = body.indexOf('const createdAt', startAt);
    assert.ok(branchEnd > startAt, 'start-error branch must be present');
    const branch = body.slice(startAt, branchEnd);
    assert.match(branch, /catch \(err: any\)/);
    assert.match(branch, /isPortConflictError\(err\?\.message\)/);
    assert.match(branch, /throw new HttpError\(409, PORTS_IN_USE_MESSAGE\)/);
    assert.match(branch, /throw err/);
  });

  test('the create router translates err.statusCode into the HTTP status', () => {
    const indexSrc = readSource('../src/index.ts');
    const createAt = indexSrc.indexOf("app.post('/api/projects'");
    assert.ok(createAt >= 0, 'create router must be present');
    const end = indexSrc.indexOf('// Duplicate an existing project', createAt);
    assert.ok(end > createAt, 'create router block must be bounded');
    const body = indexSrc.slice(createAt, end);
    assert.match(body, /catch \(err: any\)/);
    assert.match(body, /res\.status\(err\.statusCode \|\| 500\)/);
  });
});
