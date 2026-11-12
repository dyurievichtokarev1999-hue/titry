// Сообщение во время подготовки ролика (КОД-РЕВЬЮ QA PR 15 12.11; решение Claude 12.11 11:05 п. 1).
// Настоящий createBot; подставные: черновик (вымышленный examples/day-quiet.json), отдельная проверка, рендер, Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBot, TEXT, telegram } from '../server/bot.js';
import { makeGate } from '../server/gate.js';
import { helpMessage, helpContacts, assessRisk } from '../server/safety.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const chat = { id: 77901, type: 'private' };
const URGENT_CARD = /Сейчас важнее не титры/;
// Как makeDraft: при urgent черновика нет (остановка), иначе — вымышленный эпизод.
const good = async (st) => (assessRisk(st).level === 'urgent' ? { risk: assessRisk(st), episode: null, provider: null }
  : { episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));
const unknownMsg = (why) => `${TEXT.unknownWhy[why]}\n${TEXT.unknownTail}\n\n${helpContacts()}`;

// check(text): для текста ролика (содержит рассказ) — prior(), для второго сообщения — second(text).
function setup({ prior = () => false, second = () => false, render, transcribe, holdWaitMs, chatId = chat.id, gateWrap } = {}) {
  const sent = []; const events = []; const counters = { video: 0, render: 0 };
  const h = {};
  const tg = {
    send: async (c, text) => { if (h.hangOn && h.hangOn(text)) return new Promise(() => {}); if (h.failOn && h.failOn(text)) throw Object.assign(new Error('Telegram 500'), { status: 500 }); sent.push(text); },
    action: async () => (h.hangAction ? new Promise(() => {}) : undefined), answer: async () => {},
    fileBuffer: async () => Buffer.from(''), sendVideo: async () => { counters.video++; },
  };
  const metrics = { hash: () => 'fictional', log: async (id, ev, extra = {}) => { events.push({ ev, ...extra }); }, forget: async () => {} };
  const bot = createBot({
    tg, metrics, draft: good, ...(transcribe ? { transcribe } : {}), ...(holdWaitMs ? { holdWaitMs } : {}),
    safetyCheck: async (t) => (t.includes(ex.story.slice(0, 20)) ? prior(t) : second(t)),
    ...(gateWrap ? { gate: gateWrap(makeGate({ check: async (t) => (t.includes(ex.story.slice(0, 20)) ? prior(t) : second(t)) })) } : {}),
    render: async (e, o) => { counters.render++; if (render) await render(); return { seconds: 1, duration: 24, outPath: o.outPath }; },
  });
  const c = { ...chat, id: chatId };
  const say = (text) => bot.handleUpdate({ message: { chat: c, text } });
  const voice = (duration = 3) => bot.handleUpdate({ message: { chat: c, voice: { file_id: 'f', duration } } });
  const photo = (caption) => bot.handleUpdate({ message: { chat: c, photo: [{ file_id: 'p' }], caption } });
  const play = () => bot.handleUpdate({ callback_query: { id: 'q', data: 'play:1', message: { chat: c } } });
  return Object.assign(h, { bot, sent, events, counters, say, voice, photo, play });
}

test('проверка ролика задержана; второе сообщение urgent → экран остановки, ролик не отправляется никогда', async () => {
  const d = deferred();
  const b = setup({ prior: () => d.promise });
  await b.say(ex.story);
  const p = b.play(); await tick();
  await b.say('Убить себя'); // контрольная фраза из тестов PR 15 (локально urgent)
  assert.match(b.sent.at(-1), URGENT_CARD);
  assert.ok(!b.sent.slice(-1).includes(TEXT.rendering));
  d.resolve(false); await p;
  assert.equal(b.counters.video, 0); assert.equal(b.counters.render, 0);
  assert.match(b.sent.at(-1), URGENT_CARD, 'после экрана остановки ничего не уходит');
});

test('проверка ролика задержана; второе сообщение concern → блок помощи, ролик доставляется', async () => {
  const d = deferred();
  const b = setup({ prior: () => d.promise });
  await b.say(ex.story);
  const p = b.play(); await tick();
  await b.say('Убью брата');
  assert.equal(b.sent.at(-1), helpMessage('concern'));
  d.resolve(false); await p;
  assert.equal(b.counters.video, 1);
});

test('проверка ролика задержана; второе сообщение безопасно → «Собираю ролик», ролик доставляется', async () => {
  const d = deferred();
  const b = setup({ prior: () => d.promise });
  await b.say(ex.story);
  const p = b.play(); await tick();
  await b.say('Привет');
  assert.equal(b.sent.at(-1), TEXT.rendering);
  d.resolve(false); await p;
  assert.equal(b.counters.video, 1);
});

test('рендер завершён, доставка ждёт проверку второго сообщения; модель — опасно → ролик не отправляется', async () => {
  const r = deferred(); const m = deferred();
  const b = setup({ render: () => r.promise, second: () => m.promise });
  await b.say(ex.story);
  const p = b.play();
  for (let i = 0; i < 20 && b.counters.render === 0; i++) await tick();
  assert.equal(b.counters.render, 1, 'рендер начался');
  const q = b.say('Сдохну'); await tick();
  r.resolve(); for (let i = 0; i < 10; i++) await tick();
  assert.equal(b.counters.video, 0, 'доставка ждёт проверки второго сообщения');
  m.resolve(true); await q; await p;
  assert.equal(b.counters.video, 0);
  assert.match(b.sent.at(-1), URGENT_CARD);
});

test('проверка второго сообщения не завершена → текст неизвестного исхода и контакты; ролик НЕ отправляется (решение 12.11 15:10)', async () => {
  const d = deferred();
  const b = setup({ prior: () => d.promise, second: () => { throw Object.assign(new Error('сбой'), { code: 'incomplete_response' }); } });
  await b.say(ex.story);
  const p = b.play(); await tick();
  await b.say('Пила чай');
  assert.equal(b.sent.at(-1), unknownMsg('check'));
  d.resolve(false); await p;
  assert.equal(b.counters.video, 0);
});

test('urgent уже после отправки ролика → экран остановки всё равно показан', async () => {
  const b = setup();
  await b.say(ex.story);
  await b.play();
  assert.equal(b.counters.video, 1);
  await b.say('Убить себя');
  assert.match(b.sent.at(-1), URGENT_CARD);
});

test('во время подготовки: «/текст» проверяется; текст второго сообщения не попадает в журнал и метрики', async () => {
  const out = [];
  const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...a) => out.push(a.map(String).join(' '));
  let b;
  try {
    const d = deferred();
    b = setup({ prior: () => d.promise, second: () => { throw Object.assign(new Error('сбой Сдохну'), { code: 'incomplete_response' }); } });
    await b.say(ex.story);
    const p = b.play(); await tick();
    await b.say('/start Убить себя');
    assert.match(b.sent.at(-1), URGENT_CARD);
    d.resolve(false); await p;
    assert.equal(b.counters.video, 0);
  } finally { Object.assign(console, saved); }
  const all = `${out.join('\n')}\n${JSON.stringify(b.events)}`.toLowerCase();
  assert.ok(!all.includes('убить себя') && !all.includes('сдохну'), all);
  assert.ok(b.events.some((e) => e.ev === 'safety' && e.at === 'rendering'));
});

const waitFor = async (cond) => { for (let i = 0; i < 50 && !cond(); i++) await tick(); };

test('голос во время подготовки держит доставку с начала распознавания: долгая расшифровка urgent → ролика нет', async () => {
  const t = deferred(); const r = deferred();
  const b = setup({ transcribe: () => t.promise, render: () => r.promise });
  await b.say(ex.story);
  const p = b.play();
  await waitFor(() => b.counters.render === 1);
  const v = b.voice(); await tick();
  r.resolve(); // рендер готов раньше расшифровки — доставка всё равно ждёт
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(b.counters.video, 0, 'ролик ждёт распознавания голоса');
  t.resolve('Убить себя'); await v; await p;
  assert.equal(b.counters.video, 0);
  assert.match(b.sent.at(-1), URGENT_CARD);
});

test('«/start» во время подготовки не снимает проверку: следующее «Сдохну» (только модель) держит и отменяет ролик', async () => {
  const r = deferred(); const m = deferred();
  const b = setup({ render: () => r.promise, second: () => m.promise });
  await b.say(ex.story);
  const p = b.play();
  await waitFor(() => b.counters.render === 1);
  await b.say('/start');
  const q = b.say('Сдохну'); await tick();
  r.resolve(); for (let i = 0; i < 10; i++) await tick();
  assert.equal(b.counters.video, 0);
  m.resolve(true); await q; await p;
  assert.equal(b.counters.video, 0);
  assert.match(b.sent.at(-1), URGENT_CARD);
});

test('проверка сообщения зависла дольше предела → ролик не отправляется, текст неизвестного исхода и контакты', async () => {
  const d = deferred();
  const b = setup({ prior: () => d.promise, second: () => new Promise(() => {}), holdWaitMs: 30 });
  await b.say(ex.story);
  const p = b.play(); await tick();
  b.say('Пила чай'); await tick();
  d.resolve(false);
  await p;
  assert.equal(b.counters.video, 0);
  assert.equal(b.sent.at(-1), unknownMsg('timeout'));
});

test('второе сообщение приходит, пока доставка уже ждёт первое: ждём оба; второе опасно → ролика нет', async () => {
  const r = deferred(); const m1 = deferred(); const m2 = deferred();
  let n = 0;
  const b = setup({ render: () => r.promise, second: () => (++n === 1 ? m1.promise : m2.promise) });
  await b.say(ex.story);
  const p = b.play();
  await waitFor(() => b.counters.render === 1);
  const q1 = b.say('Привет'); await tick();
  r.resolve(); for (let i = 0; i < 5; i++) await tick();
  const q2 = b.say('Сдохну'); await tick();
  m1.resolve(false); await q1; for (let i = 0; i < 5; i++) await tick();
  assert.equal(b.counters.video, 0, 'доставка ждёт и второе сообщение');
  m2.resolve(true); await q2; await p;
  assert.equal(b.counters.video, 0);
});

test('«/start@bot <хвост>» — проверяется хвост (модель); повтор опасного текста — снова остановка, рассказ ролика не запрещён', async () => {
  const d = deferred();
  const b = setup({ prior: () => d.promise, second: (t) => t === 'Сдохну' });
  await b.say(ex.story);
  const p = b.play(); await tick();
  await b.say('/start@titry_bot Сдохну');
  assert.match(b.sent.at(-1), URGENT_CARD);
  d.resolve(false); await p;
  assert.equal(b.counters.video, 0);
  await b.say('Сдохну');
  assert.match(b.sent.at(-1), URGENT_CARD, 'запрет — на опасное сообщение');
  await b.say(ex.story);
  assert.doesNotMatch(b.sent.at(-1), URGENT_CARD, 'рассказ ролика под запрет не попал');
});

// КОД-РЕВЬЮ QA 12.11 14:28 (дословный сценарий): распознавание даёт urgent, отправка расшифровки отклоняется (500),
// отправка экрана помощи разрешена → 0 доставок после завершения рендера, экран остановки есть, текста нет в журнале.
test('голос: отказ отправки расшифровки не снимает проверку — ролика нет, экран остановки есть, журнал без текста', async () => {
  const out = [];
  const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...a) => out.push(a.map(String).join(' '));
  const r = deferred();
  let b;
  try {
    b = setup({ transcribe: async () => 'Убить себя', render: () => r.promise });
    await b.say(ex.story);
    const p = b.play();
    await waitFor(() => b.counters.render === 1);
    b.failOn = (t) => t.startsWith('Расшифровка'); // заглушка Telegram: отказ только на эхо расшифровки
    await b.voice();
    r.resolve(); await p;
    assert.equal(b.counters.video, 0, '0 доставок после завершения рендера');
    assert.match(b.sent.at(-1), URGENT_CARD, 'экран остановки отправлен');
    assert.ok(!b.sent.some((t) => t.startsWith('Расшифровка')), 'эхо не дошло (500)');
  } finally { Object.assign(console, saved); }
  const all = `${out.join('\n')}\n${JSON.stringify(b.events)}`.toLowerCase();
  assert.ok(!all.includes('убить себя'), all);
});

test('принцип удержания: отказ отправки «Собираю ролик» при безопасном втором сообщении — ролик доставляется после проверки', async () => {
  const m = deferred(); const r = deferred();
  const b = setup({ second: () => m.promise, render: () => r.promise });
  await b.say(ex.story);
  const p = b.play();
  await waitFor(() => b.counters.render === 1);
  b.failOn = (t) => t === TEXT.rendering;
  const q = b.say('Пила чай'); await tick();
  r.resolve(); for (let i = 0; i < 10; i++) await tick();
  assert.equal(b.counters.video, 0, 'доставка ждёт проверку, а не отправку «Собираю ролик»');
  m.resolve(false); await q; await p;
  assert.equal(b.counters.video, 1);
});

test('не удалось отправить и экран остановки — ролик всё равно не отправляется', async () => {
  const d = deferred();
  const b = setup({ prior: () => d.promise });
  await b.say(ex.story);
  const p = b.play(); await tick();
  b.failOn = (t) => URGENT_CARD.test(t);
  await b.say('Убить себя');
  d.resolve(false); await p;
  assert.equal(b.counters.video, 0);
});

test('после предела ожидания поздний ответ «безопасно» не отправляет «Собираю ролик»', async () => {
  const d = deferred(); const m = deferred();
  const b = setup({ prior: () => d.promise, second: () => m.promise, holdWaitMs: 30 });
  await b.say(ex.story);
  const p = b.play(); await tick();
  const q = b.say('Пила чай'); await tick();
  d.resolve(false); await p;
  const n = b.sent.length;
  m.resolve(false); await q;
  assert.equal(b.sent.length, n, 'после истечения предела обещания ролика нет');
  assert.equal(b.counters.video, 0);
});

test('голос во время подготовки: расшифровки нет (сбой распознавания) → «неизвестно», ролик не отправляется', async () => {
  const r = deferred();
  const b = setup({ transcribe: async () => { throw new Error('stt'); }, render: () => r.promise });
  await b.say(ex.story);
  const p = b.play();
  await waitFor(() => b.counters.render === 1);
  await b.voice();
  r.resolve(); await p;
  assert.equal(b.counters.video, 0);
  assert.equal(b.sent.at(-1), unknownMsg('voiceEmpty'));
});

test('голос во время подготовки длиннее предела (не распознаётся) → ролик не отправляется', async () => {
  const r = deferred();
  const b = setup({ transcribe: async () => 'Пила чай', render: () => r.promise });
  await b.say(ex.story);
  const p = b.play();
  await waitFor(() => b.counters.render === 1);
  await b.voice(100000);
  r.resolve(); await p;
  assert.equal(b.counters.video, 0);
});

test('исключение в самой проверке (gate.probe) → «неизвестно», ролик не отправляется', async () => {
  const r = deferred();
  const b = setup({ render: () => r.promise, gateWrap: (g) => ({ ...g, probe: async () => { throw new Error('хранилище'); } }) });
  await b.say(ex.story);
  const p = b.play();
  await waitFor(() => b.counters.render === 1);
  await b.say('Пила чай');
  r.resolve(); await p;
  assert.equal(b.counters.video, 0);
});

test('«неизвестно» прежней доставки не запрещает следующую; подпись к фото проверяется', async () => {
  const d = deferred();
  let fail = true;
  const b = setup({ prior: () => d.promise, second: () => { if (fail) throw Object.assign(new Error('x'), { code: 'incomplete_response' }); return false; } });
  await b.say(ex.story);
  let p = b.play(); await tick();
  await b.say('Пила чай');
  d.resolve(false); await p;
  assert.equal(b.counters.video, 0);
  fail = false;
  await b.say(ex.story);
  p = b.bot.handleUpdate({ callback_query: { id: 'q', data: 'play:2', message: { chat } } });
  await p;
  assert.equal(b.counters.video, 1, 'новая доставка без «неизвестно» — ролик уходит');
  const r = deferred();
  const c = setup({ render: () => r.promise, chatId: 77902 });
  await c.say(ex.story);
  const pc = c.play();
  await waitFor(() => c.counters.render === 1);
  await c.photo('Убить себя');
  r.resolve(); await pc;
  assert.equal(c.counters.video, 0);
  assert.match(c.sent.at(-1), URGENT_CARD);
});

test('кружок или аудиофайл во время подготовки — содержание неизвестно, ролик не отправляется', async () => {
  for (const extra of [{ video_note: { file_id: 'v' } }, { audio: { file_id: 'a' } }]) {
    const r = deferred();
    const b = setup({ render: () => r.promise });
    await b.say(ex.story);
    const p = b.play();
    await waitFor(() => b.counters.render === 1);
    await b.bot.handleUpdate({ message: { chat, ...extra } });
    r.resolve(); await p;
    assert.equal(b.counters.video, 0, JSON.stringify(Object.keys(extra)));
  }
});

// Решение Claude 12.11 20:00, блокер 1: экран остановки не ждёт ни эха, ни typing, ни метрик.
test('эхо расшифровки или typing никогда не завершаются → экран остановки отправлен, эха при urgent нет, ролика нет', async () => {
  for (const mode of ['echo', 'typing']) {
    const r = deferred();
    const b = setup({ transcribe: async () => 'Убить себя', render: () => r.promise });
    await b.say(ex.story);
    const p = b.play();
    await waitFor(() => b.counters.render === 1);
    if (mode === 'echo') b.hangOn = (t) => t.startsWith('Расшифровка'); else b.hangAction = true;
    await b.voice();
    r.resolve(); await p;
    assert.equal(b.counters.video, 0, mode);
    assert.match(b.sent.at(-1), URGENT_CARD, mode);
    assert.ok(!b.sent.some((t) => t.startsWith('Расшифровка')), `${mode}: эхо при urgent не отправляется`);
  }
});

test('отказ отправки экрана остановки не ломает остальное: метрика остановки записана, ролика нет', async () => {
  const d = deferred();
  const b = setup({ prior: () => d.promise });
  await b.say(ex.story);
  const p = b.play(); await tick();
  b.failOn = (t) => URGENT_CARD.test(t);
  await b.say('Убить себя'); await tick();
  d.resolve(false); await p;
  assert.equal(b.counters.video, 0);
  assert.ok(b.events.some((e) => e.ev === 'safety' && e.at === 'rendering'), 'после отказа отправки обработчик дошёл до метрики');
});

// Блокер 2: для каждого входа с неизвестным исходом — ролика нет, причина, «проверка не завершилась», контакты.
test('неизвестный исход любого входа во время подготовки — ролик 0, объяснение и контакты', async () => {
  const cases = [
    ['длинное голосовое', (b) => b.voice(100000), 'voiceLong', { transcribe: async () => 'Пила чай' }],
    ['распознавание выключено', (b) => b.voice(), 'voiceOff', {}],
    ['пустая расшифровка', (b) => b.voice(), 'voiceEmpty', { transcribe: async () => '' }],
    ['кружок', (b) => b.bot.handleUpdate({ message: { chat, video_note: { file_id: 'v' } } }), 'unsupported', {}],
    ['аудиофайл', (b) => b.bot.handleUpdate({ message: { chat, audio: { file_id: 'a' } } }), 'unsupported', {}],
    ['видео без подписи', (b) => b.bot.handleUpdate({ message: { chat, video: { file_id: 'w' } } }), 'unsupported', {}],
    ['видео с безопасной подписью', (b) => b.bot.handleUpdate({ message: { chat, video: { file_id: 'w' }, caption: 'Пила чай' } }), 'unsupported', {}],
    ['стикер', (b) => b.bot.handleUpdate({ message: { chat, sticker: { file_id: 's' } } }), 'unsupported', {}],
  ];
  for (const [name, act, why, opts] of cases) {
    const r = deferred();
    const b = setup({ render: () => r.promise, ...opts });
    await b.say(ex.story);
    const p = b.play();
    await waitFor(() => b.counters.render === 1);
    await act(b);
    r.resolve(); await p;
    assert.equal(b.counters.video, 0, name);
    assert.equal(b.sent.at(-1), unknownMsg(why), name);
  }
});

test('адаптер Telegram: у вызова API есть предел ожидания приложения', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = (url, opts) => new Promise((_, rej) => { if (opts && opts.signal) opts.signal.addEventListener('abort', () => rej(opts.signal.reason)); });
  try {
    const keep = setInterval(() => {}, 50); // AbortSignal.timeout не держит цикл событий
    const tg = telegram('000:fictional', { callMs: 30 });
    const t0 = Date.now();
    await assert.rejects(tg.send(1, 'текст'), (e) => e && (e.name === 'TimeoutError' || e.name === 'AbortError'));
    assert.ok(Date.now() - t0 < 2000);
    clearInterval(keep);
  } finally { globalThis.fetch = saved; }
});
