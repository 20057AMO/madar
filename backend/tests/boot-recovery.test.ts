/**
 * boot-recovery.test.ts — offline regression guard for boot-time reconciliation
 * of histories left `running` by a crashed server.
 *
 * Both stores reconcile at boot (index.ts) but every history API reads its file
 * fresh, so deleting the reconcile function or unwiring it leaves editors and
 * admins staring at digests/agent runs stuck in `running` forever. This suite
 * drives the REAL reconciler exports against a temp WSD_DATA_DIR (the
 * jwt-secret.test.ts pattern) and separately guards the boot call order.
 *
 * Contract under test:
 *  - a running digest/delegation row becomes failed with `finishedAt` and the
 *    exact restart marker, keeping its identity and stored payload;
 *  - settled rows are byte-unchanged and a second pass never rewrites a file;
 *  - missing files, corrupt JSON and a decoy at projects/../ are inert;
 *  - index.ts calls both reconcilers, and digest reconciliation precedes the
 *    scheduled sweep that could otherwise re-launch a stale running row.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { validAgentName } from '../src/services/opencode-delegate-core.ts';

register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

const RESTART_ERROR = 'Interrupted by server restart';
const CREATED_AT = '2026-11-27T09:00:00.000Z';
const STARTED_AT = '2026-11-27T09:00:01.000Z';
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST_ID = /^g-[a-z0-9]{6}-[a-z0-9]{6}$/;
const DELEGATION_ID = /^d-[a-z0-9]{6}-[a-z0-9]{6}$/;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-boot-recovery-'));
const previousDataDir = process.env.WSD_DATA_DIR;
process.env.WSD_DATA_DIR = dataDir;
const projectsDir = path.join(dataDir, 'projects');
const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const defaultDataDir = path.resolve(sourceDir, '..', 'data');

const {
  reconcileRunningDigests,
  listDigests,
  getDigest,
} = await import('../src/services/project-digest-store.ts');
const {
  reconcileRunningDelegations,
  listDelegations,
  getDelegation,
} = await import('../src/services/opencode-delegate-store.ts');

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.WSD_DATA_DIR;
  else process.env.WSD_DATA_DIR = previousDataDir;
});

type RowStatus = 'running' | 'done' | 'failed';

function storePath(slug: string, name: 'digests.json' | 'delegations.json'): string {
  return path.join(projectsDir, slug, name);
}

function writeRows(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function readRows(file: string): Array<Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
}

function mtimeNs(file: string): bigint {
  const value = fs.statSync(file, { bigint: true }).mtimeNs;
  assert.ok(typeof value === 'bigint', 'mtimeNs must be available on this platform');
  return value;
}

type BootCall = { callee: string; pos: number };
type BootImportEntry = { named: Map<string, string>; namespace: string | null };
type BootImports = Map<string, BootImportEntry>;

function importModuleSpecifier(statement: ts.ImportDeclaration): string | null {
  const specifier = statement.moduleSpecifier;
  return ts.isStringLiteral(specifier) ? specifier.text : null;
}

function bootCallee(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    ts.isIdentifier(expression.name)
  ) {
    return `${expression.expression.text}.${expression.name.text}`;
  }
  return null;
}

function topLevelBootCalls(sourceFile: ts.SourceFile): BootCall[] {
  const calls: BootCall[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const callee = bootCallee(statement.expression.expression);
    if (callee) calls.push({ callee, pos: statement.pos });
  }
  return calls;
}

function readBootStructure(indexFile: string): { imports: BootImports; calls: BootCall[] } {
  const api = new API();
  try {
    const snapshot = api.updateSnapshot({ openFiles: [indexFile] });
    try {
      const project = snapshot.getDefaultProjectForFile(indexFile);
      assert.ok(project, 'the TypeScript project must resolve for index.ts');
      const sourceFile = project.program.getSourceFile(indexFile);
      assert.ok(sourceFile, 'the TypeScript program must parse index.ts');

      const imports: BootImports = new Map();
      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const specifier = importModuleSpecifier(statement);
        if (!specifier) continue;

        const entry = imports.get(specifier) ?? { named: new Map<string, string>(), namespace: null };
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          entry.namespace = bindings.name.text;
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            entry.named.set(imported, element.name.text);
          }
        }
        imports.set(specifier, entry);
      }

      return { imports, calls: topLevelBootCalls(sourceFile) };
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

function namedImportLocalName(imports: BootImports, specifier: string, imported: string): string | null {
  return imports.get(specifier)?.named.get(imported) ?? null;
}

function namespaceImportLocalName(imports: BootImports, specifier: string): string | null {
  return imports.get(specifier)?.namespace ?? null;
}

function digestRow(id: string, status: RowStatus) {
  return {
    id,
    createdAt: CREATED_AT,
    trigger: 'manual' as const,
    status,
    summary: '',
    blockers: [],
    nextSteps: [],
  };
}

function delegationRow(id: string, status: RowStatus) {
  return {
    id,
    agent: 'code-reviewer',
    capability: 'readonly' as const,
    prompt: 'review the boot path',
    status,
    createdAt: CREATED_AT,
  };
}

function reconcileBoth(): void {
  reconcileRunningDelegations();
  reconcileRunningDigests();
}

describe('boot reconciliation of orphaned running rows', () => {
  test('flips a running digest to failed with the restart marker and keeps its identity', () => {
    const slug = 'digest-orphan';
    const id = 'g-abc123-def456';
    const file = storePath(slug, 'digests.json');
    writeRows(file, [{ ...digestRow(id, 'running'), provider: 'ollama', model: 'llama3' }]);

    reconcileRunningDigests();

    const stored = getDigest(slug, id);
    assert.ok(stored, 'the reconciled row must still be listed');
    assert.strictEqual(stored.status, 'failed');
    assert.strictEqual(stored.error, RESTART_ERROR);
    assert.match(stored.finishedAt ?? '', ISO_TIMESTAMP);
    assert.match(stored.id, DIGEST_ID);
    assert.strictEqual(stored.id, id);
    assert.strictEqual(stored.createdAt, CREATED_AT);
    assert.strictEqual(stored.trigger, 'manual');
    assert.strictEqual(stored.summary, '');
    assert.deepStrictEqual(stored.blockers, []);
    assert.deepStrictEqual(stored.nextSteps, []);
    assert.strictEqual(stored.provider, 'ollama');
    assert.strictEqual(stored.model, 'llama3');
    assert.strictEqual(listDigests(slug).total, 1);
  });

  test('flips a running delegation to failed with the restart marker and keeps its agent', () => {
    const slug = 'delegation-orphan';
    const id = 'd-abc123-def456';
    const file = storePath(slug, 'delegations.json');
    writeRows(file, [{ ...delegationRow(id, 'running'), startedAt: STARTED_AT }]);

    reconcileRunningDelegations();

    const stored = getDelegation(slug, id);
    assert.ok(stored, 'the reconciled row must still be listed');
    assert.strictEqual(stored.status, 'failed');
    assert.strictEqual(stored.error, RESTART_ERROR);
    assert.match(stored.finishedAt ?? '', ISO_TIMESTAMP);
    assert.match(stored.id, DELEGATION_ID);
    assert.strictEqual(stored.id, id);
    assert.strictEqual(stored.agent, 'code-reviewer');
    assert.strictEqual(stored.prompt, 'review the boot path');
    assert.ok(validAgentName(stored.agent), 'agent must remain a valid kebab-case roster name');
    assert.strictEqual(stored.capability, 'readonly');
    assert.strictEqual(stored.createdAt, CREATED_AT);
    assert.strictEqual(stored.startedAt, STARTED_AT);
    assert.strictEqual(listDelegations(slug).length, 1);
  });

  test('leaves settled digest and delegation rows byte-unchanged', () => {
    const slug = 'settled-history';
    const digestFile = storePath(slug, 'digests.json');
    const delegationFile = storePath(slug, 'delegations.json');
    writeRows(digestFile, [
      digestRow('g-aaa111-bbb222', 'done'),
      { ...digestRow('g-ccc333-ddd444', 'failed'), error: 'earlier provider outage' },
    ]);
    writeRows(delegationFile, [
      delegationRow('d-aaa111-bbb222', 'done'),
      { ...delegationRow('d-ccc333-ddd444', 'failed'), error: 'earlier timeout' },
    ]);
    const digestBefore = fs.readFileSync(digestFile);
    const delegationBefore = fs.readFileSync(delegationFile);
    const digestMtimeBefore = mtimeNs(digestFile);
    const delegationMtimeBefore = mtimeNs(delegationFile);

    reconcileBoth();

    assert.deepStrictEqual(fs.readFileSync(digestFile), digestBefore);
    assert.deepStrictEqual(fs.readFileSync(delegationFile), delegationBefore);
    assert.strictEqual(mtimeNs(digestFile), digestMtimeBefore);
    assert.strictEqual(mtimeNs(delegationFile), delegationMtimeBefore);
  });

  test('a second reconcile pass rewrites neither history', () => {
    const slug = 'twice-reconciled';
    const digestFile = storePath(slug, 'digests.json');
    const delegationFile = storePath(slug, 'delegations.json');
    writeRows(digestFile, [digestRow('g-111111-222222', 'running')]);
    writeRows(delegationFile, [delegationRow('d-111111-222222', 'running')]);
    reconcileBoth();

    const digestAfterFirst = fs.readFileSync(digestFile);
    const delegationAfterFirst = fs.readFileSync(delegationFile);
    const digestRowsAfterFirst = readRows(digestFile);
    const delegationRowsAfterFirst = readRows(delegationFile);
    const digestMtimeAfterFirst = mtimeNs(digestFile);
    const delegationMtimeAfterFirst = mtimeNs(delegationFile);
    assert.strictEqual(digestRowsAfterFirst[0].status, 'failed');
    assert.strictEqual(digestRowsAfterFirst[0].error, RESTART_ERROR);
    assert.strictEqual(delegationRowsAfterFirst[0].status, 'failed');
    assert.strictEqual(delegationRowsAfterFirst[0].error, RESTART_ERROR);

    reconcileBoth();

    assert.deepStrictEqual(fs.readFileSync(digestFile), digestAfterFirst);
    assert.deepStrictEqual(fs.readFileSync(delegationFile), delegationAfterFirst);
    assert.strictEqual(mtimeNs(digestFile), digestMtimeAfterFirst);
    assert.strictEqual(mtimeNs(delegationFile), delegationMtimeAfterFirst);
    assert.deepStrictEqual(readRows(digestFile), digestRowsAfterFirst);
    assert.deepStrictEqual(readRows(delegationFile), delegationRowsAfterFirst);
    assert.strictEqual(digestRowsAfterFirst.length, 1);
    assert.strictEqual(delegationRowsAfterFirst.length, 1);
  });

  test('missing store files are tolerated and never fall back to the default data dir', () => {
    assert.strictEqual(process.env.WSD_DATA_DIR, dataDir);
    const slug = `missing-${process.pid}`;
    const dir = path.join(projectsDir, slug);
    const fallbackPath = path.join(defaultDataDir, 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    assert.ok(!fs.existsSync(fallbackPath), 'the default data dir must start clean for this slug');

    assert.doesNotThrow(reconcileBoth);

    assert.deepStrictEqual(fs.readdirSync(dir), []);
    assert.ok(!fs.existsSync(fallbackPath), 'reconciliation must stay inside WSD_DATA_DIR');
  });

  test('corrupt JSON is tolerated and left byte-unchanged', () => {
    const slug = 'corrupt-history';
    const files = [storePath(slug, 'digests.json'), storePath(slug, 'delegations.json')];
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{not json', { encoding: 'utf8', mode: 0o600 });
    }
    const before = files.map((file) => fs.readFileSync(file));

    assert.doesNotThrow(reconcileBoth);

    files.forEach((file, i) => assert.deepStrictEqual(fs.readFileSync(file), before[i], file));
  });

  test('a decoy store at projects/../ stays untouched', () => {
    const digestDecoy = path.join(projectsDir, '..', 'digests.json');
    const delegationDecoy = path.join(projectsDir, '..', 'delegations.json');
    writeRows(digestDecoy, [digestRow('g-999999-888888', 'running')]);
    writeRows(delegationDecoy, [delegationRow('d-999999-888888', 'running')]);
    const before = [fs.readFileSync(digestDecoy), fs.readFileSync(delegationDecoy)];

    assert.doesNotThrow(reconcileBoth);

    assert.deepStrictEqual(fs.readFileSync(digestDecoy), before[0]);
    assert.deepStrictEqual(fs.readFileSync(delegationDecoy), before[1]);
    assert.strictEqual(readRows(digestDecoy)[0].status, 'running');
    assert.strictEqual(readRows(delegationDecoy)[0].status, 'running');
  });

  test('boot calls both reconcilers and reconciles digests before starting the sweep', () => {
    const indexFile = path.join(sourceDir, '..', 'src', 'index.ts');
    const { imports, calls } = readBootStructure(indexFile);
    const delegationLocal = namedImportLocalName(
      imports,
      './services/opencode-delegate-store',
      'reconcileRunningDelegations',
    );
    assert.ok(delegationLocal, 'boot must import the delegation reconciler from the delegate store');
    const delegationCalls = calls.filter((call) => call.callee === delegationLocal);
    assert.strictEqual(delegationCalls.length, 1, 'boot must call reconcileRunningDelegations() once at top level');

    const digestNamespace = namespaceImportLocalName(imports, './services/project-digest');
    let digestReconcileCallee: string;
    let sweepCallee: string;
    if (digestNamespace) {
      digestReconcileCallee = `${digestNamespace}.reconcileRunningDigests`;
      sweepCallee = `${digestNamespace}.startDigestAutomation`;
    } else {
      const reconcileLocal = namedImportLocalName(
        imports,
        './services/project-digest',
        'reconcileRunningDigests',
      );
      const sweepLocal = namedImportLocalName(imports, './services/project-digest', 'startDigestAutomation');
      assert.ok(
        reconcileLocal && sweepLocal,
        'boot must import both digest reconciliation and sweep start from the digest service',
      );
      digestReconcileCallee = reconcileLocal;
      sweepCallee = sweepLocal;
    }

    const digestCalls = calls.filter((call) => call.callee === digestReconcileCallee);
    const sweepCalls = calls.filter((call) => call.callee === sweepCallee);
    assert.strictEqual(digestCalls.length, 1, 'boot must call digest reconciliation once at top level');
    assert.strictEqual(sweepCalls.length, 1, 'boot must call digest automation once at top level');
    assert.ok(
      Math.min(...digestCalls.map((call) => call.pos)) < Math.min(...sweepCalls.map((call) => call.pos)),
      'digest reconciliation must precede the scheduled sweep',
    );
  });
});
