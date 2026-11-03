// ゴーストエージェント（β版）：昨日の自分と競う。ラップを計って、テレビに「今日・昨日・差」を出す
// 「ともはねでログイン」：ともはねが出した1分だけ・1回だけの通行証を、ともはねに確かめる。パスワードはここに置かない
// ともはねに返すのは「自己ベストを更新した回数」と「続けた日数」だけ。外部パッケージなし
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGhost, HttpError, ACTIVITIES, TONES } from './ghost.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const COOKIE = 'ghost_session';
export const TOMOHANE_URL = (process.env.TOMOHANE_URL || 'http://localhost:3000').replace(/\/+$/, '');
export const LINK_SECRET = process.env.LINK_SECRET || 'tomohane-dev-link-secret';

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 8 * 1024) throw new HttpError(413, 'リクエストが大きすぎます');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'JSON の形式が正しくありません');
  }
}
const readCookie = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
};

// GHOST_DATA で、記録の置き場所を変えられる（ふだんは data/。git に入らない）
export function createApp({ tomohaneUrl = TOMOHANE_URL, linkSecret = LINK_SECRET, fetchImpl = fetch, ghost = createGhost({ file: join(process.env.GHOST_DATA || join(ROOT, 'data'), 'ghost.json') }) } = {}) {
  const sessions = new Map(); // トークン → gameId
  // 自己ベストの回数と続けた日数だけを ともはね に知らせる（つながらなくても、ゴーストは止めない）
  const report = (r) => fetchImpl(`${tomohaneUrl}/api/link/ghost-results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Link-Secret': linkSecret },
    body: JSON.stringify(r),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});

  const me = (req) => {
    const id = sessions.get(readCookie(req, COOKIE));
    return ghost.has(id) ? id : null;
  };
  const need = (req) => {
    const id = me(req);
    if (!id) throw new HttpError(401, 'ともはねでログインしてください');
    return id;
  };

  const routes = [
    ['GET', '/api/health', () => ({ ok: true })],
    ['GET', '/api/config', () => ({ tomohaneUrl, activities: ACTIVITIES, tones: TONES })],
    ['GET', '/api/state', ({ req }) => (me(req) ? ghost.summary(me(req)) : null)],
    ['POST', '/api/settings', ({ req, body }) => ghost.setSettings(need(req), body)],
    ['POST', '/api/start', ({ req }) => {
      ghost.start(need(req));
      return ghost.summary(me(req));
    }],
    ['POST', '/api/stop', ({ req }) => {
      ghost.stop(need(req));
      return ghost.summary(me(req));
    }],
    ['POST', '/api/lap', ({ req, body }) => {
      const id = need(req);
      const r = ghost.lap(id, Number(body.ms));
      if (r.isBest || r.firstEver) report(r.report);
      return { ...r, report: undefined, summary: ghost.summary(id) };
    }],
    // 記録は本人のもの：全部消す（ともはねの数も 0 にもどす）
    ['POST', '/api/delete', ({ req }) => {
      const id = need(req);
      report({ gameId: id, bests: 0, days: 0 });
      ghost.deleteAll(id);
      return { ok: true };
    }],
  ];

  const sendJson = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(data));
  };

  async function callback(req, res, url) {
    const ticket = url.searchParams.get('ticket') || '';
    if (!/^[\w-]{16,64}$/.test(ticket)) throw new HttpError(400, '通行証がありません');
    let info;
    try {
      const r = await fetchImpl(`${tomohaneUrl}/api/link/ghost-ticket/${ticket}`, { headers: { 'X-Link-Secret': linkSecret }, signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error();
      info = await r.json();
    } catch {
      throw new HttpError(401, '通行証を確かめられませんでした。ともはねからもう一度どうぞ');
    }
    const u = ghost.upsertUser(info);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, u.gameId);
    res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`, Location: '/' });
    res.end();
  }

  async function serveStatic(pathname, res) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'URL が正しくありません'); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = resolve(PUBLIC, `.${rel}`);
    if (!file.startsWith(PUBLIC + sep)) throw new HttpError(403, 'Forbidden');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      throw new HttpError(404, 'Not Found');
    }
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/auth/callback' && req.method === 'GET') return await callback(req, res, url);
      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        sessions.delete(readCookie(req, COOKIE));
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
      }
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (req.method !== 'GET' && origin && origin !== 'null') {
          let host = null;
          try { host = new URL(origin).host; } catch { /* noop */ }
          if (host !== req.headers.host) throw new HttpError(403, 'ほかのページからは操作できません');
        }
        const route = routes.find(([m, p]) => m === req.method && p === url.pathname);
        if (!route) throw new HttpError(404, 'API が見つかりません');
        const body = req.method === 'POST' ? await readJson(req) : {};
        return sendJson(res, 200, await route[2]({ req, body }));
      }
      if (req.method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
      return await serveStatic(url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return sendJson(res, status, { error: status === 500 ? 'サーバーエラーが発生しました' : err.message });
    }
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3500;
  if (!process.env.LINK_SECRET) console.warn('⚠️ LINK_SECRET が未設定です（開発用の値を使います）。本番では ともはね と同じ値を設定してください');
  http.createServer(createApp()).listen(port, () => console.log(`ゴーストエージェント（β版）起動: http://localhost:${port}/`));
}
