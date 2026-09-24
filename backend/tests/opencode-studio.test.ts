/**
 * opencode-studio.test.ts
 * API-level coverage for the Opencode Studio (against the running container):
 *  - preset subagents, skills and slash commands are baked into the image
 *  - subagent CRUD lifecycle (create → list → get → update → delete → 404)
 *  - skill CRUD lifecycle (create writes <name>/SKILL.md layout)
 *  - command CRUD lifecycle (<name>.md, frontmatter required, agent badge listed)
 *  - kebab-case name validation + traversal rejection
 *  - config GET/PUT roundtrip preserves existing keys, rejects junk
 *
 * Self-cleaning: every item it creates uses a unique zz- prefix and is
 * deleted at the end.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { req, reqAuth, uniqueId, initTestAuth, JWT_SECRET } from './helpers.ts';

let agentName = '';
let skillName = '';
let commandName = '';

const AGENT_MD = `---
description: Automated test reviewer
mode: subagent
permission:
  edit: deny
---

You review things.
`;

const SKILL_MD = `---
name: PLACEHOLDER
description: A skill created by automated tests
---

Do the thing.
`;

const COMMAND_MD = `---
description: A command created by automated tests
agent: code-reviewer
---

Review $ARGUMENTS.
`;

describe('Opencode Studio API', () => {
  before(async () => { await initTestAuth(); });

  after(async () => {
    for (const [kind, name] of [
      ['agents', agentName],
      ['skills', skillName],
      ['commands', commandName],
    ] as const) {
      if (!name) continue;
      try {
        await reqAuth('DELETE', `/opencode-studio/${kind}/${name}`);
      } catch {}
    }
  });

  test('presets baked into the image are listed', async () => {
    const agents = await reqAuth('GET', '/opencode-studio/agents');
    assert.equal(agents.status, 200);
    const { agents: list } = await agents.json();
    const names = list.map((a: any) => a.name);
    // Full v3 roster: originals + lifecycle specialists + language experts + orchestrator
    // (platform agent renamed to madar-expert)
    for (const expected of [
      'architect',
      'backend-developer',
      'code-reviewer',
      'db-expert',
      'debugger',
      'devops-engineer',
      'doc-writer',
      'frontend-developer',
      'golang-expert',
      'incident-responder',
      'log-analyst',
      'pentester',
      'perf-optimizer',
      'prompt-engineer',
      'python-expert',
      'refactorer',
      'release-manager',
      'rust-expert',
      'security-auditor',
      'test-writer',
      'ux-designer',
      'madar-expert',
      'orchestrator',
      'api-designer',
      'observability-engineer',
      'accessibility-auditor',
      'websocket-engineer',
      'data-engineer',
    ]) {
      assert.ok(names.includes(expected), `preset agent '${expected}' present`);
    }
    const codeReviewer = list.find((a: any) => a.name === 'code-reviewer');
    assert.equal(codeReviewer.mode, 'subagent');

    const skills = await reqAuth('GET', '/opencode-studio/skills');
    const { skills: slist } = await skills.json();
    const snames = slist.map((s: any) => s.name);
    for (const expected of [
      'clean-code',
      'docker-debug',
      'git-release',
      'planning-methodology',
      'debugging-methodology',
      'testing-strategy',
      'security-hardening',
      'api-design-guidelines',
      'performance-profiling',
      'wsd-workflow',
      'frontend-implementation',
      'backend-implementation',
      'database-design',
      'websocket-implementation',
      'code-review',
      'refactoring',
      'accessibility',
      'git-workflow',
      'documentation',
      'typescript-practices',
    ]) {
      assert.ok(snames.includes(expected), `preset skill '${expected}' present`);
    }

    const commands = await reqAuth('GET', '/opencode-studio/commands');
    assert.equal(commands.status, 200);
    const { commands: clist } = await commands.json();
    const cnames = clist.map((c: any) => c.name);
    for (const expected of [
      'review',
      'audit-security',
      'plan-feature',
      'tdd',
      'fix-issue',
      'refactor-safely',
      'explain-code',
      'release',
    ]) {
      assert.ok(cnames.includes(expected), `preset command '${expected}' present`);
    }
    const review = clist.find((c: any) => c.name === 'review');
    assert.equal(review.agent, 'code-reviewer', 'command agent badge parsed from frontmatter');
  });

  test('agent CRUD lifecycle', async () => {
    agentName = uniqueId('zz-agent').slice(0, 40);

    const created = await reqAuth('POST', `/opencode-studio/agents/${agentName}`, { content: AGENT_MD });
    assert.equal(created.status, 200);

    const dup = await reqAuth('POST', `/opencode-studio/agents/${agentName}`, { content: AGENT_MD });
    assert.equal(dup.status, 200, 'save is upsert-style (edit in place)');

    const got = await reqAuth('GET', `/opencode-studio/agents/${agentName}`);
    assert.equal(got.status, 200);
    const body = await got.json();
    assert.match(body.content, /You review things\./);

    const listed = await (await reqAuth('GET', '/opencode-studio/agents')).json();
    const found = listed.agents.find((a: any) => a.name === agentName);
    assert.equal(found.description, 'Automated test reviewer');
    assert.equal(found.mode, 'subagent');

    const updated = await reqAuth('POST', `/opencode-studio/agents/${agentName}`, {
      content: AGENT_MD.replace('reviewer', 'auditor'),
    });
    assert.equal(updated.status, 200);
    const reread = await (await reqAuth('GET', `/opencode-studio/agents/${agentName}`)).json();
    assert.ok(reread.content.includes('auditor'));
  });

  test('agent delete removes it', async () => {
    const res = await reqAuth('DELETE', `/opencode-studio/agents/${agentName}`);
    assert.equal(res.status, 200);
    const gone = await reqAuth('GET', `/opencode-studio/agents/${agentName}`);
    assert.equal(gone.status, 404);
    agentName = ''; // already cleaned
  });

  test('skill CRUD lifecycle', async () => {
    skillName = uniqueId('zz-skill').replace(/-/g, '-').slice(0, 40);
    const content = SKILL_MD.replace('PLACEHOLDER', skillName);

    const created = await reqAuth('POST', `/opencode-studio/skills/${skillName}`, { content });
    assert.equal(created.status, 200);

    const listed = await (await reqAuth('GET', '/opencode-studio/skills')).json();
    const found = listed.skills.find((s: any) => s.name === skillName);
    assert.equal(found.description, 'A skill created by automated tests');

    const gone = await reqAuth('DELETE', `/opencode-studio/skills/${skillName}`);
    assert.equal(gone.status, 200);
    const confirm = await reqAuth('GET', `/opencode-studio/skills/${skillName}`);
    assert.equal(confirm.status, 404);
    skillName = '';
  });

  test('invalid names rejected with 400', async () => {
    for (const bad of ['../escape', 'Has-Caps', 'has space']) {
      const res = await reqAuth('GET', `/opencode-studio/agents/${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `'${bad}' rejected`);
    }
  });

  test('command CRUD lifecycle', async () => {
    commandName = uniqueId('zz-command').slice(0, 40);

    const created = await reqAuth('POST', `/opencode-studio/commands/${commandName}`, { content: COMMAND_MD });
    assert.equal(created.status, 200);

    const listed = await (await reqAuth('GET', '/opencode-studio/commands')).json();
    const found = listed.commands.find((c: any) => c.name === commandName);
    assert.equal(found.description, 'A command created by automated tests');
    assert.equal(found.agent, 'code-reviewer');

    const got = await reqAuth('GET', `/opencode-studio/commands/${commandName}`);
    assert.equal(got.status, 200);
    const body = await got.json();
    assert.match(body.content, /Review \$ARGUMENTS\./);

    const gone = await reqAuth('DELETE', `/opencode-studio/commands/${commandName}`);
    assert.equal(gone.status, 200);
    const confirm = await reqAuth('GET', `/opencode-studio/commands/${commandName}`);
    assert.equal(confirm.status, 404);
    commandName = '';
  });

  test('command without frontmatter rejected with 400', async () => {
    const res = await reqAuth('POST', '/opencode-studio/commands/zz-no-frontmatter', {
      content: 'Just a body, no --- markers.',
    });
    assert.equal(res.status, 400);
  });

  test('baked roster files are intact (frontmatter, no NUL corruption)', async () => {
    // Regression guard: a baked file once silently became pure NUL bytes and
    // shipped inside the image because listings derive names from paths.
    for (const kind of ['agents', 'skills', 'commands'] as const) {
      const listRes = await reqAuth('GET', `/opencode-studio/${kind}`);
      const body = await listRes.json();
      const list: any[] = body[kind] || [];
      assert.ok(list.length > 0, `${kind} roster not empty`);
      for (const item of list) {
        if (item.name.startsWith('zz-')) continue; // transient test items
        const got = await reqAuth('GET', `/opencode-studio/${kind}/${encodeURIComponent(item.name)}`);
        assert.equal(got.status, 200, `${kind}/${item.name} readable`);
        const { content } = await got.json();
        assert.ok(!String(content).includes('\u0000'), `${kind}/${item.name} has no NUL bytes`);
        assert.match(String(content), /^---/, `${kind}/${item.name} starts with frontmatter`);
        assert.ok(String(item.description || '').length > 0, `${kind}/${item.name} description present`);
      }
    }
  });

  test('config roundtrip preserves keys and rejects junk', async () => {
    const before = await (await reqAuth('GET', '/opencode-studio/config')).json();

    const patched = await reqAuth('PUT', '/opencode-studio/config', {
      ...before,
      subagent_depth: 2,
    });
    assert.equal(patched.status, 200);
    const merged = await patched.json();
    assert.equal(merged.$schema, before.$schema, '$schema preserved');
    assert.equal(merged.model, before.model, 'model preserved');
    assert.equal(merged.subagent_depth, 2);

    // Restore original depth value if it existed, else remove our key.
    const restore: Record<string, unknown> = { ...before };
    if (!('subagent_depth' in before)) {
      // PUT merge cannot delete keys; set back to V1 default explicitly.
      restore.subagent_depth = 1;
    }
    await reqAuth('PUT', '/opencode-studio/config', restore);

    const junk = await reqAuth('PUT', '/opencode-studio/config', [1, 2]);
    assert.equal(junk.status, 400);
  });

  test('version endpoint reports a sane shape', async () => {
    const res = await reqAuth('GET', '/opencode-studio/version');
    assert.equal(res.status, 200);
    const v = await res.json();
    assert.ok(typeof v.current === 'string' && v.current.length > 0);
    assert.deepEqual(v.supportedMajors, [1]);
    assert.equal(typeof v.updateRunning, 'boolean');
  });

  test('access matrix: viewer/editor 403 on every Studio surface (admin-only)', async () => {
    // Studio is fully admin-gated — including reads: the roster/config files
    // are read by every project's agent runs, so a non-admin must never even
    // browse them (403, never a partial 200).
    const forge = (role: string) =>
      jwt.sign({ id: `studio-${role}`, username: `studio-${role}`, role, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
    for (const role of ['viewer', 'editor']) {
      const h = { Authorization: `Bearer ${forge(role)}` };
      const probes: [string, string, object?][] = [
        ['GET', '/opencode-studio/agents', undefined],
        ['GET', '/opencode-studio/version', undefined],
        ['GET', '/opencode-studio/config', undefined],
        ['POST', '/opencode-studio/agents/zz-nonadmin', { content: '---\ndescription: nope\n---\n\nx' }],
        ['POST', '/opencode-studio/skills/zz-nonadmin', { content: '---\ndescription: nope\n---\n\nx' }],
        ['POST', '/opencode-studio/commands/zz-nonadmin', { content: '---\ndescription: nope\n---\n\nx' }],
        ['PUT', '/opencode-studio/config', { subagent_depth: 2 }],
        ['DELETE', '/opencode-studio/commands/zz-nonadmin', undefined],
      ];
      for (const [method, url, body] of probes) {
        const res = await req(method as any, url, body as any, h);
        assert.equal(res.status, 403, `${role} ${method} ${url} → 403 (got ${res.status})`);
      }
    }
    // Nothing from the blocked calls above landed on disk.
    const gone = await reqAuth('GET', '/opencode-studio/agents/zz-nonadmin');
    assert.equal(gone.status, 404, 'blocked writes never created files');
  });
});
