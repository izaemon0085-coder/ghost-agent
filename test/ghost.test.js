import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';
import { createGhost, REST_AFTER_MS } from '../ghost.js';

function setup(ageGroup = 'adult') {
  let t = Date.parse('2026-11-03T10:00:00');
  const g = createGhost({ now: () => t });
  g.upsertUser({ gameId: 'h_me', name: 'さいとう', ageGroup });
  return { g, step: (ms) => { t += ms; }, at: (iso) => { t = Date.parse(iso); } };
}
const agents = (r) => r.lines.map((l) => l.agent);

test('はじめての記録がゴーストになる → 抜くと自己ベスト（ウサギ）→ 抜けないとシバが応援', () => {
  const { g } = setup();
  g.start('h_me');
  const first = g.lap('h_me', 30000);
  assert.equal(first.firstEver, true);
  assert.match(first.lines[0].text, /きみのゴーストになる/);
  const pb = g.lap('h_me', 28500);
  assert.equal(pb.isBest, true);
  assert.match(pb.lines[0].text, /1\.50 秒速い/);
  assert.deepEqual(agents(pb), ['ghost', 'usagi']);
  const slow = g.lap('h_me', 31000);
  assert.equal(slow.isBest, false);
  assert.deepEqual(agents(slow), ['ghost', 'shiba']);
  assert.equal(g.summary('h_me').best, 28500);
  assert.equal(g.report('h_me').bests, 1, 'はじめての記録は「更新」に数えない');
});

test('やさしさの強さで、言い方が変わる', () => {
  const { g } = setup();
  g.setSettings('h_me', { tone: 'gentle' });
  g.lap('h_me', 30000);
  assert.match(g.lap('h_me', 31000).lines[1].text, /ちゃんと続けられてる/);
  g.setSettings('h_me', { tone: 'fire' });
  assert.match(g.lap('h_me', 31000).lines[1].text, /次は抜く/);
  assert.throws(() => g.setSettings('h_me', { tone: 'こわい' }), /やさしさ/);
});

test('種目ごとに、別のゴースト', () => {
  const { g } = setup();
  g.lap('h_me', 20000);
  g.setSettings('h_me', { activity: 'walk' });
  assert.equal(g.lap('h_me', 90000).firstEver, true, 'ウォーキングは、はじめての記録');
  assert.equal(g.summary('h_me').best, 90000);
});

test('ヤマネコの分析：後半がおそいと知らせる', () => {
  const { g } = setup();
  for (const ms of [20000, 20000, 20000, 23000, 23000]) g.lap('h_me', ms);
  const r = g.lap('h_me', 23000);
  assert.ok(r.lines.some((l) => l.agent === 'yamaneko' && /おそい/.test(l.text)));
});

test('フクロウの見守り：ラップが落ちてきた・長く続けすぎ（子どもは早めに）', () => {
  const tired = setup();
  for (const ms of [20000, 20500, 25000]) tired.g.lap('h_me', ms);
  const r = tired.g.lap('h_me', 25500);
  assert.equal(r.rest, true);
  assert.ok(r.lines.some((l) => l.agent === 'fukurou' && /お医者さん/.test(l.text)));

  const kid = setup('child');
  kid.g.start('h_me');
  kid.g.lap('h_me', 20000);
  kid.step(REST_AFTER_MS.child + 1000);
  assert.equal(kid.g.lap('h_me', 20000).rest, true);
});

test('昨日との比べ：今日のベストと昨日のベスト', () => {
  const { g, at } = setup();
  at('2026-11-02T18:00:00');
  g.lap('h_me', 30000);
  at('2026-11-03T18:00:00');
  g.start('h_me');
  g.lap('h_me', 29000);
  const s = g.summary('h_me');
  assert.equal(s.yesterday.best, 30000);
  assert.equal(s.today.best, 29000);
  assert.equal(s.days, 2);
});

test('記録は本人のもの：全部消せる。おかしな時間は記録しない', () => {
  const { g } = setup();
  assert.throws(() => g.lap('h_me', 300), /1秒/);
  assert.throws(() => g.lap('h_me', 2 * 60 * 60 * 1000), /60分/);
  g.lap('h_me', 30000);
  g.deleteAll('h_me');
  assert.equal(g.has('h_me'), false);
});

// ---- ともはねでログイン（ともはねの代わりを使う） ----
let server;
let base;
const reported = [];
const fakeTomohane = async (url, opts = {}) => {
  const u = new URL(url);
  if (opts.headers?.['X-Link-Secret'] !== 'test-secret') return { ok: false, json: async () => ({}) };
  if (u.pathname === '/api/link/ghost-ticket/good-ticket-1234567890') return { ok: true, json: async () => ({ gameId: 'h_abc', name: 'さいとう', ageGroup: 'adult' }) };
  if (u.pathname === '/api/link/ghost-results') {
    reported.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({}) };
  }
  return { ok: false, json: async () => ({}) };
};
before(async () => {
  server = http.createServer(createApp({ tomohaneUrl: 'http://tomohane.test', linkSecret: 'test-secret', fetchImpl: fakeTomohane, ghost: createGhost() }));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('ともはねでログイン → ラップ → 自己ベストの回数と日数だけが ともはね にとどく', async () => {
  assert.equal((await fetch(`${base}/api/lap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ms":30000}' })).status, 401);
  const cb = await fetch(`${base}/auth/callback?ticket=good-ticket-1234567890`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  const cookie = cb.headers.get('set-cookie').split(';')[0];
  const post = async (path, body) => (await fetch(base + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  await post('/api/start', {});
  await post('/api/lap', { ms: 30000 });
  const r = await post('/api/lap', { ms: 29000 });
  assert.equal(r.isBest, true);
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(reported.at(-1), { gameId: 'h_abc', bests: 1, days: 1 }, 'ラップの記録そのものは送らない');
  await post('/api/delete', {});
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(reported.at(-1), { gameId: 'h_abc', bests: 0, days: 0 }, '消したら、ともはねの数も 0 に');
});
