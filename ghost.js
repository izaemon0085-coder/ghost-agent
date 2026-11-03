// ゴーストエージェントの頭脳：ラップの記録・ゴースト（自分の自己ベスト）・キャラのひとこと・見守り
// 合言葉は「昨日の自分をちょっと超える」。競争より、自分の相棒
// ・記録は本人のもの。いつでも全部消せる。ほかの人には見せない
// ・ともはねに返すのは「自己ベストを更新した回数」と「続けた日数」だけ
// ・ケガや体調の医療の判断はしない（休けいをすすめるところまで）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const ACTIVITIES = { rc: 'ラジコン', run: 'ランニング', walk: 'ウォーキング', rehab: 'リハビリの歩行', other: 'そのほか' };
export const TONES = { fire: '燃える', normal: 'ふつう', gentle: 'やさしい' };
export const MIN_LAP_MS = 1000;
export const MAX_LAP_MS = 60 * 60 * 1000;
// 🦉 見守り：これより長く続けたら、休けいをすすめる（年齢の区分ごと）
export const REST_AFTER_MS = { child: 20 * 60 * 1000, teen: 30 * 60 * 1000, adult: 45 * 60 * 1000 };
const MAX_LAPS = 5000; // ひとりぶんの記録の上限（古いものから消す）

const sec = (ms) => (ms / 1000).toFixed(2);
const dayOf = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const say = (agent, text) => ({ agent, text });

// やさしさの強さで、シバとウサギの言い方を変える
const CHEER = {
  fire: { best: 'きたーっ！ 自己ベスト！ このまま伝説つくっちゃおう ♪', keep: 'まだまだいけるっす！ 次は抜くっす！' },
  normal: { best: '自己ベストおめでとう！ すごいよ ♪', keep: 'ナイスっす！ その調子っす！' },
  gentle: { best: '自己ベストだね。昨日の自分を、ちょっと超えたよ ♪', keep: 'ちゃんと続けられてるのが、すごいっす。' },
};

export function createGhost({ file = null, now = () => Date.now() } = {}) {
  const saved = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { users: {} };
  const users = saved.users;
  const sessions = new Map(); // gameId → { id, startedAt, laps: [ms] }
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ users }, null, 2));
  };
  const requireUser = (id) => {
    const u = id && users[id];
    if (!u) throw new HttpError(401, 'ともはねでログインしてください');
    return u;
  };
  const lapsOf = (u, activity) => u.laps.filter((l) => l.activity === activity);
  const bestOf = (laps) => (laps.length ? Math.min(...laps.map((l) => l.ms)) : null);

  function report(u) {
    return { gameId: u.gameId, bests: u.bestCount, days: new Set(u.laps.map((l) => dayOf(l.at))).size };
  }

  return {
    upsertUser({ gameId, name, ageGroup }) {
      if (!gameId || !name || !REST_AFTER_MS[ageGroup]) throw new HttpError(400, 'ともはねからの情報が足りません');
      users[gameId] ??= { gameId, settings: { activity: 'rc', tone: 'normal' }, laps: [], bestCount: 0 };
      Object.assign(users[gameId], { name, ageGroup });
      save();
      return users[gameId];
    },
    has: (id) => Boolean(id && users[id]),

    setSettings(id, { activity, tone }) {
      const u = requireUser(id);
      if (activity !== undefined) {
        if (!ACTIVITIES[activity]) throw new HttpError(400, '種目がちがいます');
        u.settings.activity = activity;
      }
      if (tone !== undefined) {
        if (!TONES[tone]) throw new HttpError(400, 'やさしさの強さがちがいます');
        u.settings.tone = tone;
      }
      save();
      return u.settings;
    },

    start(id) {
      requireUser(id);
      const s = { id: randomBytes(6).toString('hex'), startedAt: now(), laps: [] };
      sessions.set(id, s);
      return s;
    },
    stop(id) {
      sessions.delete(id);
    },

    // 1周（1回）の時間を記録する。キャラのひとことと、見守りの知らせを返す
    lap(id, ms) {
      const u = requireUser(id);
      const s = sessions.get(id) ?? this.start(id);
      if (!Number.isFinite(ms) || ms < MIN_LAP_MS || ms > MAX_LAP_MS) throw new HttpError(400, '1周の時間は1秒〜60分にしてください');
      const { activity, tone } = u.settings;
      const prevBest = bestOf(lapsOf(u, activity));
      const isBest = prevBest === null || ms < prevBest;
      u.laps.push({ activity, ms: Math.round(ms), at: now(), session: s.id });
      if (u.laps.length > MAX_LAPS) u.laps.splice(0, u.laps.length - MAX_LAPS);
      if (isBest && prevBest !== null) u.bestCount += 1;
      s.laps.push(ms);
      save();

      const lines = [];
      // 👻 ゴースト（自己ベストの自分）
      if (prevBest === null) lines.push(say('ghost', 'はじめての記録。これが、きみのゴーストになる。次は、ぼくと勝負だ。'));
      else if (isBest) lines.push(say('ghost', `抜かれた…！ ぼくより ${sec(prevBest - ms)} 秒速い。新しいゴーストは、きみだ。`));
      else if (ms - prevBest < 500) lines.push(say('ghost', `ほぼ並んだ！ ぼくとの差は ${sec(ms - prevBest)} 秒。`));
      else lines.push(say('ghost', `ぼくのほうが ${sec(ms - prevBest)} 秒速い。次の1周で、取りかえしてみて。`));
      // 🐰 ウサギ・🐕 シバ
      lines.push(isBest && prevBest !== null ? say('usagi', CHEER[tone].best) : say('shiba', CHEER[tone].keep));
      // 🐱 ヤマネコの分析（3周ごと）
      if (s.laps.length >= 6 && s.laps.length % 3 === 0) {
        const first = avg(s.laps.slice(0, 3));
        const last = avg(s.laps.slice(-3));
        if (last > first * 1.05) lines.push(say('yamaneko', `後半の3周は、はじめの3周より平均 ${sec(last - first)} 秒おそい。ペース配分を見直そう。`));
        else if (last < first * 0.97) lines.push(say('yamaneko', `後半のほうが平均 ${sec(first - last)} 秒速い。いい上げ方だ。`));
      }
      // 🦉 見守り：長く続けすぎ・疲れの兆し（医療の判断はしない）
      let rest = false;
      const sessionBest = Math.min(...s.laps);
      if (now() - s.startedAt > REST_AFTER_MS[u.ageGroup]) {
        rest = true;
        lines.push(say('fukurou', 'ほう、もう長く続けていますな。今日はここまでにして、体を休めましょう。'));
      } else if (s.laps.length >= 4 && s.laps.slice(-2).every((x) => x > sessionBest * 1.2)) {
        rest = true;
        lines.push(say('fukurou', 'ほう、ラップが落ちてきましたな。疲れのしるしかもしれませんぞ。無理をせず、休けいを。痛みがあれば大人やお医者さんに。'));
      }
      return { ms, isBest, firstEver: prevBest === null, best: isBest ? ms : prevBest, lines, rest, report: report(u) };
    },

    // 今日・昨日・自己ベスト
    summary(id) {
      const u = requireUser(id);
      const { activity } = u.settings;
      const laps = lapsOf(u, activity);
      const today = dayOf(now());
      const yesterday = dayOf(now() - 86400000);
      const t = laps.filter((l) => dayOf(l.at) === today).map((l) => l.ms);
      const y = laps.filter((l) => dayOf(l.at) === yesterday).map((l) => l.ms);
      const s = sessions.get(id);
      return {
        name: u.name, ageGroup: u.ageGroup, settings: u.settings, activityLabel: ACTIVITIES[activity],
        best: bestOf(laps),
        today: { laps: t, best: t.length ? Math.min(...t) : null, avg: avg(t) },
        yesterday: { best: y.length ? Math.min(...y) : null, avg: avg(y) },
        bestCount: u.bestCount,
        days: new Set(u.laps.map((l) => dayOf(l.at))).size,
        session: s ? { startedAt: s.startedAt, laps: s.laps.length } : null,
      };
    },

    // 記録は本人のもの：全部消す
    deleteAll(id) {
      requireUser(id);
      delete users[id];
      sessions.delete(id);
      save();
    },
    report: (id) => report(requireUser(id)),
  };
}
