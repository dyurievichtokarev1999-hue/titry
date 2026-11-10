// Матрица приёмки QA 10.11 13:29 — бот. Настоящий createBot; подставные: генератор, отдельная проверка, рендер, Telegram.
// В боте проверяются маршрут и сообщение (без HTTP). Только вымышленные истории (examples/day-quiet.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBot } from '../server/bot.js';
import { RETRY_AFTER_MS } from '../server/gate.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const chat = { id: 77001, type: 'private' };
const metrics = { hash: () => 'qa-fictional', log: async () => {}, forget: async () => {} };
const good = async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] });
const fail = () => { throw Object.assign(new Error('сбой МАРКЕР'), { code: 'incomplete_response' }); };
const HELP = /помощ|112|телефон доверия|8-800/i;

function setup({ check, hasKey, draft = good } = {}) {
  const sent = [];
  const counters = { render: 0, video: 0, check: 0 };
  const clock = { mono: 5_000, wall: Date.parse('2026-11-10T12:00:00Z') };
  const tg = {
    send: async (c, text) => { sent.push(text); }, action: async () => {}, answer: async () => {},
    fileBuffer: async () => Buffer.from(''),
    sendVideo: async () => { counters.video++; },
  };
  const bot = createBot({
    tg, metrics, draft,
    safetyCheck: async (t) => { counters.check++; return check(t, counters.check); },
    ...(hasKey ? { hasKey } : {}),
    monoNow: () => clock.mono, wallNow: () => clock.wall,
    render: async (e, o) => { counters.render++; return { seconds: 1, duration: 24, outPath: o.outPath }; },
  });
  let draftId = 0;
  const story = async () => { await bot.handleUpdate({ message: { chat, text: ex.story } }); draftId++; };
  const play = () => bot.handleUpdate({ callback_query: { id: 'q', data: `play:${draftId}`, message: { chat } } });
  return { bot, sent, counters, clock, story, play, last: () => sent[sent.length - 1] };
}

test('бот S02: отдельная проверка true → сообщение помощи, sendVideo 0; повтор не снимает', async () => {
  const b = setup({ check: () => true });
  await b.story(); await b.play();
  assert.match(b.last(), HELP);
  // Новый черновик того же рассказа не появляется (остановка), и ни одна кнопка не запускает рендер.
  await b.story();
  for (let n = 0; n <= 6; n++) await b.bot.handleUpdate({ callback_query: { id: 'q', data: `play:${n}`, message: { chat } } });
  assert.equal(b.counters.render, 0); assert.equal(b.counters.video, 0);
  assert.equal(b.counters.check, 1, 'после остановки рассказ больше не проверяется');
});

test('бот U01–U05: первый неполный ответ → checkUnavailable без помощи; render/sendVideo 0', async () => {
  const b = setup({ check: fail });
  await b.story(); await b.play();
  assert.match(b.last(), /не завершил проверку/);
  assert.doesNotMatch(b.sent.join('\n'), HELP);
  assert.equal(b.counters.render, 0); assert.equal(b.counters.video, 0);
});

test('бот U06: нет ключа → checkUnavailable, проверка не вызывается', async () => {
  const b = setup({ check: () => false, hasKey: () => false });
  await b.story(); await b.play(); await b.play(); await b.play();
  assert.match(b.last(), /не завершил проверку/);
  assert.equal(b.counters.check, 0); assert.equal(b.counters.render, 0); assert.equal(b.counters.video, 0);
});

test('бот U07: неполный, затем полный false → один render и одна выдача', async () => {
  const b = setup({ check: (t, n) => (n === 1 ? fail() : false) });
  await b.story(); await b.play(); await b.play();
  assert.equal(b.counters.render, 1); assert.equal(b.counters.video, 1);
});

test('бот T01/T03: два неполных подряд → техническая приостановка без помощи; время без организатора ничего не снимает', async () => {
  const b = setup({ check: fail });
  await b.story(); await b.play(); await b.play();
  assert.match(b.last(), /дважды не смог завершить проверку/);
  assert.doesNotMatch(b.sent.join('\n'), HELP);
  assert.doesNotMatch(b.last(), /опасн|тяж[её]л/i);
  b.clock.mono += RETRY_AFTER_MS * 3; b.clock.wall += RETRY_AFTER_MS * 3;
  await b.play(); await b.story(); await b.play();
  assert.match(b.last(), /дважды не смог/);
  assert.equal(b.counters.check, 2); assert.equal(b.counters.render, 0); assert.equal(b.counters.video, 0);
});

test('бот V04: /delete во время отдельной проверки — сессия не оживает, рендера и выдачи нет', async () => {
  let release; const held = new Promise((r) => { release = r; });
  const b = setup({ check: async () => { await held; return false; } });
  await b.story();
  const p = b.play();
  await new Promise((r) => setTimeout(r, 20));
  await b.bot.handleUpdate({ message: { chat, text: '/delete' } });
  release(); await p;
  assert.equal(b.counters.render, 0); assert.equal(b.counters.video, 0);
});

test('бот V04: /delete начинает новую область — прежний technical не переносится (граница как у прежнего s.blocked)', async () => {
  const b = setup({ check: (t, n) => (n <= 2 ? fail() : false) });
  await b.story(); await b.play(); await b.play();
  assert.match(b.last(), /дважды не смог/);
  await b.bot.handleUpdate({ message: { chat, text: '/delete' } });
  await b.bot.handleUpdate({ message: { chat, text: ex.story } });
  await b.bot.handleUpdate({ callback_query: { id: 'q', data: 'play:1', message: { chat } } }); // новая сессия — первый черновик
  assert.equal(b.counters.render, 1);
});
