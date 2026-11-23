// End-to-end test of League Intel sync: the real index.html in Chromium
// against the real Report Cards API, intel store, Lua and Redis
// (backend_runner.py).
//
// Each browser context is one "device", with its own localStorage. The page
// is served under its real production or preview origin, so origin rules are
// the real ones. Sleeper data and /chat (AI synthesis) are mocked in the
// browser; no model is called.
//
// Usage: node intel_sync_e2e.js <gm_repo_dir> <api_port> <shim_port>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const [GM_DIR, API_PORT, SHIM_PORT] = [process.argv[2], process.argv[3], process.argv[4]];
const API = `http://127.0.0.1:${API_PORT}`;
const SHIM = `http://127.0.0.1:${SHIM_PORT}`;
const PROD = 'https://gm-command.netlify.app';
const PREVIEW = 'https://deploy-preview-99--gm-command.netlify.app';
const BACKEND = 'https://ddreportcards.onrender.com';
const SECRET = 'e2e-secret';
const ME = '1000', JOHN = '1001', SAM = '1002', ALEX = '1003';

// ── Fixtures ──
const PLAYERS = {};
for (let i = 0; i < 1500; i++) PLAYERS[String(5000 + i)] = { full_name: 'Player ' + i, first_name: 'P', last_name: 'L' + i, position: ['QB', 'RB', 'WR', 'TE'][i % 4], team: 'KC', age: 24, status: 'Active', search_rank: i + 1 };
const ROSTERS = Array.from({ length: 12 }, (_, i) => ({ roster_id: i + 1, owner_id: String(1000 + i), players: [String(5000 + i * 4), String(5001 + i * 4)], settings: { wins: 5, losses: 3, fpts: 900 } }));
const USERS = Array.from({ length: 12 }, (_, i) => ({ user_id: String(1000 + i), display_name: i === 0 ? 'TitansTrev55' : 'Mgr' + (1000 + i), metadata: { team_name: 'Team ' + (1000 + i) } }));
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

// ── Result bookkeeping ──
let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('  PASS ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}

// ── Direct backend access (the "server truth") ──
async function serverGet() {
  const r = await fetch(API + '/intel', { headers: { 'X-GM-Key': SECRET, Origin: PROD } });
  return r.json();
}
async function serverPut(owner, p, body) {
  const r = await fetch(API + '/intel/' + owner + p, { method: 'PUT', headers: { 'X-GM-Key': SECRET, Origin: PROD, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function flush() {
  const r = await fetch(SHIM, { method: 'POST', headers: { Authorization: 'Bearer e2e-token' }, body: JSON.stringify(['FLUSHALL']) });
  if (!r.ok) throw new Error('flush failed');
}

// ── Devices ──
let browser;
async function device(opts = {}) {
  const origin = opts.origin || PROD;
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, serviceWorkers: 'block', acceptDownloads: true });
  const state = { errors: [], puts: 0, chat: opts.chat || 'ok', chatDelayMs: 0, intel: 'pass', blockPuts: false };
  await ctx.addInitScript(([key, legacy, rawCache]) => {
    if (key !== null && !localStorage.getItem('gmCommandAccessKey')) localStorage.setItem('gmCommandAccessKey', key);
    if (legacy && !localStorage.getItem('gmc_leaguemate_notes')) localStorage.setItem('gmc_leaguemate_notes', JSON.stringify(legacy));
    if (rawCache && !sessionStorage.getItem('seeded')) { localStorage.setItem('gmc_intel_v2', rawCache); sessionStorage.setItem('seeded', '1'); }
  }, [opts.key === undefined ? SECRET : opts.key, opts.legacy || null, opts.rawCache || null]);
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const cors = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT' };
    if (u.origin === origin) {
      if (u.pathname.startsWith('/.netlify/functions/')) return route.fulfill({ status: 200, contentType: 'text/xml', body: '<rss><channel></channel></rss>' });
      let p = path.join(GM_DIR, decodeURIComponent(u.pathname));
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(GM_DIR, 'index.html');
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(p)] || 'application/octet-stream', body: fs.readFileSync(p) });
    }
    if (u.origin === BACKEND && u.pathname.startsWith('/intel')) {
      if (req.method() === 'PUT' && state.blockPuts) return route.abort('failed');
      if (req.method() === 'GET' && state.intel === '503') return route.fulfill({ status: 503, headers: cors, contentType: 'application/json', body: '{"detail":"Intel storage is unavailable."}' });
      if (req.method() === 'GET' && state.intel === 'offline') return route.abort('failed');
      if (req.method() === 'PUT') state.puts++;
      const resp = await route.fetch({ url: API + u.pathname + u.search });
      return route.fulfill({ response: resp });
    }
    if (u.origin === BACKEND && u.pathname === '/chat') {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (state.chatDelayMs) await new Promise(r => setTimeout(r, state.chatDelayMs));
      if (state.chat === 'fail') return route.fulfill({ status: 500, headers: cors, contentType: 'application/json', body: '{"detail":"boom"}' });
      const content = JSON.parse(req.postData()).messages[0].content;
      const notes = [...content.matchAll(/"""\n([^"]*?)\n"""/g)].map(m => m[1]).filter(t => !/^SYNTH:/.test(t));
      const prev = (content.match(/Existing breakdown:\n"""\n(SYNTH:[^\n]*)\n"""/) || [])[1] || 'SYNTH:';
      const text = prev + ' +' + notes.slice(prev === 'SYNTH:' ? 0 : 0).join(' +');
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text }] }) });
    }
    if (u.origin === BACKEND) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '{"status":"ok"}' });
    if (u.hostname === 'api.sleeper.app') {
      let body = [];
      if (/\/v1\/user\//.test(u.pathname)) body = { user_id: ME, display_name: 'TitansTrev55' };
      else if (/\/rosters$/.test(u.pathname)) body = ROSTERS;
      else if (/\/users$/.test(u.pathname)) body = USERS;
      else if (/\/players\/nfl$/.test(u.pathname)) body = PLAYERS;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => state.errors.push(String(e)));
  await page.goto(origin + '/index.html');
  await page.waitForFunction(() => typeof leaguemates !== 'undefined' && leaguemates.length === 11, null, { timeout: 15000 });
  return { ctx, page, state };
}

async function settle(page) {
  // Wait until no sync is running and none is queued.
  await page.waitForFunction(() => !intelSync.inFlight && !intelSync.again, null, { timeout: 15000 });
  await page.waitForTimeout(100);
  await page.waitForFunction(() => !intelSync.inFlight && !intelSync.again, null, { timeout: 15000 });
}
async function syncNowAndSettle(page) { await page.evaluate(() => syncIntel()); await settle(page); }
const st = (page) => page.evaluate(() => intelSync.state);
const view = (page, owner) => page.evaluate((o) => { const lm = leaguemates.find(l => l.id === o); return { realName: lm.realName, blurb: lm.blurb, log: lm.log, outstanding: lm.outstanding, nameRejected: lm.nameRejected }; }, owner);
const cache = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('gmc_intel_v2')));
async function openCard(page, owner) { await page.evaluate((o) => showIntel(), owner); await page.evaluate((o) => { if (!intelOpenCards.has(o)) toggleLMCard(o); }, owner); }
async function addNote(page, owner, text) {
  await openCard(page, owner);
  await page.fill('#ii-' + owner, text);
  await page.click('#aib-' + owner);
  await page.waitForFunction((o) => !intelSynthBusy.has(o), owner, { timeout: 15000 });
  await settle(page);
}
async function setName(page, owner, name) {
  await openCard(page, owner);
  await page.fill('#name-' + owner, name);
  await page.press('#name-' + owner, 'Tab');
  await settle(page);
}

// ── Scenarios ──
const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

scenario('legacy migration with realistic records', async () => {
  await flush();
  const legacy = {
    [JOHN]: { realName: '  John  ', blurb: 'Cheap on WRs; panics after injuries.', log: [
      { date: 'Nov 18', text: 'Always counters low on WRs' },
      { date: 'Nov 12', text: 'Panics after injuries' },
      { date: 'Nov 12', text: 'Panics after injuries' },        // exact duplicate
      { date: 'Nov 10', text: '   ' },                          // blank: ignored
    ] },
    [SAM]: { realName: '', blurb: '', log: [{ date: 'Nov 1', text: 'Loves rookies' }] },
    BCNH: { realName: 'Bogus', blurb: 'x', log: [] },            // not an owner id: ignored
  };
  const d = await device({ legacy });
  await settle(d.page);
  const s = await serverGet();
  const j = s.leaguemates[JOHN];
  check('state synced', (await st(d.page)) === 'synced', await st(d.page));
  check('name migrated (cleaned)', j && j.name && j.name.value === 'John', j && j.name);
  check('duplicate + blank notes collapsed to 2', j && j.observations.length === 2, j && j.observations.map(o => o.text));
  check('oldest note got the lower revision', j && j.observations[0].text === 'Panics after injuries');
  check('breakdown migrated covering both notes', j && j.breakdown && j.breakdown.covers.length === 2 && j.observations.every(o => j.breakdown.covers.includes(o.id)));
  check('owner with only notes migrated, empty name not sent', s.leaguemates[SAM] && s.leaguemates[SAM].observations.length === 1 && s.leaguemates[SAM].name === null);
  check('invalid legacy owner ignored', !('BCNH' in s.leaguemates));
  const legacyRaw = JSON.stringify(legacy);
  check('legacy store byte-identical after migration', (await d.page.evaluate(() => localStorage.getItem('gmc_leaguemate_notes'))) === legacyRaw);
  await syncNowAndSettle(d.page);
  await d.page.reload();
  await d.page.waitForFunction(() => leaguemates.length === 11);
  await settle(d.page);
  check('legacy store byte-identical after re-syncs and reload', (await d.page.evaluate(() => localStorage.getItem('gmc_leaguemate_notes'))) === legacyRaw);
  check('migration not repeated after reload', (await serverGet()).leaguemates[JOHN].observations.length === 2);
  const prompt = await d.page.evaluate(() => window.liveSystemPrompt || '');
  check('chat prompt carries the migrated name and breakdown', prompt.includes('John (Sleeper username Mgr1001') && prompt.includes('Cheap on WRs; panics after injuries.'));
  // Interrupted/re-run migration on a second device with the same notes: no duplicates.
  const d2 = await device({ legacy });
  await settle(d2.page);
  const s2 = await serverGet();
  check('second device with same legacy notes adds no duplicates', s2.leaguemates[JOHN].observations.length === 2 && s2.leaguemates[SAM].observations.length === 1);
  check('no page errors', !d.state.errors.length && !d2.state.errors.length, d.state.errors.concat(d2.state.errors));
  await d.ctx.close(); await d2.ctx.close();
});

scenario('migration never overwrites server data (set or deliberately cleared)', async () => {
  await flush();
  await serverPut(JOHN, '/name', { value: 'Server John', base_rev: 0 });
  const r = await serverPut(ALEX, '/name', { value: 'Alex', base_rev: 0 });
  await serverPut(ALEX, '/name', { value: '', base_rev: r.body.rev });   // cleared on purpose
  const d = await device({ legacy: { [JOHN]: { realName: 'Old John', blurb: '', log: [] }, [ALEX]: { realName: 'Legacy Alex', blurb: '', log: [] } } });
  await settle(d.page);
  const s = await serverGet();
  check('server name kept', s.leaguemates[JOHN].name.value === 'Server John');
  check('cleared server name stays cleared', s.leaguemates[ALEX].name.value === '' && s.leaguemates[ALEX].name.rev > 0);
  const v = await view(d.page, JOHN);
  check('device shows server value', v.realName === 'Server John', v);
  check('rejected local value preserved for restore', v.nameRejected && v.nameRejected.value === 'Old John', v.nameRejected);
  await openCard(d.page, JOHN);
  check('notice rendered', (await d.page.textContent('#lmb-' + JOHN)).includes('Not saved: “Old John”'));
  await d.page.click(`#lmb-${JOHN} .intel-notice-btn`);
  await settle(d.page);
  check('"Use mine" restores it on the server', (await serverGet()).leaguemates[JOHN].name.value === 'Old John');
  check('no page errors', !d.state.errors.length, d.state.errors);
  await d.ctx.close();
});

scenario('interrupted upload survives reload and lands exactly once', async () => {
  await flush();
  const d = await device();
  await settle(d.page);
  d.state.blockPuts = true;
  await addNote(d.page, SAM, 'Overpays for WRs at the deadline');
  const c = await cache(d.page);
  const pending = Object.values(c.lm[SAM].obs).filter(o => !o.rev);
  check('note pending locally after failed upload', pending.length === 1 && c.lm[SAM].breakdown_pending, c.lm[SAM]);
  check('status says will retry', (await st(d.page)) === 'retry');
  check('nothing reached the server', !(SAM in (await serverGet()).leaguemates));
  d.state.blockPuts = false;
  await d.page.reload();
  await d.page.waitForFunction(() => leaguemates.length === 11);
  await settle(d.page);
  const s = (await serverGet()).leaguemates[SAM];
  check('after reload the note is on the server once', s && s.observations.length === 1 && s.observations[0].text === 'Overpays for WRs at the deadline');
  check('breakdown uploaded covering it', s && s.breakdown && s.breakdown.covers[0] === s.observations[0].id);
  // A retried PUT of the same id is idempotent.
  const again = await serverPut(SAM, '/observations/' + s.observations[0].id, { text: s.observations[0].text, date_label: s.observations[0].date_label });
  check('re-sent observation is idempotent', again.status === 200 && again.body.created === false);
  check('no page errors', !d.state.errors.length, d.state.errors);
  await d.ctx.close();
});

scenario('503 and offline reads merge nothing and lose nothing', async () => {
  await flush();
  const d = await device();
  await settle(d.page);
  await addNote(d.page, JOHN, 'Trades picks for vets');
  const before = await cache(d.page);
  for (const mode of ['503', 'offline']) {
    d.state.intel = mode;
    await d.page.reload();
    await d.page.waitForFunction(() => leaguemates.length === 11);
    await settle(d.page);
    const after = await cache(d.page);
    check(mode + ': status retry', (await st(d.page)) === 'retry');
    check(mode + ': local intel unchanged', JSON.stringify(after.lm) === JSON.stringify(before.lm));
    check(mode + ': note still shown', (await view(d.page, JOHN)).log.some(e => e.text === 'Trades picks for vets'));
  }
  d.state.intel = 'pass';
  await syncNowAndSettle(d.page);
  check('recovers to synced', (await st(d.page)) === 'synced');
  check('no page errors', !d.state.errors.length, d.state.errors);
  await d.ctx.close();
});

scenario('401 keeps local changes pending until the key is fixed', async () => {
  await flush();
  const d = await device({ key: 'wrong-key' });
  await settle(d.page);
  check('status auth', (await st(d.page)) === 'auth');
  await setName(d.page, ALEX, 'Alex');
  check('name kept locally', (await view(d.page, ALEX)).realName === 'Alex');
  check('nothing on server', !(ALEX in (await serverGet()).leaguemates));
  await d.page.evaluate((k) => localStorage.setItem('gmCommandAccessKey', k), SECRET);
  await syncNowAndSettle(d.page);
  check('saved once the key is right', (await serverGet()).leaguemates[ALEX].name.value === 'Alex');
  await d.ctx.close();
});

scenario('AI failure keeps the note; Re-synthesize folds it in', async () => {
  await flush();
  const d = await device();
  await settle(d.page);
  await addNote(d.page, JOHN, 'First note');
  d.state.chat = 'fail';
  await addNote(d.page, JOHN, 'Second note');
  let s = (await serverGet()).leaguemates[JOHN];
  check('both notes saved on server', s.observations.length === 2);
  check('breakdown only covers the first', s.breakdown.covers.length === 1);
  let v = await view(d.page, JOHN);
  check('one note outstanding', v.outstanding.length === 1, v.outstanding);
  await d.page.evaluate(() => renderIntel());
  check('Re-synthesize offered', !!(await d.page.$('#rsb-' + JOHN)));
  d.state.chat = 'ok';
  await d.page.click('#rsb-' + JOHN);
  await d.page.waitForFunction((o) => !document.getElementById('rsb-' + o), JOHN, { timeout: 15000 });
  await settle(d.page);
  s = (await serverGet()).leaguemates[JOHN];
  check('breakdown now covers both', s.breakdown.covers.length === 2 && s.breakdown.value.includes('Second note'), s.breakdown);
  check('no page errors', !d.state.errors.length, d.state.errors);
  await d.ctx.close();
});

scenario('concurrent synthesis on two devices: loser keeps its note', async () => {
  await flush();
  const a = await device(), b = await device();
  await settle(a.page); await settle(b.page);
  await addNote(a.page, SAM, 'Base note');
  await syncNowAndSettle(b.page);
  // B starts a slow synthesis on the shared breakdown; A finishes one first.
  b.state.chatDelayMs = 1500;
  await openCard(b.page, SAM);
  await b.page.fill('#ii-' + SAM, 'Note from B');
  const bClick = b.page.click('#aib-' + SAM);
  await new Promise(r => setTimeout(r, 200));
  await addNote(a.page, SAM, 'Note from A');
  await bClick;
  check('B stays busy across re-renders', await b.page.evaluate((o) => intelSynthBusy.has(o) && document.getElementById('aib-' + o).disabled, SAM));
  await b.page.waitForFunction((o) => !intelSynthBusy.has(o), SAM, { timeout: 15000 });
  await settle(b.page);
  const s = (await serverGet()).leaguemates[SAM];
  const ids = Object.fromEntries(s.observations.map(o => [o.text, o.id]));
  check('all three notes on server', s.observations.length === 3, s.observations.map(o => o.text));
  check("A's breakdown won", s.breakdown.value.includes('Note from A') && !s.breakdown.value.includes('Note from B'), s.breakdown.value);
  check("B's note not covered", !s.breakdown.covers.includes(ids['Note from B']));
  const v = await view(b.page, SAM);
  check('B adopted the winning breakdown', v.blurb === s.breakdown.value, { b: v.blurb, server: s.breakdown.value, cache: (await cache(b.page)).lm[SAM] });
  check("B shows its note as outstanding", v.outstanding.length === 1 && v.outstanding[0] === ids['Note from B'], v.outstanding);
  const bc = (await cache(b.page)).lm[SAM];
  check("B's losing breakdown is kept, not discarded", bc.breakdown_rejected && bc.breakdown_rejected.value.includes('Note from B'), bc.breakdown_rejected);
  await b.page.evaluate(() => renderIntel());
  check("B is told and offered Use mine", (await b.page.textContent('#lmb-' + SAM)).includes('A newer breakdown from another device replaced yours'));
  b.state.chatDelayMs = 0;
  await b.page.evaluate(() => renderIntel());
  await b.page.click('#rsb-' + SAM);
  await b.page.waitForFunction((o) => !document.getElementById('rsb-' + o), SAM, { timeout: 15000 });
  await settle(b.page);
  const s2 = (await serverGet()).leaguemates[SAM];
  check('re-synthesis supersedes the kept rejected breakdown', !(await cache(b.page)).lm[SAM].breakdown_rejected);
  check('after re-synthesis all notes covered', s2.breakdown.covers.length === 3, { s2: s2.breakdown, state: await st(b.page), cache: (await cache(b.page)).lm[SAM] });
  check('no page errors', !a.state.errors.length && !b.state.errors.length, a.state.errors.concat(b.state.errors));
  await a.ctx.close(); await b.ctx.close();
});

scenario('name conflict: server wins, rejected value preserved', async () => {
  await flush();
  const a = await device(), b = await device();
  await setName(a.page, JOHN, 'John');
  await syncNowAndSettle(b.page);
  await setName(a.page, JOHN, 'Jon');
  b.state.intel = 'offline';           // B has not seen A's change
  await setName(b.page, JOHN, 'Johnny');
  b.state.intel = 'pass';
  await syncNowAndSettle(b.page);
  check('server keeps the newer name', (await serverGet()).leaguemates[JOHN].name.value === 'Jon');
  const v = await view(b.page, JOHN);
  check('B shows server value + rejected value', v.realName === 'Jon' && v.nameRejected && v.nameRejected.value === 'Johnny', v);
  await a.ctx.close(); await b.ctx.close();
});

scenario('independent fields: name and breakdown edits do not clobber', async () => {
  await flush();
  const a = await device(), b = await device();
  await settle(a.page); await settle(b.page);
  b.state.intel = 'offline';
  await setName(a.page, ALEX, 'Alex');
  await addNote(b.page, ALEX, 'Hoards TEs');
  b.state.intel = 'pass';
  await syncNowAndSettle(b.page);
  const s = (await serverGet()).leaguemates[ALEX];
  check('name from A and note+breakdown from B both kept', s.name.value === 'Alex' && s.observations.length === 1 && s.breakdown && s.breakdown.covers.length === 1);
  await a.ctx.close(); await b.ctx.close();
});

scenario('preview reads real intel but never writes', async () => {
  await flush();
  await serverPut(JOHN, '/name', { value: 'John', base_rev: 0 });
  const p = await device({ origin: PREVIEW });
  await settle(p.page);
  check('preview state', (await st(p.page)) === 'preview');
  check('preview shows real data', (await view(p.page, JOHN)).realName === 'John');
  await setName(p.page, JOHN, 'Preview Edit');
  await addNote(p.page, JOHN, 'Preview note');
  await syncNowAndSettle(p.page);
  const s = (await serverGet()).leaguemates[JOHN];
  check('server unchanged', s.name.value === 'John' && s.observations.length === 0 && !s.breakdown);
  check('no PUT was sent', p.state.puts === 0, p.state.puts);
  check('preview keeps its edit locally', (await view(p.page, JOHN)).realName === 'Preview Edit');
  await p.page.evaluate(() => showIntel());
  check('preview banner shown', (await p.page.textContent('#intel-sync-status')).startsWith('Preview'));
  // And the server refuses a preview-origin write even if one were sent.
  const r = await fetch(API + '/intel/' + JOHN + '/name', { method: 'PUT', headers: { 'X-GM-Key': SECRET, Origin: PREVIEW, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'x', base_rev: 1 }) });
  check('server rejects preview-origin write (403)', r.status === 403);
  check('no page errors', !p.state.errors.length, p.state.errors);
  await p.ctx.close();
});

scenario('server wipe is restored from the device', async () => {
  await flush();
  const d = await device();
  await setName(d.page, JOHN, 'John');
  await addNote(d.page, JOHN, 'Sells at the deadline');
  await flush();
  await d.page.reload();
  await d.page.waitForFunction(() => leaguemates.length === 11);
  await settle(d.page);
  const s = (await serverGet());
  check('server re-initialized', s.initialized);
  check('name, note and breakdown restored', s.leaguemates[JOHN].name.value === 'John' && s.leaguemates[JOHN].observations.length === 1 && s.leaguemates[JOHN].breakdown.covers.length === 1);
  check('status says restored', (await d.page.evaluate(() => intelStatusText())).startsWith('Server copy was missing'));
  await d.ctx.close();
});

scenario('export / import recovery, additive only', async () => {
  await flush();
  const a = await device();
  await setName(a.page, JOHN, 'John');
  await addNote(a.page, JOHN, 'Exported note');
  await addNote(a.page, SAM, 'Another note');
  const [dl] = await Promise.all([a.page.waitForEvent('download'), a.page.evaluate(() => intelExport())]);
  const file = path.join(require('os').tmpdir(), 'intel-export-e2e.json');
  await dl.saveAs(file);
  const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('export has notes, name and breakdown', exported.format === 'gm-command-intel' && exported.leaguemates[JOHN].name === 'John' && exported.leaguemates[JOHN].observations.length === 1 && exported.leaguemates[JOHN].breakdown.covers.length === 1);
  await a.ctx.close();
  // Worst case: server wiped AND device cache gone. Import into a fresh device.
  await flush();
  const c = await device();
  await settle(c.page);
  const summary = await c.page.evaluate(async (data) => { const s = await intelApplyImport(data); lmSaveNotes(); await syncIntel(); return s; }, exported);
  await settle(c.page);
  const s = (await serverGet()).leaguemates;
  check('import restored everything', s[JOHN].name.value === 'John' && s[JOHN].observations.length === 1 && s[JOHN].breakdown.covers.length === 1 && s[SAM].observations.length === 1, summary);
  check('ids preserved through export/import', s[JOHN].observations[0].id === exported.leaguemates[JOHN].observations[0].id);
  // Re-import a file with a different name: reported, not applied.
  exported.leaguemates[JOHN].name = 'Different';
  const summary2 = await c.page.evaluate(async (data) => { const s = await intelApplyImport(data); lmSaveNotes(); await syncIntel(); return s; }, exported);
  await settle(c.page);
  check('conflicting import reported', summary2.includes('name kept as “John”'), summary2);
  check('conflicting import not applied', (await serverGet()).leaguemates[JOHN].name.value === 'John');
  check('garbage file rejected', (await c.page.evaluate(() => intelApplyImport({ hello: 1 }))).startsWith('Not a GM Command intel export'));
  check('no page errors', !c.state.errors.length, c.state.errors);
  await c.ctx.close();
});

scenario('unreadable cache is preserved, not overwritten', async () => {
  await flush();
  const d = await device({ rawCache: '{"schema":2,"lm":{"1001":{trunc' });
  await setName(d.page, JOHN, 'John');
  const kept = await d.page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('gmc_intel_v2_unreadable_')).map(k => localStorage.getItem(k)));
  check('raw unreadable cache kept under its own key', kept.length === 1 && kept[0] === '{"schema":2,"lm":{"1001":{trunc', kept);
  check('app still works', (await serverGet()).leaguemates[JOHN].name.value === 'John');
  check('no page errors', !d.state.errors.length, d.state.errors);
  await d.ctx.close();
});

scenario('device storage failure is surfaced', async () => {
  await flush();
  const d = await device();
  await settle(d.page);
  await d.page.evaluate(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === 'gmc_intel_v2') throw new DOMException('full', 'QuotaExceededError'); return orig.call(this, k, v); };
  });
  await setName(d.page, ALEX, 'Alex');
  check('status warns to export', (await d.page.evaluate(() => intelStatusText())).startsWith('Couldn’t save on this device'));
  check('no page errors', !d.state.errors.length, d.state.errors);
  await d.ctx.close();
});

scenario('pre-merge backup page: read-only, verifiable, restorable', async () => {
  await flush();
  const legacy = { [JOHN]: { realName: 'John', blurb: 'Cheap on WRs.', log: [{ date: 'Nov 18', text: 'Always counters low on WRs' }, { date: 'Nov 12', text: 'Panics after injuries' }] },
                   [SAM]: { realName: '', blurb: '', log: [{ date: 'Nov 1', text: 'Loves rookies' }] } };
  // The phone as it is today: old data, the backup page opened directly (the
  // sync code never loads in this context).
  const ctx = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  await ctx.addInitScript((l) => { if (!localStorage.getItem('gmc_leaguemate_notes')) { localStorage.setItem('gmc_leaguemate_notes', JSON.stringify(l)); localStorage.setItem('gmCommandAccessKey', 'phone-key'); } }, legacy);
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin === PROD && u.pathname === '/intel-backup.html') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(GM_DIR, 'intel-backup.html')) });
    return route.abort();
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(PROD + '/intel-backup.html');
  await page.waitForFunction(() => document.getElementById('fp').textContent !== '—');
  const before = await page.evaluate(() => JSON.stringify(Object.assign({}, localStorage)));
  check('summary counts', (await page.textContent('#summary')).startsWith('2 leaguemates with intel · 3 notes'), await page.textContent('#summary'));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const file = path.join(require('os').tmpdir(), 'intel-legacy-backup-e2e.json');
  await dl.saveAs(file);
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('backup holds the exact stored text', backup.items.gmc_leaguemate_notes === JSON.stringify(legacy));
  check('backup never contains the access key', !fs.readFileSync(file, 'utf8').includes('phone-key'));
  await page.setInputFiles('#verify', file);
  await page.waitForFunction(() => document.getElementById('verified').textContent);
  check('saved copy verifies against the device', (await page.textContent('#verified')).startsWith('✓ Backup matches this device exactly'), await page.textContent('#verified'));
  const tampered = Object.assign({}, backup, { items: { gmc_leaguemate_notes: backup.items.gmc_leaguemate_notes.replace('John', 'Jxhn') } });
  const tfile = file.replace('.json', '-tampered.json'); fs.writeFileSync(tfile, JSON.stringify(tampered));
  await page.evaluate(() => { document.getElementById('verified').textContent = ''; });
  await page.setInputFiles('#verify', tfile);
  await page.waitForFunction(() => document.getElementById('verified').textContent);
  check('damaged copy is detected', (await page.textContent('#verified')).includes('damaged'));
  check('backup page wrote nothing to storage', (await page.evaluate(() => JSON.stringify(Object.assign({}, localStorage)))) === before);
  check('no page errors', !errors.length, errors);
  await ctx.close();
  // Worst case after merge: phone wiped and server empty. Restore from the file.
  const c = await device();
  await settle(c.page);
  const summary = await c.page.evaluate(async (data) => { const s = await intelApplyImport(data); lmSaveNotes(); await syncIntel(); return s; }, backup);
  await settle(c.page);
  const s = (await serverGet()).leaguemates;
  check('backup restores names, notes and breakdown', s[JOHN].name.value === 'John' && s[JOHN].observations.length === 2 && s[JOHN].breakdown.covers.length === 2 && s[SAM].observations.length === 1, summary);
  // Same notes again (e.g. also migrated from the device): no duplicates.
  await c.page.evaluate(async (data) => { await intelApplyImport(data); lmSaveNotes(); await syncIntel(); }, backup);
  await settle(c.page);
  check('re-importing the backup adds no duplicates', (await serverGet()).leaguemates[JOHN].observations.length === 2);
  await c.ctx.close();
  // An empty browser: nothing to back up, and it says so.
  const ctx2 = await browser.newContext({ serviceWorkers: 'block' });
  await ctx2.route('**/*', (route) => route.request().url().endsWith('/intel-backup.html') ? route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(GM_DIR, 'intel-backup.html')) }) : route.abort());
  const p2 = await ctx2.newPage();
  await p2.goto(PROD + '/intel-backup.html');
  await p2.waitForFunction(() => document.getElementById('summary').textContent !== 'Reading…');
  check('empty browser says nothing to back up', (await p2.textContent('#summary')).startsWith('No League Intel found'));
  await ctx2.close();
});

scenario('no key: device-only, nothing sent', async () => {
  await flush();
  const d = await device({ key: null });
  await settle(d.page);
  check('status nokey', (await st(d.page)) === 'nokey');
  await setName(d.page, JOHN, 'Local Only');
  check('kept locally', (await view(d.page, JOHN)).realName === 'Local Only');
  check('nothing sent', d.state.puts === 0 && !(await serverGet()).initialized);
  await d.ctx.close();
});

if (process.env.SHOTS) scenario('screenshots', async () => {
  await flush();
  const d = await device();
  await setName(d.page, JOHN, 'John');
  await addNote(d.page, JOHN, 'Always counters low on WRs');
  d.state.chat = 'fail';
  await addNote(d.page, JOHN, 'Panics after injuries');
  d.state.blockPuts = true;
  await addNote(d.page, JOHN, 'Sells vets at the deadline');
  await d.page.evaluate(() => { intelFocusId = null; showIntel(); });
  await d.page.evaluate((o) => { if (!intelOpenCards.has(o)) toggleLMCard(o); renderIntel(); }, JOHN);
  await d.page.screenshot({ path: process.env.SHOTS + '/intel-card.png', fullPage: false });
  await d.page.evaluate(() => nav('settings'));
  await d.page.screenshot({ path: process.env.SHOTS + '/settings.png' });
  const p = await device({ origin: PREVIEW });
  await settle(p.page);
  await p.page.evaluate(() => showIntel());
  await p.page.screenshot({ path: process.env.SHOTS + '/preview-intel.png' });
  check('no page errors', !d.state.errors.length && !p.state.errors.length, d.state.errors.concat(p.state.errors));
  await d.ctx.close(); await p.ctx.close();
});

(async () => {
  browser = await chromium.launch();
  for (const [name, fn] of scenarios.filter(([n]) => n.startsWith(process.env.ONLY || ''))) {
    console.log('\n# ' + name);
    try { await fn(); }
    catch (e) { failures++; console.log('  FAIL (exception) ' + (e && e.stack || e)); }
  }
  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
