// Внутренняя причина insufficient_after_exclusion: после исключения опасных частей рассказа не собирается
// обязательный элемент эпизода (title, genre или LIMITS.rowsMin строк). Шесть критериев редактора повествования.
// Только вымышленные тексты: tests/fixtures/oi-intent.json и безопасный контроль.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeDraft, draftRuleBased } from '../server/draft.js';
import { insufficientAfterExclusion, INSUFFICIENT_AFTER_EXCLUSION, validateSafeEpisode, assessRisk, helpMessage } from '../server/safety.js';
import { createBot, TEXT } from '../server/bot.js';
import { createApp, INSUFFICIENT_TEXT } from '../server/app.js';
import { LIMITS } from '../engine/episode.js';

const OI = JSON.parse(await fs.readFile(new URL('./fixtures/oi-intent.json', import.meta.url), 'utf8')).cases;
const byId = Object.fromEntries(OI.map((c) => [c.id, c.text]));
const REPLY = 'Не получилось собрать титры только из твоих слов. Сегодня можно без ролика.';
const SAFE = 'Утром я пила чай. Вечером я читала книгу.';
// Concern-фрагмент + две безопасные пары: исключение есть, но материала хватает.
const MIX = 'Я злюсь на брата и хочу его ударить. Утром я пила чай. Вечером я читала книгу.';
const URGENT = 'Сегодня опять всё валится из рук. Я не хочу больше жить. Вечером позвонила сестра.';
const HELP = /помощ|112|телефон доверия|8-800/i;
const THREAT_WORDS = /удар|убит|хочу\s+(?:его|её|ее)/i;
// Concern по местному фильтру: OI07–OI12, кроме тех, что местный фильтр поднимает до urgent.
const CONCERN = ['OI07', 'OI08', 'OI09', 'OI10', 'OI11', 'OI12'].filter((id) => assessRisk(byId[id]).level === 'concern');
const manual = (story, o = {}) => makeDraft(story, { ...o, provider: 'manual' });

// Подставной клиент модели: ответ черновика (end_turn, один текстовый блок) или сбой.
const modelClient = (raw) => ({ beta: { messages: { create: async () => {
  if (raw instanceof Error) throw raw;
  return { stop_reason: 'end_turn', model: 'm', usage: {}, content: [{ type: 'text', text: JSON.stringify(raw) }] };
} } } });
const modelDraft = (over) => ({ title: 'Обычный день', genre: 'тихая драма', mood: 'quiet', grammatical_gender: 'unknown', safety_flag: false, rows: [], post: { text: '', source: '' }, ...over });
const fields = (ep) => [ep.title, ep.genre, ep.lead, ...(ep.rows || []).flatMap((r) => [r.role, r.value, r.source]), ep.post?.text, ep.post?.source].join(' | ');

test('условие: концерн-примеры есть, контроль безопасен', () => {
  assert.ok(CONCERN.length >= 4, `concern-примеров: ${CONCERN.join(',')}`);
  assert.equal(assessRisk(SAFE).level, 'none');
  assert.equal(INSUFFICIENT_AFTER_EXCLUSION, 'insufficient_after_exclusion');
});

// ── Критерий 4: две пары — не нехватка; пустой post — не нехватка ───────────

test('две пригодные пары при допустимых title/genre — не нехватка; пустой post — не нехватка', async () => {
  for (const story of [SAFE, MIX]) {
    const r = await manual(story);
    assert.ok(!r.insufficient, story);
    assert.ok(r.episode, story);
    assert.equal(r.episode.rows.length, LIMITS.rowsMin);
    assert.equal(r.episode.post.text, '', 'пост пустой');
    assert.equal(r.validation.ok, true, JSON.stringify(r.validation.errors));
    assert.equal(insufficientAfterExclusion(r.episode, story), false);
  }
});

test('рассказ без исключённых частей никогда не даёт эту причину (даже с одной строкой)', () => {
  const story = 'Утром я пила чай.';
  const ep = draftRuleBased(story).episode;
  assert.equal(validateSafeEpisode(ep, story).ok, false, 'одна строка — обычная ошибка проверки');
  assert.equal(insufficientAfterExclusion(ep, story), false);
});

// ── Критерий 3: нехватка — только реплика; критерий 2: concern-фрагмент не в полях ──

test('makeDraft: concern без безопасных пар → insufficient, без черновика, без dropped и без текста рассказа', async () => {
  for (const id of CONCERN) {
    const story = byId[id];
    const r = await manual(story);
    assert.equal(r.insufficient, true, id);
    assert.equal(r.code, 'insufficient_after_exclusion', id);
    assert.equal(r.episode, null, id);
    assert.deepEqual(Object.keys(r).sort(), ['code', 'episode', 'insufficient', 'provider', 'risk'], `${id}: ни черновика, ни dropped, ни validation`);
    assert.ok(!JSON.stringify(r.risk).includes(story.slice(0, 12)), `${id}: текст рассказа не выходит наружу`);
    assert.equal(r.risk.level, 'concern', id);
  }
});

test('concern-фрагмент не попадает ни в одно поле черновика (заготовка и модель)', async () => {
  const manualR = await manual(MIX);
  assert.doesNotMatch(fields(manualR.episode), THREAT_WORDS);
  const raw = modelDraft({
    title: 'Злость на брата', genre: 'драма без развязки',
    rows: [
      { role: 'Злость', value: 'хочу его ударить', source: 'хочу его ударить' },
      { role: 'Чай', value: 'утренний чай', source: 'Утром я пила чай' },
      { role: 'Книга', value: 'вечер с книгой', source: 'Вечером я читала книгу' },
    ],
    post: { text: 'брат', source: 'Я злюсь на брата' },
  });
  const r = await makeDraft(MIX, { provider: 'claude', client: modelClient(raw) });
  if (r.episode) assert.doesNotMatch(fields(r.episode), THREAT_WORDS);
  else assert.equal(r.insufficient, true);
});

// ── Критерий 1: urgent или незавершённая проверка — реплика нехватки не появляется ──

test('makeDraft: urgent (местный фильтр и safety_flag модели) → остановка, не нехватка', async () => {
  for (const c of OI.filter((x) => assessRisk(x.text).level === 'urgent')) {
    const r = await manual(c.text);
    assert.equal(r.risk.level, 'urgent', c.id); assert.ok(!r.insufficient, c.id); assert.equal(r.episode, null);
  }
  const story = byId.OI10;
  const r = await makeDraft(story, { provider: 'claude', client: modelClient(modelDraft({ safety_flag: true })) });
  assert.equal(r.risk.level, 'urgent'); assert.ok(!r.insufficient);
});

// ── Критерий 5: запасная заготовка при сбое модели не возвращает исключённый материал ──

test('сбой модели → недоступность, не нехватка и не заготовка', async () => {
  const story = byId.OI10;
  const r = await makeDraft(story, { provider: 'claude', client: modelClient(Object.assign(new Error('сбой'), { code: 'ECONNRESET' })) });
  assert.equal(r.unavailable, true); assert.ok(!r.insufficient); assert.equal(r.episode, null);
});

test('модель вернула меньше двух безопасных строк → заготовка без ИИ тем же валидатором → insufficient', async () => {
  const story = byId.OI10; // одна безопасная часть: «Завтра у нас отчёт.»
  // После groundDraft остаётся одна строка (< rowsMin) → makeDraft переходит на заготовку без ИИ.
  const raw = modelDraft({ rows: [
    { role: 'Желание', value: 'ударить', source: 'хочу его ударить' },
    { role: 'Коллега', value: 'хочет удара', source: 'хочу его ударить' },
    { role: 'Отчёт', value: 'завтра', source: 'Завтра у нас отчёт' },
  ] });
  const r = await makeDraft(story, { provider: 'claude', client: modelClient(raw) });
  assert.equal(r.insufficient, true);
  assert.equal(r.episode, null);
  assert.ok(!JSON.stringify(r).includes('ударить'));
});

test('черновик модели не собирается после исключения (название из угрозы) → сначала заготовка без ИИ', async () => {
  const raw = modelDraft({ title: 'Ударить брата', rows: [
    { role: 'Чай', value: 'утренний чай', source: 'Утром я пила чай' },
    { role: 'Книга', value: 'вечер с книгой', source: 'Вечером я читала книгу' },
  ] });
  const r = await makeDraft(MIX, { provider: 'claude', client: modelClient(raw) });
  assert.ok(!r.insufficient, 'заготовка собирается — это не нехватка');
  assert.equal(r.provider, 'manual');
  assert.equal(r.validation.ok, true, JSON.stringify(r.validation.errors));
  assert.equal(r.episode.rows.length, 2);
  assert.doesNotMatch(fields(r.episode), THREAT_WORDS);
  // Тот же рассказ без опорных безопасных пар: и модель, и заготовка не собираются → нехватка.
  const n = await makeDraft(byId.OI08, { provider: 'claude', client: modelClient({ ...raw, rows: [] }) });
  assert.equal(n.insufficient, true); assert.equal(n.episode, null);
});

test('пара без значения или без роли — не пригодна', () => {
  const ep = draftRuleBased(MIX).episode;
  ep.rows[1].value = '';
  assert.equal(insufficientAfterExclusion(ep, MIX), true);
});

test('заготовка без ИИ проверяется validateSafeEpisode: опасная часть не возвращается ни при каком пути', async () => {
  for (const id of CONCERN) {
    const ep = draftRuleBased(byId[id]).episode;
    assert.doesNotMatch(fields(ep), THREAT_WORDS, id);
    assert.equal(insufficientAfterExclusion(ep, byId[id]), true, id);
  }
});

// ── Бот: подставные safetyCheck и render ───────────────────────────────────

const chat = { id: 88001, type: 'private' };
function botSetup({ check = () => false, hasKey, draft = manual } = {}) {
  const sent = []; const events = []; const counters = { render: 0, video: 0, check: 0 };
  const tg = {
    send: async (c, text, extra = {}) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {},
    fileBuffer: async () => Buffer.from(''), sendVideo: async () => { counters.video++; },
  };
  const metrics = { hash: () => 'fictional', log: async (id, event, extra = {}) => { events.push({ event, ...extra }); }, forget: async () => {} };
  const bot = createBot({
    tg, metrics, draft,
    safetyCheck: async (t) => { counters.check++; return check(t, counters.check); },
    ...(hasKey ? { hasKey } : {}),
    render: async (e, o) => { counters.render++; return { seconds: 1, duration: 24, outPath: o.outPath }; },
  });
  const say = (text) => bot.handleUpdate({ message: { chat, text } });
  const press = (data) => bot.handleUpdate({ callback_query: { id: 'q', data, message: { chat } } });
  return { bot, sent, events, counters, say, press, texts: () => sent.map((m) => m.text) };
}

// Решение владельца 1 (PR 11): после исключения фрагмента уровня concern — реплика и сразу за ней тот же блок помощи,
// что у прежней карточки concern; если исключались только фрагменты без concern — одна реплика.
test('бот: нехватка после concern → реплика, сразу за ней блок помощи concern; без кнопок и черновика; метрика — только код', async () => {
  assert.equal(TEXT.insufficient, REPLY);
  for (const id of CONCERN) {
    const b = botSetup();
    await b.say(byId[id]);
    const after = b.sent.slice(b.texts().indexOf(TEXT.working) + 1);
    assert.deepEqual(after.map((m) => m.text), [REPLY, helpMessage('concern')], id);
    for (const m of after) assert.equal(m.extra.reply_markup, undefined, `${id}: без кнопок`);
    assert.doesNotMatch(b.texts().join('\n'), /Сейчас важнее не титры/, `${id}: не карточка urgent`);
    assert.deepEqual(b.events, [{ event: 'insufficient_after_exclusion' }], `${id}: метрика без текста и номеров`);
    // Кнопки прежних черновиков ничего не запускают, ролика нет.
    for (let n = 0; n <= 3; n++) await b.press(`play:${n}`);
    assert.equal(b.counters.render, 0); assert.equal(b.counters.video, 0);
    assert.equal(b.bot.sessions.get(chat.id).episode, null);
  }
});

test('бот: нехватка без concern → ровно одна реплика, без блока помощи', async () => {
  const draft = async () => ({ risk: { level: 'none', byModel: false, matches: [] }, episode: null, provider: 'manual', insufficient: true, code: 'insufficient_after_exclusion' });
  const b = botSetup({ draft });
  await b.say(SAFE);
  const after = b.sent.slice(b.texts().indexOf(TEXT.working) + 1);
  assert.deepEqual(after.map((m) => m.text), [REPLY]);
  assert.doesNotMatch(b.texts().join('\n'), HELP);
  assert.equal(b.counters.check, 1, 'отдельная проверка до реплики');
});

test('бот: две пары — обычный черновик, реплики нехватки нет', async () => {
  const b = botSetup();
  await b.say(SAFE);
  assert.ok(!b.texts().includes(REPLY));
  assert.ok(b.bot.sessions.get(chat.id).episode);
});

test('бот: отдельная проверка true → остановка, а не нехватка', async () => {
  const b = botSetup({ check: () => true });
  await b.say(byId.OI10);
  assert.ok(!b.texts().includes(REPLY)); assert.match(b.texts().at(-1), HELP);
  // Повтор того же рассказа — снова остановка.
  await b.say(byId.OI10);
  assert.ok(!b.texts().includes(REPLY)); assert.match(b.texts().at(-1), HELP);
});

test('бот: незавершённая проверка или нет ключа → технический ответ, а не нехватка', async () => {
  const fail = () => { throw Object.assign(new Error('сбой'), { code: 'incomplete_response' }); };
  const b = botSetup({ check: fail });
  await b.say(byId.OI10);
  assert.equal(b.texts().at(-1), TEXT.checkUnavailable);
  await b.say(byId.OI10);
  assert.equal(b.texts().at(-1), TEXT.checkPaused, 'второй неполный ответ — техническая пауза');
  await b.say(byId.OI10);
  assert.equal(b.texts().at(-1), TEXT.checkPaused, 'пауза держится, нехватка её не подменяет');
  assert.ok(!b.texts().includes(REPLY));
  const k = botSetup({ hasKey: () => false });
  await k.say(byId.OI10);
  assert.equal(k.texts().at(-1), TEXT.checkUnavailable); assert.ok(!k.texts().includes(REPLY));
});

test('бот: /delete во время отдельной проверки → реплики нет, запрет по ответу true сохраняется', async () => {
  let release;
  const b = botSetup({ check: () => new Promise((r) => { release = r; }) });
  const p = b.say(byId.OI10);
  while (!release) await new Promise((r) => setImmediate(r));
  await b.say('/delete');
  release(true);
  await p;
  assert.ok(!b.texts().includes(REPLY));
  assert.ok(!b.events.some((e) => e.event === 'insufficient_after_exclusion'), 'после /delete метрика не пишется');
  await b.say(byId.OI10);
  assert.match(b.texts().at(-1), HELP, 'тот же рассказ после /delete — остановка');
});

test('бот: новый рассказ во время проверки → устаревшая реплика нехватки не отправляется', async () => {
  let release;
  const b = botSetup({ check: (t, n) => (n === 1 ? new Promise((r) => { release = r; }) : false) });
  const p = b.say(byId.OI10);
  while (!release) await new Promise((r) => setImmediate(r));
  await b.say(SAFE);
  release(false);
  await p;
  assert.ok(!b.texts().includes(REPLY));
  assert.ok(b.bot.sessions.get(chat.id).episode, 'черновик нового рассказа на месте');
});

test('бот: местный urgent → помощь без отдельной проверки и без нехватки', async () => {
  const b = botSetup();
  await b.say(URGENT);
  assert.match(b.texts().at(-1), HELP); assert.ok(!b.texts().includes(REPLY)); assert.equal(b.counters.check, 0);
});

// ── Критерий 6: ручная правка не обходит правило ───────────────────────────

test('бот: правка не возвращает исключённый фрагмент и не обходит stop', async () => {
  for (const edit of ['+ Злость — хочу его ударить', '1: хочу его ударить', 'название: Ударить брата', 'после: хочу его ударить']) {
    const b = botSetup();
    await b.say(MIX);
    await b.say(edit);
    const s = b.bot.sessions.get(chat.id);
    assert.equal(s.validation.ok, false, `${edit}: правка с угрозой не проходит проверку`);
    await b.press(`play:${s.draftId}`);
    assert.equal(b.counters.render, 0, edit); assert.equal(b.counters.video, 0, edit);
  }
  const u = botSetup();
  await u.say(MIX);
  await u.say('+ Мысль — не хочу больше жить');
  await u.press(`play:${u.bot.sessions.get(chat.id).draftId}`);
  assert.match(u.texts().at(-1), HELP, 'правка с urgent ведёт к остановке');
  assert.equal(u.counters.render, 0);
});

// ── Монтажная ───────────────────────────────────────────────────────────────

async function withApp({ check = () => false, hasKey, draft = manual } = {}, fn) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-ins-'));
  const counters = { render: 0, check: 0 };
  const server = createApp({
    dataDir, draft,
    safetyCheck: async (t) => { counters.check++; return check(t, counters.check); },
    hasKey: hasKey || (() => true),
    render: async (e, o) => { counters.render++; return { seconds: 1, outPath: o.outPath }; },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try { await fn({ post, counters }); } finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
}

test('монтажная: нехватка после concern → 422 { kind: insufficient, error: реплика, help: блок concern } и ничего больше', async () => {
  assert.equal(INSUFFICIENT_TEXT, REPLY);
  await withApp({}, async ({ post, counters }) => {
    for (const id of CONCERN) {
      const r = await post('/api/draft', { story: byId[id] });
      assert.equal(r.status, 422, id);
      assert.deepEqual(r.body, { kind: 'insufficient', error: REPLY, help: helpMessage('concern') }, id);
    }
    assert.equal(counters.render, 0);
    const ok = await post('/api/draft', { story: SAFE });
    assert.equal(ok.status, 200); assert.equal(ok.body.episode.rows.length, 2);
  });
});

test('монтажная: нехватка без concern → 422 { kind: insufficient, error: реплика } без help', async () => {
  const draft = async () => ({ risk: { level: 'none', byModel: false, matches: [] }, episode: null, provider: 'manual', insufficient: true, code: 'insufficient_after_exclusion' });
  await withApp({ draft }, async ({ post, counters }) => {
    const r = await post('/api/draft', { story: SAFE });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body, { kind: 'insufficient', error: REPLY });
    assert.equal(counters.check, 1, 'отдельная проверка до реплики');
  });
});

test('монтажная: проверка true → safety; неполная → 503, затем technical; нет ключа → 503 — не нехватка', async () => {
  await withApp({ check: () => true }, async ({ post }) => {
    const r = await post('/api/draft', { story: byId.OI10 });
    assert.equal(r.status, 422); assert.equal(r.body.kind, 'safety');
  });
  const fail = () => { throw Object.assign(new Error('сбой'), { code: 'incomplete_response' }); };
  await withApp({ check: fail }, async ({ post }) => {
    const a = await post('/api/draft', { story: byId.OI10 });
    assert.equal(a.status, 503); assert.equal(a.body.unavailable, true);
    const b = await post('/api/draft', { story: byId.OI10 });
    assert.equal(b.body.kind, 'technical');
    const c = await post('/api/draft', { story: byId.OI10 });
    assert.equal(c.body.kind, 'technical');
  });
  await withApp({ hasKey: () => false }, async ({ post }) => {
    const r = await post('/api/draft', { story: byId.OI10 });
    assert.equal(r.status, 503); assert.notEqual(r.body.kind, 'insufficient');
  });
  await withApp({}, async ({ post, counters }) => {
    const r = await post('/api/draft', { story: URGENT });
    assert.equal(r.body.kind, 'safety'); assert.equal(counters.check, 0);
  });
});

test('монтажная: ручная правка организатора не возвращает исключённый фрагмент и не обходит stop', async () => {
  await withApp({}, async ({ post, counters }) => {
    const d = await post('/api/draft', { story: MIX });
    const base = d.body.episode;
    const edits = [
      { ...base, rows: [...base.rows, { role: 'Злость', value: 'хочу его ударить', source: 'хочу его ударить' }] },
      { ...base, title: 'Ударить брата' },
      { ...base, post: { text: 'хочу его ударить', source: 'хочу его ударить' } },
    ];
    for (const ep of edits) {
      const v = await post('/api/validate', { story: MIX, episode: ep });
      assert.equal(v.body.validation.ok, false);
      const r = await post('/api/render', { story: MIX, episode: ep });
      assert.equal(r.status, 422); assert.ok(r.body.validation && !r.body.validation.ok);
    }
    const urgent = { ...base, rows: [...base.rows, { role: 'Мысль', value: 'не хочу больше жить', source: 'не хочу больше жить' }] };
    const u = await post('/api/render', { story: MIX, episode: urgent });
    assert.equal(u.body.kind, 'safety');
    assert.equal(counters.render, 0);
  });
});
