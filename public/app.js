// 走る画面：ラップの時間は、この画面で計る（あとで光のゲートの合図に差しかえられる）
// ゴースト（自己ベストの速さ）が、トラックの上を一緒に進む
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FACE = { ghost: 'ghost', usagi: 'usagi', shiba: 'shiba', yamaneko: 'yamaneko', fukurou: 'fukurou' };
let config = null;
let state = null;
let lapStart = null; // いまの1周を計りはじめた時刻（performance.now）
let running = false;

async function api(path, body) {
  const res = await fetch(`/api/${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}
const sec = (ms) => (ms == null ? '－' : (ms / 1000).toFixed(2));
// ともはねのアドレス。このパソコン（localhost）のアドレスのとき、スマホやテレビからも届くように、いま開いているアドレスに合わせる
function tomohaneUrl(path) {
  const u = new URL(path, config.tomohaneUrl);
  if (['localhost', '127.0.0.1'].includes(u.hostname) && !['localhost', '127.0.0.1'].includes(location.hostname)) u.hostname = location.hostname;
  return u.href;
}

function render() {
  $('#signin').hidden = Boolean(state);
  $('#app').hidden = !state;
  if (!state) return;
  $('#activity').textContent = state.activityLabel;
  $('#session-info').textContent = state.session ? `${state.session.laps}周目まで` : '';
  $('#best').textContent = sec(state.best);
  $('#today').textContent = sec(state.today.best);
  $('#yesterday').textContent = sec(state.yesterday.best);
  const d = state.today.best != null && state.yesterday.best != null ? state.today.best - state.yesterday.best : null;
  const diff = $('#diff');
  diff.textContent = d == null ? '－' : `${d <= 0 ? '−' : '＋'}${sec(Math.abs(d))}`;
  diff.className = `num ${d == null ? '' : d <= 0 ? 'ahead' : 'behind'}`;
  const pb = Math.min(...state.today.laps);
  $('#laps').innerHTML = state.today.laps.map((ms) => `<li class="${ms === pb ? 'pb' : ''}">${sec(ms)} 秒</li>`).join('') || '<li class="muted">まだありません</li>';
  $('#set-activity').value = state.settings.activity;
  $('#set-tone').value = state.settings.tone;
}

function say(lines) {
  $('#lines').innerHTML = lines.map((l) => `<li class="line"><img src="/avatars/${FACE[l.agent]}.svg" alt=""><p>${esc(l.text)}</p></li>`).join('');
}

// タイマーとゴーストの位置（画面を描くたびに）
function tick() {
  if (running && lapStart != null) {
    const ms = performance.now() - lapStart;
    $('#timer').textContent = sec(ms);
    const best = state?.best;
    const dot = $('#ghost-dot');
    if (best) {
      dot.style.left = `${Math.min(ms / best, 1) * 100}%`;
      const gap = $('#gap');
      if (ms < best) {
        gap.textContent = `ゴーストのゴールまで あと ${sec(best - ms)} 秒`;
        gap.className = 'gap ahead';
      } else {
        gap.textContent = `ゴーストはゴールした（+${sec(ms - best)} 秒）`;
        gap.className = 'gap behind';
      }
    }
  }
  requestAnimationFrame(tick);
}

async function lap() {
  if (!running || lapStart == null) return;
  const ms = performance.now() - lapStart;
  if (ms < 1000) return; // 押しまちがい（1秒未満）は数えない
  lapStart = performance.now();
  try {
    const r = await api('lap', { ms });
    state = r.summary;
    say(r.lines);
    render();
    const share = $('#share');
    if (r.isBest && !r.firstEver) {
      const text = `👻 ゴーストエージェントで、${state.activityLabel}の自己ベストを更新しました！ ${sec(r.ms)}秒。昨日の自分を、ちょっと超えた！`;
      share.href = tomohaneUrl(`/plaza.html?draft=${encodeURIComponent(text)}`);
      share.hidden = false;
    }
    if (r.rest) stop();
  } catch (e) {
    $('#error').textContent = e.message;
  }
}

async function stop() {
  running = false;
  lapStart = null;
  $('#start').disabled = false;
  $('#lap').disabled = true;
  $('#stop').disabled = true;
  $('#gap').textContent = 'おつかれさま！';
  $('#gap').className = 'gap';
  $('#ghost-dot').style.left = '0%';
  state = await api('stop', {});
  render();
}

$('#start').addEventListener('click', async () => {
  state = await api('start', {});
  running = true;
  lapStart = performance.now();
  $('#start').disabled = true;
  $('#lap').disabled = false;
  $('#stop').disabled = false;
  $('#share').hidden = true;
  say([{ agent: 'ghost', text: state.best ? `よーい、スタート！ ぼくは ${sec(state.best)} 秒で1周するよ。` : 'よーい、スタート！ まずは1周、きみの記録をつくろう。' }]);
  $('#lap').focus();
});
$('#lap').addEventListener('click', lap);
$('#stop').addEventListener('click', stop);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && running && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    lap();
  }
});
$('#set-activity').addEventListener('change', async (e) => {
  await api('settings', { activity: e.target.value });
  state = await api('state');
  render();
});
$('#set-tone').addEventListener('change', (e) => api('settings', { tone: e.target.value }));
$('#delete').addEventListener('click', async () => {
  if (!confirm('ゴーストの記録を全部消しますか？ もとにもどせません。')) return;
  await api('delete', {});
  location.reload();
});

config = await api('config');
$('#set-activity').innerHTML = Object.entries(config.activities).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
$('#set-tone').innerHTML = Object.entries(config.tones).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
$('#signin-link').href = tomohaneUrl('/api/link/ghost-start');
$('#back').href = tomohaneUrl('/');
state = await api('state');
render();
requestAnimationFrame(tick);
