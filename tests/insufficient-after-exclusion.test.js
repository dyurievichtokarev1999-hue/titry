// Внутренняя причина insufficient_after_exclusion: после исключения опасных частей рассказа не собирается
// обязательный элемент эпизода (title, genre или LIMITS.rowsMin строк). Шесть критериев редактора повествования.
// Только вымышленные тексты: tests/fixtures/oi-intent.json и безопасный контроль.
import test from 'node:test';
import { modelLike } from './helpers/fake-model.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeDraft, draftRuleBased } from '../server/draft.js';
import { INSUFFICIENT_INVITE_TEXT, insufficientAfterExclusion, INSUFFICIENT_AFTER_EXCLUSION, validateSafeEpisode, assessRisk, helpMessage, loadHelp } from '../server/safety.js';
import { createBot, TEXT, insufficientMessages, TELEGRAM_TEXT_LIMIT } from '../server/bot.js';
import { createApp, INSUFFICIENT_TEXT } from '../server/app.js';
import crypto from 'node:crypto';
import { storyDigest, normStory } from '../server/gate.js';
import { LIMITS } from '../engine/episode.js';

const OI = JSON.parse(await fs.readFile(new URL('./fixtures/oi-intent.json', import.meta.url), 'utf8')).cases;
const byId = Object.fromEntries(OI.map((c) => [c.id, c.text]));
const REPLY = 'Не получилось собрать титры только из твоих слов. Сегодня можно без ролика.';
// В боте за репликой — приглашение написать строки правкой (вариант 1, 12.11); в монтажной — только реплика.
const BOT_REPLY = `${REPLY}\n\n${INSUFFICIENT_INVITE_TEXT}`;
const SAFE = 'Утром я пила чай. Вечером я пекла пирог.';
// Concern-фрагмент + две безопасные пары: исключение есть, но материала хватает.
const MIX = 'Я злюсь на брата и хочу его ударить. Утром я пила чай. Вечером я пекла пирог.';
const URGENT = 'Сегодня опять всё валится из рук. Я не хочу больше жить. Вечером позвонила сестра.';
const HELP = /помощ|112|телефон доверия|8-800/i;
const THREAT_WORDS = /удар|убит|хочу\s+(?:его|её|ее)/i;
// Concern по местному фильтру: OI07–OI12, кроме тех, что местный фильтр поднимает до urgent.
const CONCERN = ['OI07', 'OI08', 'OI09', 'OI10', 'OI11', 'OI12'].filter((id) => assessRisk(byId[id]).level === 'concern');
// Вариант 1 (12.11): заготовка строк не даёт — черновик в этих тестах от поддельной модели (tests/helpers/fake-model.js).
const manual = modelLike;

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
      { role: 'Книга', value: 'вечер с книгой', source: 'Вечером я пекла пирог' },
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
    { role: 'Утром', value: 'пила чай', source: 'Утром я пила чай' },
    { role: 'Вечером', value: 'пекла пирог', source: 'Вечером я пекла пирог' },
  ] });
  const r = await makeDraft(MIX, { provider: 'claude', client: modelClient(raw) });
  // Вариант 1 (PR 13, 12.11): заготовка строк не даёт — черновик модели, опиравшийся на угрозу, ведёт к нехватке
  // после исключения; черновика и текста угрозы в ответе нет.
  assert.equal(r.insufficient, true);
  assert.equal(r.code, 'insufficient_after_exclusion');
  assert.equal(r.provider, 'manual');
  assert.equal(r.episode, null);
  assert.doesNotMatch(JSON.stringify(r), THREAT_WORDS);
  // Тот же рассказ без опорных безопасных пар: и модель, и заготовка не собираются → нехватка.
  const n = await makeDraft(byId.OI08, { provider: 'claude', client: modelClient({ ...raw, rows: [] }) });
  assert.equal(n.insufficient, true); assert.equal(n.episode, null);
});

test('пара без значения или без роли — не пригодна', () => {
  const ep = { ...draftRuleBased(MIX).episode, rows: [
    { role: 'Утром', value: 'пила чай', source: 'Утром я пила чай' },
    { role: 'Вечером', value: 'пекла пирог', source: 'Вечером я пекла пирог' },
  ] };
  assert.equal(insufficientAfterExclusion(ep, MIX), false);
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
function botSetup({ check = () => false, hasKey, draft = modelLike } = {}) {
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
// Решение владельца 11.11 09:05: в Telegram — ОДНО сообщение «реплика, пустая строка, блок помощи».
test('бот: нехватка после concern → ровно одна отправка: реплика, пустая строка, блок помощи; метрика — только код', async () => {
  assert.equal(TEXT.insufficient, REPLY);
  for (const id of CONCERN) {
    const b = botSetup();
    await b.say(byId[id]);
    const after = b.sent.slice(b.texts().indexOf(TEXT.working) + 1);
    assert.equal(after.length, 1, `${id}: ровно один вызов отправки`);
    assert.equal(after[0].extra.parse_mode, undefined, `${id}: без HTML-разметки — контакты не экранируются`);
    assert.equal(after[0].text, `${BOT_REPLY}\n\n${helpMessage('concern')}`, `${id}: порядок «реплика (с приглашением) → блок», без переходной фразы`);
    for (const m of after) assert.equal(m.extra.reply_markup, undefined, `${id}: без кнопок`);
    assert.doesNotMatch(b.texts().join('\n'), /Сейчас важнее не титры/, `${id}: не карточка urgent`);
    assert.deepEqual(b.events, [{ event: 'insufficient_after_exclusion' }], `${id}: метрика без текста и номеров`);
    // Кнопки прежних черновиков ничего не запускают, ролика нет.
    for (let n = 0; n <= 3; n++) await b.press(`play:${n}`);
    assert.equal(b.counters.render, 0); assert.equal(b.counters.video, 0);
    assert.equal(b.bot.sessions.get(chat.id).episode, null);
  }
});

// Ограничитель (решение владельца 11.11 11:05): «реплика + пустая строка + helpMessage('concern')» ≤ 3500 знаков,
// с запасом до лимита Telegram 4096. Падает тест — PR не сливается.
test('ограничитель: реплика + пустая строка + блок помощи concern ≤ 3500 знаков (текущий help.json и худший набор из него)', async () => {
  assert.equal(TELEGRAM_TEXT_LIMIT, 4096);
  const message = `${BOT_REPLY}\n\n${helpMessage('concern')}`;
  assert.ok(message.length <= 3500, `длина ${message.length}`);
  const now = insufficientMessages(true);
  assert.deepEqual(now, [message], 'одно сообщение');
  assert.match(now[0], /112/, 'в блоке — проверенный номер');
  // Худший случай из файла: все контакты проверены, длинные часы работы.
  const cfg = JSON.parse(await fs.readFile(new URL('../config/help.json', import.meta.url), 'utf8'));
  const all = { region: cfg.region, contacts: [cfg.emergency, ...(cfg.contacts || [])].map((c) => ({ ...c, phone: c.phone || '8-800-000-00-00', hours: 'круглосуточно, бесплатно, анонимно, из любого региона' })) };
  const worst = insufficientMessages(true, { help: all });
  assert.equal(worst.length, 1); assert.ok(worst[0].length <= 3500, `длина ${worst[0].length}`);
});

test('helpMessage никогда не пустой: concern и urgent содержат проверенный номер', () => {
  for (const level of ['concern', 'urgent']) {
    const t = helpMessage(level);
    assert.ok(t.trim().length > 0, level);
    assert.match(t, /112/, level);
  }
});

test('защитная ветка деления: сначала блок помощи, затем реплика; в журнал — только код', () => {
  const logs = [];
  const log = (stage, e) => logs.push(JSON.stringify({ stage, ...e }));
  // Без concern — только реплика, контакты не нужны.
  assert.deepEqual(insufficientMessages(false, { help: { get contacts() { throw new Error('не читать'); } }, log }), [BOT_REPLY]);
  // Вместе длиннее 4096 (блок сам по себе ≤ 4096: длиннее не пропускает проверка при старте).
  const long = { contacts: [{ label: 'Ж'.repeat(4096 - 200), phone: '112' }] };
  assert.ok(helpMessage('concern', long).length <= 4096);
  const parts = insufficientMessages(true, { help: long, log });
  assert.equal(parts.length, 2);
  assert.equal(parts[0], helpMessage('concern', long), 'сначала блок помощи');
  assert.equal(parts[1], BOT_REPLY, 'затем реплика');
  assert.deepEqual(logs, [JSON.stringify({ stage: 'insufficient', code: 'message_too_long' })]);
});

test('бот: нехватка без concern → ровно одна реплика, без блока помощи', async () => {
  const draft = async () => ({ risk: { level: 'none', byModel: false, matches: [] }, episode: null, provider: 'manual', insufficient: true, code: 'insufficient_after_exclusion' });
  const b = botSetup({ draft });
  await b.say(SAFE);
  const after = b.sent.slice(b.texts().indexOf(TEXT.working) + 1);
  assert.deepEqual(after.map((m) => m.text), [BOT_REPLY]);
  assert.doesNotMatch(b.texts().join('\n'), HELP);
  assert.equal(b.counters.check, 1, 'отдельная проверка до реплики');
});

test('бот: две пары — обычный черновик, реплики нехватки нет', async () => {
  const b = botSetup();
  await b.say(SAFE);
  assert.ok(!b.texts().some((t) => t.startsWith(REPLY)));
  assert.ok(b.bot.sessions.get(chat.id).episode);
});

test('бот: отдельная проверка true → остановка, а не нехватка', async () => {
  const b = botSetup({ check: () => true });
  await b.say(byId.OI10);
  assert.ok(!b.texts().some((t) => t.startsWith(REPLY))); assert.match(b.texts().at(-1), HELP);
  // Повтор того же рассказа — снова остановка.
  await b.say(byId.OI10);
  assert.ok(!b.texts().some((t) => t.startsWith(REPLY))); assert.match(b.texts().at(-1), HELP);
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
  assert.ok(!b.texts().some((t) => t.startsWith(REPLY)));
  const k = botSetup({ hasKey: () => false });
  await k.say(byId.OI10);
  assert.equal(k.texts().at(-1), TEXT.checkUnavailable); assert.ok(!k.texts().some((t) => t.startsWith(REPLY)));
});

test('бот: /delete во время отдельной проверки → реплики нет, запрет по ответу true сохраняется', async () => {
  let release;
  const b = botSetup({ check: () => new Promise((r) => { release = r; }) });
  const p = b.say(byId.OI10);
  while (!release) await new Promise((r) => setImmediate(r));
  await b.say('/delete');
  release(true);
  await p;
  assert.ok(!b.texts().some((t) => t.startsWith(REPLY)));
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
  assert.ok(!b.texts().some((t) => t.startsWith(REPLY)));
  assert.ok(b.bot.sessions.get(chat.id).episode, 'черновик нового рассказа на месте');
});

test('бот: местный urgent → помощь без отдельной проверки и без нехватки', async () => {
  const b = botSetup();
  await b.say(URGENT);
  assert.match(b.texts().at(-1), HELP); assert.ok(!b.texts().some((t) => t.startsWith(REPLY))); assert.equal(b.counters.check, 0);
});

// ── Критерий 6: ручная правка не обходит правило ───────────────────────────

test('бот: правка не возвращает исключённый фрагмент и не обходит stop', async () => {
  // Решение владельца 11.11 12:05, п. 1: правка — такой же вход, как рассказ. Правка, внёсшая concern, не применяется:
  // реплика «не берём» и блок помощи concern одним сообщением; черновик остаётся прежним, без угрозы.
  for (const edit of ['+ Злость — хочу его ударить', '1: хочу его ударить', 'название: Ударить брата', 'после: хочу его ударить']) {
    const b = botSetup();
    await b.say(MIX);
    const s = b.bot.sessions.get(chat.id);
    const was = JSON.stringify(s.episode);
    await b.say(edit);
    if (s.episode) assert.equal(JSON.stringify(s.episode), was, `${edit}: черновик не изменён`);
    if (s.episode) assert.doesNotMatch(fields(s.episode), THREAT_WORDS, edit);
    assert.ok(!b.texts().some((t) => t.startsWith(REPLY)), `${edit}: реплики нехватки нет`);
    await b.press(`play:${s.draftId}`);
    // Один вердикт на правку: либо остановка сразу на правке (тогда ролика нет), либо прежний черновик собирается
    // без остановки на «Смотреть» (разбор 940f41cc).
    assert.ok(!b.events.some((e) => e.event === 'safety' && e.at === 'render'), `${edit}: нет остановки на рендере`);
    if (b.events.some((e) => e.event === 'safety' && e.at === 'edit')) { assert.equal(b.counters.render, 0, edit); assert.equal(b.counters.video, 0, edit); }
    else assert.equal(b.counters.video, 1, edit);
  }
  const u = botSetup();
  await u.say(MIX);
  await u.say('+ Мысль — не хочу больше жить');
  assert.match(u.texts().at(-1), HELP, 'правка с urgent сразу ведёт к остановке');
  await u.press(`play:${u.bot.sessions.get(chat.id).draftId}`);
  assert.match(u.texts().at(-1), HELP);
  assert.equal(u.counters.render, 0);
});

// ── Монтажная ───────────────────────────────────────────────────────────────

async function withApp({ check = () => false, hasKey, draft = modelLike } = {}, fn) {
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
      // Слияние с PR 13: дословные роли («Утром», «Вечером») стоят в общем тексте эпизода рядом с угрозой, и фильтр
      // всего эпизода может дать остановку раньше проверки строк. Оба исхода закрыты: ролика нет.
      assert.equal(r.status, 422);
      assert.ok((r.body.validation && !r.body.validation.ok) || r.body.kind === 'safety', JSON.stringify(r.body.kind));
    }
    const urgent = { ...base, rows: [...base.rows, { role: 'Мысль', value: 'не хочу больше жить', source: 'не хочу больше жить' }] };
    const u = await post('/api/render', { story: MIX, episode: urgent });
    assert.equal(u.body.kind, 'safety');
    assert.equal(counters.render, 0);
  });
});

// ── Сверка основной сессии (f2da5268): поздняя остановка того же рассказа ────
// Тот же рассказ отправлен дважды; отдельная проверка первой отправки вернула true; черновик второй пришёл позже.
// Раньше оба ответа молча выходили — человек не получал ни карточки помощи, ни ответа.
async function twiceSameStory(order) {
  let checkTrue, draft2;
  let drafts = 0;
  const draft = (story, o) => (++drafts === 1 ? manual(story, o) : new Promise((r) => { draft2 = () => r(manual(story, o)); }));
  const b = botSetup({ draft, check: (t, n) => (n === 1 ? new Promise((r) => { checkTrue = () => r(true); }) : false) });
  const tick = () => new Promise((r) => setImmediate(r));
  const p1 = b.say(byId.OI10);
  while (!checkTrue) await tick();
  const p2 = b.say(byId.OI10);
  while (!draft2) await tick();
  if (order === 'check-first') { checkTrue(); await p1; draft2(); await p2; }
  else { draft2(); await tick(); checkTrue(); await p1; await p2; }
  await tick();
  return b;
}

for (const order of ['check-first', 'draft-first']) {
  test(`бот: тот же рассказ дважды, проверка первого вернула true (${order}) → одна карточка помощи, без реплики нехватки`, async () => {
    const b = await twiceSameStory(order);
    const urgent = b.texts().filter((t) => /Сейчас важнее не титры/.test(t));
    assert.equal(urgent.length, 1, `карточек помощи: ${urgent.length}; сообщения: ${JSON.stringify(b.texts())}`);
    // Оба порядка (сверка 5cffcd11): остановленный текст НИКОГДА не получает реплику нехватки. Во втором порядке
    // вторая проверка сказала «безопасно» раньше, но gate ждёт решения первой проверки того же рассказа.
    assert.ok(!b.texts().some((t) => t.startsWith(REPLY)), 'реплики нехватки нет');
    assert.match(b.texts().at(-1), /Сейчас важнее не титры/, 'последним — карточка помощи');
    assert.equal(b.bot.sessions.get(chat.id).verdict, 'blocked');
    assert.equal(b.counters.render, 0);
    // Повтор — сразу остановка.
    await b.say(byId.OI10);
    assert.match(b.texts().at(-1), /Сейчас важнее не титры/);
  });
}

test('нехватка: журнал ошибок и консоль не содержат текста рассказа (бот и монтажная)', async () => {
  const out = [];
  const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...a) => out.push(a.map(String).join(' '));
  try {
    const fail = () => { throw Object.assign(new Error(`сбой ${byId.OI10}`), { code: 'incomplete_response' }); };
    for (const check of [() => false, fail, fail]) {
      const b = botSetup({ check });
      await b.say(byId.OI10);
    }
    const huge = { contacts: [{ label: 'Ж'.repeat(5000), phone: '112' }] };
    insufficientMessages(true, { help: huge });
    await withApp({ check: fail }, async ({ post }) => { await post('/api/draft', { story: byId.OI10 }); await post('/api/draft', { story: byId.OI10 }); });
    await withApp({}, async ({ post }) => { await post('/api/draft', { story: byId.OI12 }); });
  } finally { Object.assign(console, saved); }
  assert.ok(out.length > 0, 'журнал вообще что-то записал (сбои проверки)');
  const all = out.join('\n').toLowerCase();
  for (const frag of ['злюсь', 'ударить', 'коллег', 'отчёт', 'соседа', 'оружия']) assert.ok(!all.includes(frag), `в журнале нет «${frag}»`);
});

test('заметка организатору при переходе на заготовку — по фактической причине', async () => {
  const titleFromThreat = modelDraft({ title: 'Ударить брата', rows: [
    { role: 'Утром', value: 'пила чай', source: 'Утром я пила чай' },
    { role: 'Вечером', value: 'пекла пирог', source: 'Вечером я пекла пирог' },
  ] });
  // Вариант 1 (PR 13, 12.11): заготовка строк не даёт, поэтому переход на неё — всегда нехватка без черновика и без
  // заметки; в ответе нет текста рассказа.
  const a = await makeDraft(MIX, { provider: 'claude', client: modelClient(titleFromThreat) });
  const fewRows = modelDraft({ rows: [{ role: 'Утром', value: 'пила чай', source: 'Утром я пила чай' }] });
  const b = await makeDraft(MIX, { provider: 'claude', client: modelClient(fewRows) });
  for (const r of [a, b]) {
    assert.equal(r.insufficient, true); assert.equal(r.episode, null);
    assert.ok(!/злюсь|ударить|чай|пирог/i.test(JSON.stringify(r)), 'в ответе нет текста рассказа');
  }
});

// Ветка «остановка на входе»: проверка прежней сессии (до /delete) вернула true уже после того, как тот же
// рассказ отправлен снова. Прежняя сессия молчит (она удалена), новая останавливается при своём ответе.
for (const kind of ['insufficient', 'episode']) {
  test(`бот: /delete, тот же рассказ снова, проверка прежней сессии true → новая сессия получает карточку помощи (${kind})`, async () => {
    let checkTrue, draft2;
    let drafts = 0;
    const story = kind === 'insufficient' ? byId.OI10 : MIX;
    const draft = (st, o) => (++drafts === 1 ? manual(byId.OI10, o) : new Promise((r) => { draft2 = () => r(manual(st, o)); }));
    const b = botSetup({ draft, check: (t, n) => (n === 1 ? new Promise((r) => { checkTrue = () => r(true); }) : false) });
    const tick = () => new Promise((r) => setImmediate(r));
    const p1 = b.say(story);
    while (!checkTrue) await tick();
    await b.say('/delete');
    const p2 = b.say(story);
    while (!draft2) await tick();
    checkTrue(); await p1; await tick();
    draft2(); await p2; await tick();
    const urgent = b.texts().filter((t) => /Сейчас важнее не титры/.test(t));
    assert.equal(urgent.length, 1, JSON.stringify(b.texts()));
    assert.match(b.texts().at(-1), /Сейчас важнее не титры/);
    assert.ok(!b.texts().some((t) => t.startsWith(REPLY)));
    assert.equal(b.bot.sessions.get(chat.id).episode, null, 'черновика нет');
  });
}

test('монтажная: две вкладки одновременно, тот же рассказ; первая проверка «опасно», вторая «безопасно» раньше → обе safety, реплики нехватки нет', async () => {
  let release;
  await withApp({ check: (t, n) => (n === 1 ? new Promise((r) => { release = () => r(true); }) : false) }, async ({ post, counters }) => {
    const first = post('/api/draft', { story: byId.OI10 });
    while (!release) await new Promise((r) => setTimeout(r, 5));
    const second = post('/api/draft', { story: byId.OI10 });
    while (counters.check < 2) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20)); // вторая проверка уже ответила «безопасно» и ждёт первую
    release();
    const [a, b] = await Promise.all([first, second]);
    for (const r of [a, b]) {
      assert.equal(r.body.kind, 'safety', JSON.stringify(r.body));
      assert.notEqual(r.body.error, REPLY);
    }
    const again = await post('/api/draft', { story: byId.OI10 });
    assert.equal(again.body.kind, 'safety');
  });
});

test('монтажная: вкладка A ещё пишет черновик (генератор вернёт остановку), вкладка B получила нехватку → B без реплики', async () => {
  let finishA; let n = 0;
  const draft = (story, o) => (++n === 1
    ? new Promise((r) => { finishA = () => r({ risk: { level: 'urgent', byModel: true, matches: [] }, episode: null, provider: 'claude' }); })
    : manual(story, o));
  await withApp({ draft }, async ({ post, counters }) => {
    const a = post('/api/draft', { story: byId.OI10 });
    while (!finishA) await new Promise((r) => setTimeout(r, 5));
    const b = post('/api/draft', { story: byId.OI10 });
    while (counters.check < 1) await new Promise((r) => setTimeout(r, 5)); // B дошла до проверки
    await new Promise((r) => setTimeout(r, 20)); // и получила «безопасно», ждёт черновик A
    finishA();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.body.kind, 'safety');
    assert.equal(rb.body.kind, 'safety', JSON.stringify(rb.body));
  });
});

test('бот: тот же рассказ дважды, первый черновик ещё пишется и вернёт остановку → вторая отправка без реплики, карточка одна', async () => {
  let finish; let n = 0;
  const draft = (story, o) => (++n === 1
    ? new Promise((r) => { finish = () => r({ risk: { level: 'urgent', byModel: true, matches: [] }, episode: null, provider: 'claude' }); })
    : manual(story, o));
  const b = botSetup({ draft });
  const tick = () => new Promise((r) => setImmediate(r));
  const p1 = b.say(byId.OI10);
  while (!finish) await tick();
  const p2 = b.say(byId.OI10);
  while (b.counters.check < 1) await tick(); // вторая отправка дошла до отдельной проверки и ждёт черновик первой
  for (let i = 0; i < 5; i++) await tick();
  finish(); await p1; await p2; await tick();
  assert.ok(!b.texts().some((t) => t.startsWith(REPLY)), JSON.stringify(b.texts()));
  assert.equal(b.texts().filter((t) => /Сейчас важнее не титры/.test(t)).length, 1, JSON.stringify(b.texts()));
});

test('бот и монтажная: сосед завис дольше предела → «проверка недоступна» (check_pending), а не реплика', async () => {
  const { makeGate } = await import('../server/gate.js');
  let n = 0;
  const check = () => (++n === 1 ? new Promise(() => {}) : false); // первая проверка никогда не отвечает
  // Бот: свой gate с коротким пределом.
  const sent = [];
  const tg = { send: async (c, text) => { sent.push(text); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => {} };
  const metrics = { hash: () => 'f', log: async () => {}, forget: async () => {} };
  const gate = makeGate({ check, neighborWaitMs: 30 });
  const bot = createBot({ tg, metrics, draft: manual, gate, safetyCheck: check });
  const other = { chat, text: byId.OI10 };
  gate.verify(`chat:${chat.id}`, byId.OI10, null, byId.OI10); // зависшая проверка того же рассказа
  await bot.handleUpdate({ message: other });
  assert.equal(sent.at(-1), TEXT.checkUnavailable);
  assert.ok(!sent.some((t) => t.startsWith(REPLY)));
});

// Решение владельца 11.11 13:05 п. 2: ключ объединения проверок — HMAC с секретной солью процесса, только в памяти;
// после двух ПАРАЛЛЕЛЬНЫХ отправок одного рассказа в журнале нет ни текста, ни ключа (даже усечённого).
test('ключ объединения проверок: соль процесса; параллельные отправки — в журнале нет ни текста, ни ключа', async () => {
  const story = byId.OI10;
  const plain = crypto.createHash('sha256').update(`story\0${normStory(story)}`).digest('hex');
  assert.notEqual(storyDigest(story), plain, 'ключ не совпадает с несолёным SHA-256 (словарный подбор невозможен)');
  assert.equal(storyDigest(story), storyDigest(story), 'в пределах процесса ключ устойчив');
  const keys = [storyDigest(story), plain];
  const out = [];
  const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...a) => out.push(a.map(String).join(' '));
  const sent = [];
  try {
    const fail = () => { throw Object.assign(new Error('сбой'), { code: 'incomplete_response' }); };
    for (const check of [() => false, () => true, fail]) {
      const slow = (t, n) => new Promise((r) => setTimeout(r, 5)).then(() => check(t, n));
      const b = botSetup({ check: slow });
      await Promise.all([b.say(story), b.say(story)]);
      // В одном чате вторая отправка вытесняет первую (поколение черновика), поэтому до проверки доходит хотя бы одна;
      // объединение проверок соседних сессий бота — в тестах «/delete, тот же рассказ снова» выше.
      assert.ok(b.counters.check >= 1, 'бот: отправка дошла до отдельной проверки');
      sent.push(...b.texts(), ...b.events.map((e) => JSON.stringify(e)));
      await withApp({ check: slow }, async ({ post, counters }) => {
        const rs = await Promise.all([post('/api/draft', { story }), post('/api/draft', { story })]);
        assert.ok(counters.check >= 2, 'монтажная: обе вкладки дошли до отдельной проверки');
        sent.push(...rs.map((r) => JSON.stringify(r.body)));
      });
    }
  } finally { Object.assign(console, saved); }
  const all = out.join('\n').toLowerCase();
  for (const frag of ['злюсь', 'ударить', 'коллег', 'отчёт', 'соседа']) assert.ok(!all.includes(frag), `в журнале нет «${frag}»`);
  const visible = `${all}\n${sent.join('\n')}`.toLowerCase();
  for (const key of keys) for (let i = 0; i + 8 <= key.length; i += 4) {
    assert.ok(!visible.includes(key.slice(i, i + 8)), 'ни ключ, ни его часть не попадают в журнал, метрики и ответы');
  }
});

// Решение владельца 11.11 14:02 п. 1 (б): отправка, открытая после снимка соседей, — следующая отправка, а не гонка;
// но остановка «липкая»: после неё никакой исход того же рассказа (нехватка, черновик, ролик) больше не показывается.
test('монтажная: A → нехватка показана; B того же рассказа → остановка; дальше только остановка, следа A нет', async () => {
  const story = byId.OI10;
  await withApp({ check: (t, n) => n >= 2 }, async ({ post, counters }) => {
    const a = await post('/api/draft', { story });
    assert.equal(a.status, 422); assert.equal(a.body.kind, 'insufficient', 'A: показана реплика нехватки');
    const b = await post('/api/draft', { story });
    assert.equal(b.status, 422); assert.equal(b.body.kind, 'safety', 'B: остановка');
    for (let i = 0; i < 3; i++) {
      const c = await post('/api/draft', { story });
      assert.equal(c.body.kind, 'safety', 'после остановки — снова только остановка');
      assert.ok(!JSON.stringify(c.body).includes(REPLY), 'реплики нехватки после остановки нет');
    }
    // Ролик после остановки рассказа не собирается — инвариант рендера, покрыт тестами S02/V02 монтажной
    // (tests/separate-check-studio.test.js, tests/qa-races.test.js). Здесь — что ни один черновик и ни одна реплика нехватки не показаны.
    assert.equal(counters.render, 0);
  });
});
