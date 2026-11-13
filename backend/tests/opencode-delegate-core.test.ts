/**
 * opencode-delegate-core.test.ts
 * Pure unit coverage for the agent-delegation rules (capability
 * classification, prompt sanitize/build, id + pruning) — no server, no
 * Docker, no service imports (same pattern as alerts-core/serve-core).
 *
 * Contract under test:
 *  - agentCapability: readonly requires BOTH `edit: deny` AND `bash: deny`
 *    together AND no `task` allow (a spawner can start another agent at
 *    runtime); EVERYTHING else (edit: allow, bash: allow, task: allow,
 *    no permission block, junk) → write (safe by default / fail-closed).
 *  - sanitizeDelegatePrompt: trim + 20k cap + rejects empty with 400.
 *  - buildDelegatePrompt: forces reading WSD_PROJECT.md + WSD_CANVAS.md
 *    first, embeds the task, picks a per-agent working-mode template.
 *  - delegateEntryId d-<6>-<6> uniqueness; capDelegations keeps newest.
 *  - validAgentName: kebab-case roster names only.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  agentCapability,
  sanitizeDelegatePrompt,
  buildDelegatePrompt,
  delegateEntryId,
  capDelegations,
  validAgentName,
  DELEGATE_PROMPT_MAX,
  HttpError,
} from '../src/services/opencode-delegate-core.ts';

describe('agentCapability — safe-by-default classification', () => {
  test('permission block with edit: deny AND bash: deny and NO task → readonly (the roster form)', () => {
    const fm = `---\ndescription: Review only\ndmode: subagent\npermission:\n  edit: deny\n  bash: deny\n---\nbody`;
    assert.strictEqual(agentCapability(fm), 'readonly');
  });

  test('a `task` allow makes an edit+bash-denied agent a WRITER (orchestrator shape — it spawns a writer at runtime)', () => {
    // The shipped orchestrator frontmatter: edit + bash denied, task allowed.
    // It can start another agent (subagent_depth: 2), so its own denies say
    // nothing about what the spawned agent may do.
    const blockForm = `---\nmode: all\npermission:\n  edit: deny\n  bash: deny\n  task: allow\n---\nbody`;
    assert.strictEqual(agentCapability(blockForm), 'write');
    // Flow form of the same shape.
    assert.strictEqual(agentCapability('---\npermission: {edit: deny, bash: deny, task: allow}\n---'), 'write');
    // Truthy spellings, case-insensitive (over-classifying toward write is the
    // only safe direction here).
    assert.strictEqual(agentCapability('---\npermission:\n  edit: deny\n  bash: deny\n  task: true\n---'), 'write');
    assert.strictEqual(agentCapability('---\npermission:\n  edit: deny\n  bash: deny\n  task: yes\n---'), 'write');
    assert.strictEqual(agentCapability('---\npermission:\n  edit: deny\n  bash: deny\n  task: ALLOW\n---'), 'write');
    // A bare top-level task: allow is honored as well — the safe direction...
    assert.strictEqual(agentCapability('---\ntask: allow\n---'), 'write');
    // ...including when it sits unindented AFTER the permission block (which is
    // exactly how the block ends, so that terminating line still counts).
    assert.strictEqual(agentCapability('---\npermission:\n  edit: deny\n  bash: deny\ntask: allow\n---'), 'write');
    // A task DENY (or junk value) never changes anything.
    assert.strictEqual(agentCapability('---\npermission:\n  edit: deny\n  bash: deny\n  task: deny\n---'), 'readonly');
    assert.strictEqual(agentCapability('---\npermission:\n  edit: deny\n  bash: deny\n  task: maybe\n---'), 'readonly');
  });

  test('quoted YAML values are honored: task: "allow" is an allow, quoted denies still deny', () => {
    // YAML accepts `key: "value"`; a hand-written or reformatted agent file
    // must not slip past the spawner rule by quoting its value.
    assert.strictEqual(agentCapability('---\npermission:\n  edit: deny\n  bash: deny\n  task: "allow"\n---'), 'write');
    assert.strictEqual(agentCapability("---\npermission:\n  edit: deny\n  bash: deny\n  task: 'allow'\n---"), 'write');
    // Flow form and the bare top-level line carry the same tolerance.
    assert.strictEqual(agentCapability('---\npermission: {edit: deny, bash: deny, task: "allow"}\n---'), 'write');
    assert.strictEqual(agentCapability('---\ntask: "allow"\n---'), 'write');
    // The deny direction keeps working when quoted (and stays fail-closed for a
    // value that merely starts with a deny word).
    assert.strictEqual(agentCapability('---\npermission:\n  edit: "deny"\n  bash: "deny"\n---'), 'readonly');
    assert.strictEqual(agentCapability('---\npermission:\n  edit: "denied"\n  bash: deny\n---'), 'write');
  });

  test('bash-capable agents are WRITERS even with edit: deny (pentester/incident-responder/log-analyst roster form)', () => {
    // A bash: allow agent can execute root commands in the container — it
    // must never reach viewer+ through the readonly gate.
    assert.strictEqual(agentCapability('---\npermission:\n  edit: deny\n  bash: allow\n---'), 'write');
    // Only BOTH denies classify readonly — including the flow form.
    assert.strictEqual(agentCapability('---\npermission: {edit: deny, bash: deny}\n---'), 'readonly');
    // A deny for an unknown/future tool alone never grants readonly.
    assert.strictEqual(agentCapability('---\npermission:\n  bash: deny\n  webfetch: deny\n---'), 'write');
    // Bash denied but edit allowed → still a writer.
    assert.strictEqual(agentCapability('---\npermission:\n  edit: allow\n  bash: deny\n---'), 'write');
  });

  test('edit: deny inside the permission block only — a flat top-level edit: deny is not honored by opencode', () => {
    // The roster form: permission: block with an indented edit: deny.
    assert.strictEqual(agentCapability('---\npermission:\n  edit: allow\n---'), 'write');
    // edit denied but bash NOT denied → write (bash defaults to enabled).
    assert.strictEqual(agentCapability('---\npermission:\n  edit: deny\n---'), 'write');
    // Flow form without a bash deny → write.
    assert.strictEqual(agentCapability('---\npermission: {edit: deny}\n---'), 'write');
    // A bare top-level edit: deny is NOT a valid opencode permission — the
    // agent would actually be able to edit, so classify it as a writer.
    assert.strictEqual(agentCapability('---\nedit: deny\n---'), 'write');
  });

  test('no permission block / no frontmatter → write (never treat as readonly)', () => {
    assert.strictEqual(agentCapability('---\ndescription: x\nmode: subagent\n---'), 'write');
    assert.strictEqual(agentCapability(''), 'write');
    assert.strictEqual(agentCapability('plain body without frontmatter'), 'write');
    assert.strictEqual(agentCapability(null as unknown as string), 'write');
  });

  test('a description line mentioning edit: deny does NOT classify readonly', () => {
    const fm = `---\ndescription: this agent talks about "edit: deny" but never denies\n---`;
    assert.strictEqual(agentCapability(fm), 'write');
  });

  test('junk/near-miss values never classify readonly', () => {
    assert.strictEqual(agentCapability('---\npemrission:\n  edit: deny\n---'), 'write'); // typo key
    assert.strictEqual(agentCapability('---\npermission:\n  edit: DENY\n---'), 'write'); // value case-sensitive
    assert.strictEqual(agentCapability('---\npermission:\n  edit: denied\n---'), 'write');
    assert.strictEqual(agentCapability('---\npermission:\n  bash: deny\n  edit: allow\n---'), 'write');
  });
});

describe('sanitizeDelegatePrompt — boundary + budget', () => {
  test('trims and rejects empty/null/junk with a 400 HttpError', () => {
    assert.strictEqual(sanitizeDelegatePrompt('  hello  '), 'hello');
    for (const bad of ['', '   ', null, undefined, 42, {}]) {
      assert.throws(() => sanitizeDelegatePrompt(bad), (e: unknown) => e instanceof HttpError && e.statusCode === 400);
    }
  });

  test('caps to DELEGATE_PROMPT_MAX (20_000) instead of dropping', () => {
    const huge = 'x'.repeat(50_000);
    const out = sanitizeDelegatePrompt(huge);
    assert.strictEqual(out.length, DELEGATE_PROMPT_MAX);
    assert.ok(out.endsWith('x'.repeat(100)));
  });
});

describe('buildDelegatePrompt — context-first wrapping', () => {
  test('instructs reading WSD_PROJECT.md + WSD_CANVAS.md and embeds the task', () => {
    const out = buildDelegatePrompt('my-proj', 'My Project', 'code-reviewer', 'review the docker-manager');
    assert.ok(out.includes('/workspace/WSD_PROJECT.md'));
    assert.ok(out.includes('/workspace/WSD_CANVAS.md'));
    assert.ok(out.includes('review the docker-manager'));
    assert.ok(out.includes('"my-proj"'));
    assert.ok(out.includes('"My Project"'));
  });

  test('template selection by agent keyword (review/test/debug/plan/generic)', () => {
    assert.match(buildDelegatePrompt('s', 'P', 'code-reviewer', 't'), /audit the relevant code/);
    assert.match(buildDelegatePrompt('s', 'P', 'security-auditor', 't'), /audit the relevant code/);
    assert.match(buildDelegatePrompt('s', 'P', 'test-writer', 't'), /cover the behavior with tests/);
    assert.match(buildDelegatePrompt('s', 'P', 'debugger', 't'), /diagnose the reported problem/);
    assert.match(buildDelegatePrompt('s', 'P', 'architect', 't'), /concrete, file-level plan/);
    assert.match(buildDelegatePrompt('s', 'P', 'backend-developer', 't'), /complete the task in the repository/);
  });

  test('undefined project name falls back to the slug', () => {
    const out = buildDelegatePrompt('my-slug', undefined, 'debugger', 't');
    assert.ok(out.includes('"my-slug"'));
  });
});

describe('delegateEntryId / capDelegations / validAgentName', () => {
  test('id matches the d-<6>-<6> pattern and stays unique in a batch', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = delegateEntryId();
      assert.match(id, /^d-[a-z0-9]{6}-[a-z0-9]{6}$/);
      ids.add(id);
    }
    assert.strictEqual(ids.size, 500);
  });

  test('capDelegations keeps the newest max and survives junk input', () => {
    const list = [1, 2, 3, 4, 5].map((i) => ({ id: `d-${i}` }));
    assert.deepStrictEqual(capDelegations(list, 2).map((e) => e.id), ['d-4', 'd-5']);
    assert.strictEqual(capDelegations(list, 0).length, 0);
    assert.strictEqual(capDelegations(null, 5).length, 0);
    assert.strictEqual(capDelegations(list, 99).length, 5);
    // Default cap is the CEILING, not a target size — a small list is kept whole.
    assert.deepStrictEqual(capDelegations(list).map((e) => e.id), ['d-1', 'd-2', 'd-3', 'd-4', 'd-5']);
    assert.strictEqual(capDelegations(list, 1).length, 1);
  });

  test('validAgentName accepts roster kebab-case only', () => {
    for (const ok of ['code-reviewer', 'backend-developer', 'a', 'x1-y2']) {
      assert.strictEqual(validAgentName(ok), true, `expected ${ok} accepted`);
    }
    for (const bad of ['', 'Code Reviewer', 'code reviewer', '../x', 'x/y', 42, null]) {
      assert.strictEqual(validAgentName(bad), false, `expected ${JSON.stringify(bad)} rejected`);
    }
  });
});