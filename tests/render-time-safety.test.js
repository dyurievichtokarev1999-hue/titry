// Сообщение во время подготовки ролика (КОД-РЕВЬЮ QA PR 15 12.11; решение Claude 12.11 11:05 п. 1).
// Настоящий createBot; подставные: черновик (вымышленный examples/day-quiet.json), отдельная проверка, рендер, Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBot, TEXT } from '../server/bot.js';
import { helpMessage, helpContacts, assessRisk } from '../server/safety.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const chat = { id: 77901, type: 'private' };
const URGENT_CARD = /Сейчас важнее не титры/;
// Как makeDraft: при urgent черновика нет (остановка), иначе — вымышленный эпизод.
const good = async (st) => (assessRisk(st).level === 'urgent' ? { risk: assessRisk(st), episode: null, provider: null }
  : { episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));

// check(text): для текста ролика (содержит рассказ) — prior(), для второго сообщения — second(text).
function setup({ prior = () => false, second = () => false, render } = {}) {
  const sent = []; const events = []; const counters = { video: 0, render: 0 };
  const tg = {
    send: async (c, text) => { sent.push(text); }, action: async () => {}, answer: async () => {},
    fileBuffer: async () => Buffer.from(''), sendVideo: async () => { counters.video++; },
  };
  const metrics = { hash: () => 'fictional', log: async (id, ev, extra = {}) => { events.push({ ev, ...extra }); }, forget: async () => {} };
  const bot = createBot({
    tg, metrics, draft: good,
    safetyCheck: async (t) => (t.includes(ex.story.slice(0, 20)) ? prior(t) : second(t)),
    render: async (e, o) => { counters.render++; if (render) await render(); return { seconds: 1, duration: 24, outPath: o.outPath }; },
  });
  const say = (text) => bot.handleUpdate({ message: { chat, text } });
  const play = () => bot.handleUpdate({ callback_query: { id: 'q', data: 'play:1', message: { chat } } });
  return { bot, sent, events, counters, say, play };
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

test('проверка второго сообщения не завершена → текст неизвестного исхода и контакты; ролик доставляется', async () => {
  const d = deferred();
  const b = setup({ prior: () => d.promise, second: () => { throw Object.assign(new Error('сбой'), { code: 'incomplete_response' }); } });
  await b.say(ex.story);
  const p = b.play(); await tick();
  await b.say('Пила чай');
  assert.equal(b.sent.at(-1), `${TEXT.checkUnavailable}\n\n${helpContacts()}`);
  d.resolve(false); await p;
  assert.equal(b.counters.video, 1);
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
