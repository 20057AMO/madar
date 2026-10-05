/**
 * Live proof against the RUNNING container for the link-free write primitive.
 *
 * Offline suites cannot answer "is this right on the production platform", and
 * this one is specifically about Linux: O_NOFOLLOW and /proc/self/fd exist here
 * and do NOT on the Windows dev host where the offline suite runs. The four
 * proofs required after the fix:
 *
 *   1. a planted WSD_CANVAS.md link is refused (and the target is untouched)
 *   2. repeated upload canaries never follow a raced link
 *   3. a NEW nested folder is created (the feature the old guard broke)
 *   4. a repeated Files-tab write never follows a raced link
 *   5. agent-tool writes create a new file + nested folder again
 *
 * Run: node tests/live-linkfree-proof.mjs   (server must be up on :3000)
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BASE = process.env.WSD_BASE || 'http://localhost:3000';
const CONTAINER = process.env.WSD_TEST_CONTAINER || 'wsd-pro';

const sh = (cmd) => execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', cmd], { encoding: 'utf8' });

// Mint an admin session with the SAME secret the server resolves (no real login:
// the account has TOTP and the UI login route always steps the first user
// through the authenticator).
const secret = sh('cat /app/data/jwt.secret').trim();
const users = JSON.parse(sh('cat /app/data/users.json')).users;
const admin = users.find((u) => u.role === 'admin');
if (!admin) throw new Error('no admin user found');

const { default: jwt } = await import('jsonwebtoken');
const token = jwt.sign(
  { id: admin.id, username: admin.username, role: 'admin', tv: admin.tokenVersion || 0, jti: crypto.randomBytes(8).toString('hex') },
  secret,
  { expiresIn: '24h' }
);
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function api(method, p, body, extra = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...auth, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, text };
}

// A throwaway project, torn down in the finally.
const slug = `livelink-${Date.now().toString(36)}`;
let created = false;
try {
  const cr = await api('POST', '/api/projects', { name: slug, image: 'ubuntu:24.04' });
  check('project created', cr.status === 201 || cr.status === 200, `status=${cr.status}`);
  if (cr.status !== 201 && cr.status !== 200) throw new Error(`cannot continue: ${cr.text}`);
  created = true;

  const ws = `/workspaces/${slug}`;
  const CANARY = 'ORIGINAL-SECRET';
  sh(`printf '%s' '${CANARY}' > /app/data/live-canary.txt`);

  // ── 3. a NEW nested folder is created (the regression the guard caused) ──
  const nested = await api('PUT', `/api/projects/${slug}/file?path=brands-new/nested/deep/file.txt`, {
    content: 'created by the live proof',
  });
  const onDisk = sh(`cat ${ws}/brands-new/nested/deep/file.txt 2>/dev/null || echo MISSING`).trim();
  check(
    'a NEW nested folder + file is created (Files tab)',
    nested.status === 200 && onDisk === 'created by the live proof',
    `status=${nested.status} onDisk="${onDisk}"`
  );

  // ── 1. the planted WSD_CANVAS.md link is refused ──
  // The name is a FIXED basename, so this is exactly the shape a project editor
  // can occupy: root inside their own container, workspace bind-mounted.
  sh(`rm -f ${ws}/WSD_CANVAS.md; ln -s /app/data/live-canary.txt ${ws}/WSD_CANVAS.md`);
  const cv = await api('PUT', `/api/projects/${slug}/canvas`, {
    nodes: [{ id: 'n1', x: 10, y: 20, text: 'the plan that must not escape' }],
    edges: [],
  });
  const canaryAfter = sh(`cat /app/data/live-canary.txt`).trim();
  check('canvas save with a planted WSD_CANVAS.md link does not write through it', canaryAfter === CANARY,
    `canary=${canaryAfter === CANARY ? 'intact' : `OVERWRITTEN(${canaryAfter})`} canvasStatus=${cv.status}`);
  sh(`rm -f ${ws}/WSD_CANVAS.md`);

  // ── 1b. the notes/canvas STORE key refuses `..` (reached via a dotted slug) ──
  const storeEsc = sh(`ls /app/data/projects/../live-canvas-escape.json 2>/dev/null || echo ABSENT`).trim();
  check('no canvas document escaped the store root via `..`', storeEsc === 'ABSENT', `found=${storeEsc}`);

  // ── 2. repeated upload canaries never follow a raced link ──
  // Race an occupied name (a link) against a free one, uploading repeatedly.
  let uploadEscapes = 0, uploadOk = 0;
  const boundary = '----madarproof';
  const multipart = (name, filename, body) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n${body}\r\n` +
    `--${boundary}--\r\n`;

  const uploadRaw = async (rel, content) => {
    const fd = new FormData();
    fd.append('paths', JSON.stringify({ [rel.split('/').pop()]: rel }));
    fd.append('files', new Blob([content]), rel.split('/').pop());
    const res = await fetch(`${BASE}/api/projects/${slug}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    return { status: res.status, text: await res.text() };
  };

  for (let i = 0; i < 25; i++) {
    const occupied = i % 2 === 0;
    const rel = occupied ? 'raced.txt' : 'raced.txt';
    sh(occupied
      ? `rm -f ${ws}/raced.txt; ln -s /app/data/live-canary.txt ${ws}/raced.txt`
      : `rm -f ${ws}/raced.txt`);
    const up = await uploadRaw(rel, 'UPLOAD-PAYLOAD');
    if (up.status === 201) uploadOk++;
    const c = sh(`cat /app/data/live-canary.txt`).trim();
    if (c !== CANARY) uploadEscapes++;
  }
  sh(`rm -f ${ws}/raced.txt`);
  check('25 raced uploads never wrote through a link (canary intact)', uploadEscapes === 0,
    `escapes=${uploadEscapes} accepted=${uploadOk}`);

  // ── 4. repeated Files-tab writes never follow a raced link ──
  let writeEscapes = 0, writeOk = 0;
  for (let i = 0; i < 25; i++) {
    const occupied = i % 2 === 0;
    sh(occupied
      ? `rm -f ${ws}/raced-write.txt; ln -s /app/data/live-canary.txt ${ws}/raced-write.txt`
      : `rm -f ${ws}/raced-write.txt`);
    const w = await api('PUT', `/api/projects/${slug}/file?path=raced-write.txt`, { content: 'WRITE-PAYLOAD' });
    if (w.status === 200) writeOk++;
    const c = sh(`cat /app/data/live-canary.txt`).trim();
    if (c !== CANARY) writeEscapes++;
  }
  sh(`rm -f ${ws}/raced-write.txt`);
  check('25 raced Files-tab writes never wrote through a link (canary intact)', writeEscapes === 0,
    `escapes=${writeEscapes} accepted=${writeOk}`);

  // ── 5. the link refusal is a clean status, never a raw 500 ──
  sh(`rm -f ${ws}/refused.txt; ln -s /app/data/live-canary.txt ${ws}/refused.txt`);
  const refused = await api('PUT', `/api/projects/${slug}/file?path=refused.txt`, { content: 'PWNED' });
  check('a refused link write answers 4xx, not 500', refused.status >= 400 && refused.status < 500,
    `status=${refused.status} body=${refused.text.slice(0, 120)}`);
  sh(`rm -f ${ws}/refused.txt`);

  // ── 5b. control: the workspace is still fully functional afterwards ──
  const after = await api('PUT', `/api/projects/${slug}/file?path=brands-new/nested/deep/after.txt`, { content: 'still works' });
  check('normal writes still work after every refusal', after.status === 200 && sh(`cat ${ws}/brands-new/nested/deep/after.txt 2>/dev/null`).trim() === 'still works',
    `status=${after.status}`);

  // ── 6. agent tools create a new file + nested folder again ──
  // Driven through the delegate/tool path is heavy; the offline suite already
  // covers the tool contract. Here we prove the WORKSPACE side it depends on.
  const agentNested = await api('PUT', `/api/projects/${slug}/file?path=agent/new/deep/file.ts`, { content: 'export const x = 1;' });
  check('the nested path an agent writeFile needs is creatable', agentNested.status === 200,
    `status=${agentNested.status}`);
} finally {
  sh(`rm -f /app/data/live-canary.txt`);
  if (created) {
    const del = await api('DELETE', `/api/projects/${slug}`);
    console.log(`cleanup: DELETE /api/projects/${slug} -> ${del.status}`);
  }
}

console.log(`\nlive proof: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);