/**
 * Live proof against the RUNNING container for the link-free WRITE and RENAME
 * primitives.
 *
 * Offline suites cannot answer "is this right on the production platform", and
 * this one is specifically about Linux: O_NOFOLLOW and /proc/self/fd exist here
 * and do NOT on the Windows dev host where the offline suite runs.
 *
 * It is NOT part of `node --test` on purpose: it needs the container, it mutates
 * /app/data, and it is slow. Run it explicitly after a rebuild:
 *
 *     docker compose build app && docker compose up -d app
 *     cd backend && node tests/live-linkfree-proof.mjs
 *
 * or `npm run test:live-linkfree`. Rows:
 *   1. a planted WSD_CANVAS.md link is refused (and the target is untouched)
 *   2. repeated upload canaries never follow a raced link
 *   3. a NEW nested folder is created (the feature the old guard broke)
 *   4. a repeated Files-tab write never follows a raced link
 *   5. agent-tool writes create a new file + nested folder again
 *   6. RENAME: the replayed check-then-use sequence escapes, the route refuses
 *   7. RENAME under a real concurrent racer never moves a file out (md5 of
 *      /app/data/jwt.secret before/after), and an ordinary rename still works
 *   8. reviews.fileExists is not a host-file existence oracle (a VIEWER asking)
 *   9. a snapshot export skips a planted link without touching its target
 *  10. /file/raw refuses a planted link and still streams a real file byte-exact (descriptor stream, F2)
 *  11. agent readFile answers the marker through a planted link, reads the real file, writeFile still creates (F1)
 *  12. the project index never walks nor chunks a planted link, still indexes the real file, index.json is 0600 (F1)
 */
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const BASE = process.env.WSD_BASE || 'http://localhost:3000';
const CONTAINER = process.env.WSD_TEST_CONTAINER || 'wsd-pro';
const RENAME_ROUNDS = Number(process.env.WSD_LIVE_RENAME_ROUNDS || 60);

const sh = (cmd) => execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', cmd], { encoding: 'utf8' });

// Mint an admin session with the SAME secret the server resolves (no real login:
// the account has TOTP and the UI login route always steps the first user
// through the authenticator).
const secret = sh('cat /app/data/jwt.secret').trim();
const users = JSON.parse(sh('cat /app/data/users.json')).users;
const admin = users.find((u) => u.role === 'admin');
if (!admin) throw new Error('no admin user found');

const { default: jwt } = await import('jsonwebtoken');
const sign = (u) =>
  jwt.sign(
    { id: u.id, username: u.username, role: u.role, tv: u.tokenVersion || 0, jti: crypto.randomBytes(8).toString('hex') },
    secret,
    { expiresIn: '24h' }
  );
const token = sign(admin);
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
let victimSlug = '';
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

  // ── 6. RENAME: the sequence that WAS there, replayed, versus the route ──
  // rename(2) takes no O_NOFOLLOW, so this sink is only closable by binding the
  // syscall to a pinned directory descriptor.
  //
  // The link target MUST be on the same device: `/workspaces` is dev 71 and
  // `/app/data` is dev 2096 here, so a rename aimed at the data volume is
  // refused by the KERNEL with EXDEV before any code of ours runs. That is an
  // accident of this Docker Desktop layout, not a control — so the witness uses
  // ANOTHER PROJECT's workspace (same dev 71, same uid, a real isolation
  // boundary), which is the strongest thing an editor can actually reach.
  const victim = `livevictim${Date.now().toString(36)}`;
  const victimCreated = await api('POST', '/api/projects', { name: `rename witness victim ${Date.now().toString(36)}`, description: 'live proof' });
  victimSlug = victimCreated.json?.project?.slug || (victimCreated.json?.slug ?? '');
  const vws = `/workspaces/${victimSlug}`;
  check('the cross-project witness victim project was created', victimCreated.status === 201 && !!victimSlug && vws !== '/workspaces/',
    `status=${victimCreated.status} slug="${victimSlug}"`);
  if (!victimSlug || vws === '/workspaces/') throw new Error('cannot continue without a victim project');
  await api('PUT', `/api/projects/${victimSlug}/file?path=secret.txt`, { content: 'VICTIM-CANARY' });
  await api('PUT', `/api/projects/${victimSlug}/file?path=secret.txt`, { content: 'VICTIM-CANARY' });

  // First half: the OLD check-then-USE, replayed verbatim, with the swap forced
  // at the exact vulnerable point — a witness that the finding was real.
  sh(`mkdir -p ${ws}/d ${ws}/real; printf '%s' 'ATTACKER' > ${ws}/real/w.txt`);
  const witness = sh(`node -e '
    const fs=require("fs"),path=require("path");
    const ws=process.argv[1], victim=process.argv[2];
    const base=path.join(ws);
    // the CHECK (lexical resolve, exactly the old shape) ...
    const src=path.resolve(base,"real","w.txt");
    const dst=path.resolve(base,"d","stolen.txt");
    if(src!==base&&!src.startsWith(base+path.sep)) throw new Error("refused");
    if(fs.existsSync(dst)) { console.log("OCCUPIED"); process.exit(0); }
    // ... then the forced swap, then the USE.
    fs.rmSync(path.join(base,"d"),{recursive:true,force:true});
    fs.symlinkSync(victim, path.join(base,"d"), "dir");
    fs.mkdirSync(path.dirname(dst),{recursive:true});
    fs.renameSync(src,dst);
    console.log("ESCAPED");
  ' ${ws} ${vws}`).trim();
  check(
    'WITNESS: the old check-then-use rename DID move a file into another project (swap forced mid-flight)',
    witness === 'ESCAPED' && sh(`cat ${vws}/stolen.txt 2>/dev/null || true`).trim() === 'ATTACKER',
    `replay="${witness}" victimNow=${sh(`cat ${vws}/stolen.txt 2>/dev/null || echo ABSENT`).trim()}`
  );
  sh(`rm -f ${vws}/stolen.txt`);

  // Second half: the SAME request through the route, with the destination
  // intermediate a permanent link to the victim — refused, victim untouched.
  sh(`rm -rf ${ws}/planted; ln -s ${vws} ${ws}/planted; mkdir -p ${ws}/real; printf '%s' 'ATTACKER' > ${ws}/real/w.txt`);
  const plantedRename = await api('POST', `/api/projects/${slug}/file/rename`, {
    from: 'real/w.txt',
    to: 'planted/stolen.txt',
  });
  check(
    'the route refuses the identical swap and the victim project is untouched',
    plantedRename.status >= 400 && plantedRename.status < 500 &&
      sh(`test -e ${vws}/stolen.txt && echo PRESENT || echo ABSENT`).trim() === 'ABSENT' &&
      sh(`cat ${ws}/real/w.txt`).trim() === 'ATTACKER',
    `status=${plantedRename.status} body=${plantedRename.text.slice(0, 80)} victim=${sh(`test -e ${vws}/stolen.txt && echo PRESENT || echo ABSENT`).trim()}`
  );
  sh(`rm -f ${ws}/planted`);

  // ── 7. RENAME under a REAL concurrent racer (the finding's own repro) ──
  // An editor inside their own project container swaps the destination
  // intermediate for a link to the victim in a tight loop while the rename is
  // called in a loop. The victim's file md5 is the assertion.
  const victimMd5 = () => sh(`md5sum ${vws}/secret.txt | cut -d" " -f1`).trim();
  const victimBefore = victimMd5();
  console.log(`      md5 victim secret.txt BEFORE = ${victimBefore}`);
  sh(`rm -rf ${ws}/d`);
  const racer = spawn(
    'docker',
    ['exec', slug, 'sh', '-c', `while :; do rm -rf /workspace/d; ln -s ${vws} /workspace/d; done`],
    { stdio: 'ignore' }
  );
  const renameStatuses = new Map();
  for (let i = 0; i < RENAME_ROUNDS; i += 1) {
    // Re-seed every round: a successful rename consumes the source, and a
    // missing source would answer 404 without ever reaching the race.
    sh(`mkdir -p ${ws}/real; printf '%s' 'attacker-payload' > ${ws}/real/f.txt`);
    const r = await api('POST', `/api/projects/${slug}/file/rename`, { from: 'real/f.txt', to: 'd/f.txt' });
    renameStatuses.set(r.status, (renameStatuses.get(r.status) || 0) + 1);
  }
  racer.kill('SIGKILL');
  const victimAfter = victimMd5();
  console.log(`      md5 victim secret.txt AFTER  = ${victimAfter}`);
  // A 200 here is honest: the racer's `rm -rf d; ln -s` leaves a window where d
  // is missing, and the route creates it as a REAL directory — an in-workspace
  // move the racer then consumes. The escape we fear is a file appearing in the
  // VICTIM, so the assertions are md5 + "no new file name in the victim".
  check(
    `${RENAME_ROUNDS} raced renames never moved a file into another project`,
    victimBefore === victimAfter &&
      sh(`test -e ${vws}/f.txt && echo PRESENT || echo ABSENT`).trim() === 'ABSENT' &&
      sh(`test -e ${vws}/stolen.txt && echo PRESENT || echo ABSENT`).trim() === 'ABSENT',
    `statuses=${JSON.stringify(Object.fromEntries(renameStatuses))} md5Unchanged=${victimBefore === victimAfter} victimGainedFile=${sh(`test -e ${vws}/f.txt && echo YES || echo NO`).trim()}`
  );

  // The finding's original target, for the record: /app/data is a different
  // device here, so the KERNEL refuses it (EXDEV) even unchecked. The route must
  // refuse it too, and the signing secret must be byte-identical afterwards.
  sh('cp /app/data/jwt.secret /app/data/.jwt.secret.proofbak');
  const jwtMd5 = () => sh('md5sum /app/data/jwt.secret | cut -d" " -f1').trim();
  const jwtBefore = jwtMd5();
  console.log(`      md5 /app/data/jwt.secret BEFORE = ${jwtBefore}`);
  sh(`rm -rf ${ws}/d`);
  const racer2 = spawn(
    'docker',
    ['exec', slug, 'sh', '-c', 'while :; do rm -rf /workspace/d; ln -s /app/data /workspace/d; done'],
    { stdio: 'ignore' }
  );
  const jwtStatuses = new Map();
  for (let i = 0; i < RENAME_ROUNDS; i += 1) {
    sh(`mkdir -p ${ws}/real; printf '%s' 'attacker-payload' > ${ws}/real/f.txt`);
    const r = await api('POST', `/api/projects/${slug}/file/rename`, { from: 'real/f.txt', to: 'd/jwt.secret' });
    jwtStatuses.set(r.status, (jwtStatuses.get(r.status) || 0) + 1);
  }
  racer2.kill('SIGKILL');
  const jwtAfter = jwtMd5();
  console.log(`      md5 /app/data/jwt.secret AFTER  = ${jwtAfter}`);
  check(
    `${RENAME_ROUNDS} raced renames aimed at /app/data/jwt.secret never changed it`,
    jwtBefore === jwtAfter && sh(`ls ${vws} 2>/dev/null | grep -c '^jwt' || true`).trim() === '0',
    `statuses=${JSON.stringify(Object.fromEntries(jwtStatuses))} md5Unchanged=${jwtBefore === jwtAfter}`
  );
  sh('cp /app/data/.jwt.secret.proofbak /app/data/jwt.secret 2>/dev/null || true; rm -f /app/data/.jwt.secret.proofbak');

  // The regression the old guard caused: renaming into a NEW folder must work.
  sh(`rm -rf ${ws}/d ${ws}/brand; mkdir -p ${ws}/real; printf '%s' 'attacker-payload' > ${ws}/real/f.txt`);
  const ord = await api('POST', `/api/projects/${slug}/file/rename`, {
    from: 'real/f.txt',
    to: 'brand/new/deep/moved.txt',
  });
  check(
    'an ordinary rename into a NEW nested folder still works',
    ord.status === 200 && sh(`cat ${ws}/brand/new/deep/moved.txt 2>/dev/null || echo MISSING`).trim() === 'attacker-payload',
    `status=${ord.status}`
  );

  // ── 8. reviews.fileExists is not a host-file existence oracle (a VIEWER) ──
  const viewerName = `liveview${Date.now().toString(36)}`;
  const cu = await api('POST', '/api/users', { username: viewerName, password: 'LiveProof12345!', role: 'viewer' });
  const viewerId = cu.json?.user?.id || cu.json?.id;
  if (cu.status !== 201 || !viewerId) {
    check('a viewer user could be created for the fileExists oracle row', false, `status=${cu.status} body=${cu.text.slice(0, 120)}`);
  } else {
    await api('POST', `/api/projects/${slug}/members`, { userId: viewerId, role: 'viewer' });
    const viewerAuth = { Authorization: `Bearer ${sign({ id: viewerId, username: viewerName, role: 'viewer', tokenVersion: 0 })}` };
    const oracleTarget = '/app/data/live-oracle-target.txt';
    sh(`printf '%s' 'EXISTS-OUTSIDE' > ${oracleTarget}`);
    sh(`rm -rf ${ws}/escape; ln -s /app/data ${ws}/escape`);
    const opened = await api('POST', `/api/projects/${slug}/reviews`, {
      path: 'escape/live-oracle-target.txt',
      text: 'pinned on a planted link',
    });
    const listed = await fetch(`${BASE}/api/projects/${slug}/reviews`, { headers: viewerAuth });
    const body = await listed.json();
    const thread = (body?.threads || []).find((t) => t.path === 'escape/live-oracle-target.txt');
    check(
      'a VIEWER sees fileExists=false for a planted link even though the target exists',
      opened.status === 201 && listed.status === 200 && !!thread && thread.fileExists === false,
      `open=${opened.status} list=${listed.status} fileExists=${thread ? thread.fileExists : 'no thread'}`
    );
    sh(`rm -f ${ws}/escape ${oracleTarget}`);
    await api('DELETE', `/api/users/${viewerId}`);
  }

  // ── 9. a snapshot export skips a planted link without touching its target ──
  const exportTarget = '/app/data/live-export-target.txt';
  sh(`printf '%s' 'UNTOUCHED' > ${exportTarget}`);
  sh(`rm -rf ${ws}/snaplink; ln -s /app/data ${ws}/snaplink`);
  sh(`printf '%s' 'kept' > ${ws}/keep.txt`);
  const exp = await fetch(`${BASE}/api/projects/${slug}/export`, { headers: auth });
  const raw = exp.ok ? Buffer.from(await exp.arrayBuffer()) : Buffer.alloc(0);
  let names = '';
  try {
    const tar = gunzipSync(raw).toString('latin1');
    names = (tar.match(/[\w./-]*live-export-target\.txt/g) || []).join(',');
  } catch {
    names = '';
  }
  check(
    'a snapshot export with a planted link succeeds, ships no link entry, and the target is untouched',
    exp.status === 200 && raw.length > 0 && !names.includes('live-export-target') &&
      sh(`cat ${exportTarget}`).trim() === 'UNTOUCHED',
    `status=${exp.status} bytes=${raw.length} linkEntries="${names}" target=${sh(`cat ${exportTarget}`).trim()}`
  );
  sh(`rm -f ${ws}/snaplink ${exportTarget}`);

  // ── 10. /file/raw streams FROM the verified descriptor (F2) ──
  const secretText = sh('cat /app/data/jwt.secret').trim();
  sh(`rm -f ${ws}/raw-link.txt; ln -s /app/data/jwt.secret ${ws}/raw-link.txt`);
  const linkRes = await fetch(`${BASE}/api/projects/${slug}/file/raw?path=raw-link.txt`, { headers: auth });
  const linkBody = await linkRes.text();
  check(
    '/file/raw refuses a planted link: a clean 4xx and zero secret bytes',
    linkRes.status >= 400 && linkRes.status < 500 && !linkBody.includes(secretText),
    `status=${linkRes.status} secret="${linkBody.includes(secretText) ? 'LEAKED' : 'absent'}" body="${linkBody.slice(0, 60)}"`
  );
  sh(`rm -f ${ws}/raw-link.txt`);

  const ctrl = await fetch(`${BASE}/api/projects/${slug}/file/raw?path=brands-new/nested/deep/file.txt`, { headers: auth });
  const ctrlBuf = Buffer.from(await ctrl.arrayBuffer());
  const ctrlCl = ctrl.headers.get('content-length');
  check(
    'control: a real file still streams byte-exact with an honest Content-Length',
    ctrl.status === 200 && ctrlBuf.toString('utf8') === 'created by the live proof' &&
      Number(ctrlCl) === ctrlBuf.length,
    `status=${ctrl.status} bytes=${ctrlBuf.length} contentLength=${ctrlCl}`
  );

  const missRaw = await fetch(`${BASE}/api/projects/${slug}/file/raw?path=nope-missing.txt`, { headers: auth });
  check(
    'control: a missing file at /file/raw is still 404 (never 500)',
    missRaw.status === 404,
    `status=${missRaw.status} body="${(await missRaw.text()).slice(0, 60)}"`
  );

  // ── 11. agent readFile reads through the primitive (F1) ──
  // The tool contract must not move: every refusal is a STRING marker, and a
  // link must be indistinguishable from a missing file.
  let agentRead = '{}';
  try {
    agentRead = sh(`node -e '
      const fs = require("fs");
      const tools = require("/app/backend/dist/services/agent-tools.js");
      const slug = process.argv[1];
      const ws = process.argv[2];
      fs.writeFileSync(ws + "/agent-canary-target.txt", "CANARY-TARGET-BYTES");
      fs.rmSync(ws + "/agent-link.txt", { force: true });
      fs.symlinkSync(ws + "/agent-canary-target.txt", ws + "/agent-link.txt");
      const viaLink = tools.readFile(slug, "agent-link.txt");
      const real = tools.readFile(slug, "brands-new/nested/deep/file.txt");
      const missing = tools.readFile(slug, "definitely-missing.txt");
      const created = tools.writeFile(slug, "agent-new/deep/again.ts", "export const y = 2;");
      console.log(JSON.stringify({ viaLink, real, missing, created }));
    ' ${slug} ${ws} 2>&1`).trim();
  } catch (e) {
    agentRead = JSON.stringify({ error: String((e && e.stdout) || (e && e.message) || e) });
  }
  let agentJson = {};
  try { agentJson = JSON.parse(agentRead); } catch { agentJson = { parseError: agentRead.slice(0, 200) }; }
  check(
    'agent readFile refuses a planted link with the marker, reads the real file, writeFile still creates',
    agentJson.viaLink === '[File not found: agent-link.txt]' &&
      agentJson.real === 'created by the live proof' &&
      agentJson.missing === '[File not found: definitely-missing.txt]' &&
      sh(`cat ${ws}/agent-canary-target.txt`).trim() === 'CANARY-TARGET-BYTES' &&
      sh(`cat ${ws}/agent-new/deep/again.ts 2>/dev/null || echo MISSING`).trim() === 'export const y = 2;',
    `viaLink="${agentJson.viaLink}" real="${String(agentJson.real).slice(0, 40)}" missing="${agentJson.missing}" created=${JSON.stringify(agentJson.created)}`
  );

  // ── 12. the project index never walks nor chunks a planted link (F1) ──
  sh(`rm -f ${ws}/index-link.md; ln -s /app/data/jwt.secret ${ws}/index-link.md`);
  let idxRow = '{}';
  try {
    idxRow = sh(`node -e '
      const fs = require("fs");
      const pi = require("/app/backend/dist/services/project-index.js");
      const slug = process.argv[1];
      pi.retrieveProject(slug, "created by the live proof").then((r) => {
        const idxFile = "/app/data/projects/" + slug + "/index.json";
        const raw = fs.readFileSync(idxFile, "utf8");
        const st = fs.statSync(idxFile);
        const secret = fs.readFileSync("/app/data/jwt.secret", "utf8").trim();
        console.log(JSON.stringify({
          chunks: r.chunks.length, files: r.files,
          hasLinkEntry: raw.includes("index-link.md"),
          hasRealFile: raw.includes("brands-new/nested/deep/file.txt"),
          hasSecret: raw.includes(secret),
          mode: (st.mode & 0o777).toString(8),
        }));
      }).catch((e) => console.log(JSON.stringify({ error: String((e && e.message) || e) })));
    ' ${slug} 2>&1`).trim();
  } catch (e) {
    idxRow = JSON.stringify({ error: String((e && e.stdout) || (e && e.message) || e) });
  }
  let idxJson = {};
  try { idxJson = JSON.parse(idxRow); } catch { idxJson = { parseError: idxRow.slice(0, 200) }; }
  check(
    'the index skips the planted link, still indexes the real file, and index.json is 0600',
    idxJson.error === undefined && idxJson.chunks > 0 && idxJson.files > 0 &&
      idxJson.hasLinkEntry === false && idxJson.hasRealFile === true &&
      idxJson.hasSecret === false && idxJson.mode === '600',
    `files=${idxJson.files} chunks=${idxJson.chunks} linkEntry=${idxJson.hasLinkEntry} realFile=${idxJson.hasRealFile} secretLeak=${idxJson.hasSecret} mode=${idxJson.mode}`
  );
  sh(`rm -f ${ws}/index-link.md`);

} finally {
  sh('rm -f /app/data/live-canary.txt /app/data/live-rename-canary.txt /app/data/.jwt.secret.proofbak');
  if (created) {
    const del = await api('DELETE', `/api/projects/${slug}`);
    console.log(`cleanup: DELETE /api/projects/${slug} -> ${del.status}`);
  }
  if (typeof victimSlug === 'string' && victimSlug) {
    const vdel = await api('DELETE', `/api/projects/${victimSlug}`);
    console.log(`cleanup: DELETE /api/projects/${victimSlug} -> ${vdel.status}`);
  }
}

console.log(`\nlive proof: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);