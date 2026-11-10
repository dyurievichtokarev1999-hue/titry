import { MOODS, TRACKS, blankEpisode, todayIso, validateEpisode, episodeToText, sanitizeEpisode } from '/engine/episode.js';
import { drawFrame, timeline, DEFAULT_DURATION } from '/engine/draw.js';

const $ = (id) => document.getElementById(id);
const state = {
  episode: blankEpisode(),
  draft: null,          // эпизод в момент получения черновика: для подсчёта правок
  provider: null,
  feedback: null,
  t: 0, playing: false, last: 0,
};
const T = timeline(DEFAULT_DURATION);
const audio = new Audio();
audio.preload = 'auto';
audio.volume = 0.7;

// ── Поля формы ───────────────────────────────────────────────────────────────
$('date').value = todayIso();
for (const m of Object.values(MOODS)) {
  const b = document.createElement('button');
  b.type = 'button'; b.dataset.mood = m.id; b.setAttribute('role', 'radio');
  b.innerHTML = `<span class="sw" style="background:${m.accent}"></span>`;
  b.append(m.film);
  b.addEventListener('click', () => { state.episode.mood = m.id; syncChips(); changed(); });
  $('moods').append(b);
}
for (const t of Object.values(TRACKS)) {
  const o = document.createElement('option');
  o.value = t.id; o.textContent = t.file ? t.title : 'тишина (без музыки)';
  $('music').append(o);
}

function syncChips() {
  for (const b of $('moods').children) b.setAttribute('aria-checked', String(b.dataset.mood === state.episode.mood));
}

function fillForm(ep) {
  $('title').value = ep.title; $('genre').value = ep.genre; $('music').value = ep.music;
  $('lead').value = ep.lead; $('gender').value = ep.gender || '';
  $('postText').value = ep.post.text; $('postSource').value = ep.post.source;
  $('date').value = ep.date; $('period').value = ep.period;
  renderRows(); syncChips();
}

function readForm() {
  const ep = state.episode;
  ep.title = $('title').value; ep.genre = $('genre').value; ep.music = $('music').value;
  ep.lead = $('lead').value || 'ты'; ep.gender = $('gender').value || null;
  ep.post = { text: $('postText').value, source: $('postSource').value };
  ep.date = $('date').value || todayIso(); ep.period = $('period').value;
  ep.rows = [...$('rows').children].map((line) => ({
    role: line.querySelector('[data-k=role]').value,
    value: line.querySelector('[data-k=value]').value,
    source: line.querySelector('[data-k=source]').value,
  }));
}

function renderRows() {
  const box = $('rows');
  box.textContent = '';
  state.episode.rows.forEach((r, i) => {
    const line = document.createElement('div');
    line.className = 'rowline';
    for (const [k, ph] of [['role', 'Друг'], ['value', 'вечерний звонок'], ['source', 'друг позвонил поговорить']]) {
      const inp = document.createElement('input');
      inp.dataset.k = k; inp.placeholder = ph; inp.value = r[k] || '';
      inp.setAttribute('aria-label', `Строка ${i + 1}: ${k === 'role' ? 'роль' : k === 'value' ? 'значение' : 'цитата'}`);
      inp.addEventListener('input', changed);
      line.append(inp);
    }
    const tools = document.createElement('div');
    tools.className = 'tools';
    const mk = (label, title, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title); b.addEventListener('click', fn); tools.append(b); };
    mk('↑', 'Выше', () => { readForm(); if (i > 0) { const a = state.episode.rows; [a[i - 1], a[i]] = [a[i], a[i - 1]]; renderRows(); changed(); } });
    mk('↓', 'Ниже', () => { readForm(); const a = state.episode.rows; if (i < a.length - 1) { [a[i + 1], a[i]] = [a[i], a[i + 1]]; renderRows(); changed(); } });
    mk('×', 'Убрать строку', () => { readForm(); state.episode.rows.splice(i, 1); renderRows(); changed(); });
    line.append(tools);
    box.append(line);
  });
}

$('addRow').addEventListener('click', () => { readForm(); state.episode.rows.push({ role: '', value: '', source: '' }); renderRows(); changed(); });
for (const id of ['title', 'genre', 'music', 'lead', 'gender', 'postText', 'postSource', 'date', 'period', 'story']) {
  $(id).addEventListener('input', changed);
}

// ── Проверки ─────────────────────────────────────────────────────────────────
function showChecks() {
  const story = $('story').value.trim();
  const v = validateEpisode(state.episode, story);
  const ul = $('checks');
  ul.textContent = '';
  const add = (cls, msg) => { const li = document.createElement('li'); li.className = cls; li.textContent = msg; ul.append(li); };
  v.errors.forEach((e) => add('error', e.msg));
  v.warnings.forEach((w) => add('warning', w.msg));
  if (!v.errors.length && !v.warnings.length) add('ok', 'Всё в порядке: каждая строка опирается на рассказ.');
  document.querySelectorAll('.rowline input').forEach((inp) => inp.classList.remove('err', 'warn'));
  for (const item of [...v.errors.map((x) => [x, 'err']), ...v.warnings.map((x) => [x, 'warn'])]) {
    const m = /^rows\.(\d+)\.(\w+)$/.exec(item[0].path);
    if (m) $('rows').children[m[1]]?.querySelector(`[data-k=${m[2]}]`)?.classList.add(item[1]);
  }
  $('renderBtn').disabled = !v.ok;
  return v;
}

function changed() {
  readForm();
  showChecks();
  $('textVersion').textContent = episodeToText(state.episode);
  if (!state.playing) draw();
  const track = TRACKS[state.episode.music];
  const src = track.file ? `/audio/${track.file}` : '';
  if (audio.dataset.src !== src) { audio.pause(); audio.dataset.src = src; if (src) audio.src = src; else audio.removeAttribute('src'); }
}

// ── Предпросмотр ─────────────────────────────────────────────────────────────
const canvas = $('preview');
const ctx = canvas.getContext('2d');
function draw() {
  drawFrame(ctx, canvas.width, canvas.height, state.episode, state.t, { duration: T.duration, still: $('still').checked, watermark: $('watermark').checked ? 'сделано в титрах' : false });
  $('scrub').value = String(Math.round((state.t / T.duration) * 1000));
  const s = Math.floor(state.t);
  $('tc').textContent = `00:${String(s).padStart(2, '0')} / 00:${T.duration}`;
}
function tick(now) {
  if (!state.playing) return;
  state.t += (now - state.last) / 1000; state.last = now;
  if (state.t >= T.duration) { state.t = T.duration; stop(); }
  draw();
  if (state.playing) requestAnimationFrame(tick);
}
function stop() {
  state.playing = false; audio.pause(); $('play').textContent = state.t >= T.duration ? 'Ещё раз' : 'Смотреть';
}
$('play').addEventListener('click', () => {
  if (state.playing) return stop();
  if (state.t >= T.duration) state.t = 0;
  state.playing = true; state.last = performance.now();
  $('play').textContent = 'Пауза';
  if (audio.dataset.src) { audio.currentTime = Math.min(state.t, 31); audio.play().catch(() => {}); }
  requestAnimationFrame(tick);
});
$('scrub').addEventListener('input', () => {
  state.t = (Number($('scrub').value) / 1000) * T.duration;
  if (state.playing && audio.dataset.src) audio.currentTime = Math.min(state.t, 31);
  draw();
});
$('still').addEventListener('change', draw);
$('watermark').addEventListener('change', draw);

// ── Сервер ───────────────────────────────────────────────────────────────────
async function api(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Ошибка ${res.status}`), { data });
  return data;
}

api('/api/config').then((c) => {
  $('provider').innerHTML = c.provider === 'claude'
    ? `черновики: <b>Claude</b> · ${c.model}`
    : 'черновики: <b>заготовка без ИИ</b> · ключ API не задан';
}).catch(() => { $('provider').textContent = 'сервер недоступен'; });

async function requestDraft() {
  const story = $('story').value.trim();
  if (!story) { $('draftNote').textContent = 'Вставьте рассказ участника.'; return; }
  $('draftBtn').disabled = true; $('draftNote').textContent = 'Собираю черновик…';
  try {
    const r = await api('/api/draft', { story, date: $('date').value, period: $('period').value, tone: $('tone').value });
    if (!r.episode) { showHelp(r.help); $('draftNote').textContent = 'Черновик остановлен фильтром безопасности.'; return; }
    state.episode = r.episode; state.draft = structuredClone(r.episode); state.provider = r.provider;
    fillForm(state.episode); changed();
    const dropped = r.dropped && r.dropped.length ? ` Отброшено строк без опоры на рассказ: ${r.dropped.length}.` : '';
    $('draftNote').textContent = (r.provider === 'claude' ? 'Черновик от Claude.' : 'Заготовка без ИИ: сократите значения до коротких фраз.') + dropped + (r.note ? ' ' + r.note : '');
    if (r.help) showHelp(r.help);
  } catch (e) {
    // ИР-02: «проверка недоступна» — экран организатора целиком (тексты редактора повествования, PM-01).
    const d = e.data;
    $('draftNote').textContent = d && d.unavailable ? `${d.error}. ${d.message} ${d.next}` : e.message;
  } finally { $('draftBtn').disabled = false; }
}
$('draftBtn').addEventListener('click', requestDraft);

function showHelp(text) { $('helpText').textContent = text; $('help').hidden = false; $('helpClose').focus(); }
$('helpClose').addEventListener('click', () => { $('help').hidden = true; });

$('example').addEventListener('change', async () => {
  const id = $('example').value;
  if (!id) return;
  const data = await (await fetch(`/examples/${id}.json`)).json();
  $('story').value = data.story;
  state.episode = sanitizeEpisode(data.episode); state.draft = structuredClone(state.episode); state.provider = 'example';
  state.t = T.titleHold - 0.5;
  fillForm(state.episode); changed();
  $('draftNote').textContent = 'Загружен вымышленный пример из прототипа.';
});

$('renderBtn').addEventListener('click', async () => {
  $('renderBtn').disabled = true; $('renderNote').textContent = 'Рендер… обычно 15–40 секунд.';
  try {
    const r = await api('/api/render', { episode: state.episode, story: $('story').value.trim() || undefined, participant: $('participant').value, preset: $('preset').value, watermark: $('watermark').checked, still: $('still').checked });
    $('video').src = r.video; $('download').href = r.video; $('download').download = r.video.split('/').pop();
    $('result').hidden = false;
    $('renderNote').textContent = `Готово за ${r.seconds.toFixed(0)} с. Отправьте файл участнику.`;
  } catch (e) {
    $('renderNote').textContent = e.message;
  } finally { showChecks(); }
});

$('sentBtn').addEventListener('click', async () => {
  const video = $('video').getAttribute('src');
  if (!video) return;
  try {
    await api('/api/out/delete', { video });
    $('video').removeAttribute('src'); $('video').load();
    $('result').hidden = true;
    $('renderNote').textContent = 'Ролик удалён из монтажной.';
  } catch (e) { $('renderNote').textContent = e.message; }
});

for (const b of $('feedback').children) {
  b.addEventListener('click', () => {
    state.feedback = b.dataset.v;
    for (const x of $('feedback').children) x.setAttribute('aria-pressed', String(x === b));
    if (b.dataset.v === 'heavier') $('logNote').textContent = 'Предложите участнику остановиться, тихую версию или живую помощь. Не уговаривайте продолжать.';
  });
}

function countEdits(draft, ep) {
  if (!draft) return null;
  const a = draft.rows.map((r) => `${r.role}|${r.value}`);
  const b = ep.rows.map((r) => `${r.role}|${r.value}`);
  let changedRows = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changedRows++;
  return { changedRows, titleChanged: draft.title !== ep.title, genreChanged: draft.genre !== ep.genre, moodChanged: draft.mood !== ep.mood };
}

$('logBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/log', {
      participant: $('participant').value, day: Number($('day').value), consent: $('consent').checked,
      episode: state.episode, provider: state.provider,
      feedback: {
        reaction: state.feedback, shared: $('shared').checked, edits: countEdits(state.draft, state.episode),
        requested: [...document.querySelectorAll('input[name=requested]:checked')].map((x) => x.value),
      },
    });
    $('logNote').textContent = `Сохранено: ${r.saved}`;
  } catch (e) { $('logNote').textContent = e.message; }
});

fillForm(state.episode);
changed();

// ── Репетиция R16–R20 ───────────────────────────────────────────────────────
// Упражнение организатора: черновики намеренно неверные; ролик не собирается, ответы не записываются.
const rehearsal = { cases: [], attempt: 0 }; // attempt — номер актуальной попытки: устаревшие ответы не показываются
api('/api/rehearsal').then((r) => {
  rehearsal.cases = r.cases;
  for (const c of r.cases) $('rhCase').add(new Option(c.id, c.id));
  for (const i of r.invariants) $('rhInvariant').add(new Option(i.text, i.id));
}).catch(() => { $('rhCase').disabled = true; });

$('rhCase').addEventListener('change', () => {
  rehearsal.attempt++; // запрос по прежнему случаю больше не может изменить экран
  const c = rehearsal.cases.find((x) => x.id === $('rhCase').value);
  $('rhBody').hidden = !c;
  $('rhResult').textContent = '';
  $('rhInvariant').value = '';
  if (!c) return;
  $('rhStory').textContent = c.story;
  const ep = c.episode;
  const rows = ep.rows.map((r) => `${r.role} — ${r.value}   [«${r.source}»]`).join('\n');
  const post = ep.post && ep.post.text ? `\nПосле титров: ${ep.post.text}   [«${ep.post.source}»]` : '';
  $('rhDraft').textContent = `«${ep.title}» · ${ep.genre} · плёнка ${ep.mood}\n${rows}${post}`;
});

async function rhAnswer(action) {
  const id = $('rhCase').value;
  if (!id) return;
  if (action === 'reject' && !$('rhInvariant').value) { $('rhResult').textContent = 'Выберите нарушенный инвариант.'; return; }
  const attempt = ++rehearsal.attempt;
  const current = () => attempt === rehearsal.attempt && $('rhCase').value === id;
  try {
    const r = await api('/api/rehearsal/answer', { id, action, invariant: $('rhInvariant').value });
    if (!current()) return; // ответ по прежнему случаю или устаревшей попытке не показывается
    const head = r.correct ? 'Верно.' : 'Неверно.';
    const need = r.expected === 'stop' ? 'Правильное действие — остановить: ролик не делается.' : `Правильное действие — отклонить. Инвариант: ${r.invariant}`;
    $('rhResult').textContent = `${head} ${need} ${r.why} (${r.id || id}: ${r.name})`;
  } catch (e) { if (current()) $('rhResult').textContent = e.message; }
}
$('rhAccept').addEventListener('click', () => rhAnswer('accept'));
$('rhReject').addEventListener('click', () => rhAnswer('reject'));
$('rhStop').addEventListener('click', () => rhAnswer('stop'));
