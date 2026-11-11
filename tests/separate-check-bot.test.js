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
  await b.play();
  const at = b.sent.length;
  await b.story(); await b.play();
  assert.match(b.sent[at], /дважды не смог/, 'новый рассказ тот же — сразу техническая приостановка, без черновика');
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

// Контракт владельца 15:08 / 16:00 (QA D01–D04): /delete удаляет сессию и статистику, но не снимает
// ни safety, ни technical. Тот же рассказ после /delete → render/sendVideo = 0/0, прежнее сообщение.
const del = (b) => b.bot.handleUpdate({ message: { chat, text: '/delete' } });
const freshPlay = async (b, story = ex.story) => {
  await b.bot.handleUpdate({ message: { chat, text: story } });
  for (let n = 0; n <= 3; n++) await b.bot.handleUpdate({ callback_query: { id: 'q', data: `play:${n}`, message: { chat } } });
};

test('бот D01: обычное удаление без запрета — новый рассказ после /delete выдаётся', async () => {
  const b = setup({ check: () => false });
  await del(b);
  await freshPlay(b);
  assert.equal(b.counters.render, 1); assert.equal(b.counters.video, 1);
});

test('бот D02: technical → /delete → тот же рассказ — пауза сохраняется, 0/0, без помощи', async () => {
  const b = setup({ check: (t, n) => (n <= 2 ? fail() : false) });
  await b.story(); await b.play(); await b.play();
  assert.match(b.last(), /дважды не смог/);
  await del(b);
  const at = b.sent.length; // первое сообщение после нового рассказа
  await freshPlay(b);
  assert.match(b.sent[at], /дважды не смог завершить проверку рассказа/);
  assert.doesNotMatch(b.sent.join('\n'), HELP);
  assert.equal(b.counters.check, 2, 'после /delete проверка не запускается');
  assert.equal(b.counters.render, 0); assert.equal(b.counters.video, 0);
});

test('бот D03: safety → /delete → тот же рассказ — остановка сохраняется, 0/0, прежнее сообщение', async () => {
  const b = setup({ check: (t, n) => n === 1 });
  await b.story(); await b.play();
  const helpText = b.last();
  assert.match(helpText, HELP);
  await del(b);
  await freshPlay(b);
  assert.equal(b.last(), helpText);
  assert.equal(b.counters.check, 1); assert.equal(b.counters.render, 0); assert.equal(b.counters.video, 0);
});

test('бот D04: отказ удаления статистики — deleteFailed, запрет сохраняется, 0/0', async () => {
  const sent = []; const counters = { render: 0, video: 0 };
  const bot = createBot({
    tg: { send: async (c, t) => { sent.push(t); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => { counters.video++; } },
    metrics: { ...metrics, forget: async () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } },
    draft: good, safetyCheck: async () => true,
    render: async (e, o) => { counters.render++; return { seconds: 1, duration: 24, outPath: o.outPath }; },
  });
  await bot.handleUpdate({ message: { chat, text: ex.story } });
  await bot.handleUpdate({ callback_query: { id: 'q', data: 'play:1', message: { chat } } });
  await bot.handleUpdate({ message: { chat, text: '/delete' } });
  assert.match(sent[sent.length - 1], /подтвердить не получилось/);
  await bot.handleUpdate({ message: { chat, text: ex.story } });
  for (let n = 0; n <= 3; n++) await bot.handleUpdate({ callback_query: { id: 'q', data: `play:${n}`, message: { chat } } });
  assert.match(sent[sent.length - 1], HELP);
  assert.equal(counters.render, 0); assert.equal(counters.video, 0);
});

test('бот: другой участник не затронут запретом первого', async () => {
  const b = setup({ check: (t, n) => n === 1 });
  await b.story(); await b.play();
  const other = { id: 77002, type: 'private' };
  await b.bot.handleUpdate({ message: { chat: other, text: ex.story } });
  await b.bot.handleUpdate({ callback_query: { id: 'q', data: 'play:1', message: { chat: other } } });
  assert.equal(b.counters.render, 1); assert.equal(b.counters.video, 1);
});

// Исходы /delete (редактор 16:24, решение владельца 17:10): «удалены» — только при подтверждении;
// сохранённый запрет и неизвестное состояние сообщаются отдельно, «всё удалено» нигде нет.
test('бот /delete: исход 1 — нет записей → «Сессия и статистика по тебе удалены.»', async () => {
  const b = setup({ check: () => false });
  await b.story(); await b.play();
  await del(b);
  assert.equal(b.last(), 'Сессия и статистика по тебе удалены.');
});

test('бот /delete: запись запрета сохранена → удаление сессии подтверждено, полное удаление — нет', async () => {
  for (const check of [() => true, fail]) {
    const b = setup({ check });
    await b.story(); await b.play(); await b.play();
    await del(b);
    assert.equal(b.last(), 'Сессия и статистика по тебе удалены.\nПолное удаление не подтверждено.');
    assert.doesNotMatch(b.last(), /всё удалено/i);
  }
});

test('бот /delete: сбой статистики и неизвестное состояние хранилища называются отдельно', async () => {
  const sent = [];
  const brokenLedger = { lookup: () => ({ failed: true }), scopeKinds: () => null, flush: async () => false, put: async () => {}, clearTechnical: async () => {} };
  const bot = createBot({
    tg: { send: async (c, t) => { sent.push(t); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => {} },
    metrics: { ...metrics, forget: async () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } },
    draft: good, safetyCheck: async () => false, ledger: brokenLedger,
  });
  await bot.handleUpdate({ message: { chat, text: '/delete' } });
  assert.equal(sent.at(-1), 'Сессия удалена, а удаление статистики по тебе подтвердить не получилось. Попробуй /delete ещё раз чуть позже.\nПроверить состояние служебной записи не получилось. Полное удаление не подтверждено.');
});

test('бот /delete во время отдельной проверки: полное удаление не подтверждается; запрет после этого записан', async () => {
  let release; const held = new Promise((r) => { release = r; });
  const b = setup({ check: async () => { await held; return true; } });
  await b.story();
  const p = b.play();
  await new Promise((r) => setTimeout(r, 20));
  await del(b);
  assert.equal(b.last(), 'Сессия и статистика по тебе удалены.\nПолное удаление не подтверждено.');
  release(); await p;
  await del(b);
  assert.equal(b.last(), 'Сессия и статистика по тебе удалены.\nПолное удаление не подтверждено.');
  assert.equal(b.counters.render, 0); assert.equal(b.counters.video, 0);
});

test('бот /delete, исход 2: на вымышленном стенде — вид записи с маркером; вне стенда — маркера нет', async () => {
  const saved = process.env.TITRY_STAND;
  try {
    for (const [stand, check, expect] of [
      ['fictional', () => true, 'Сессия и статистика по тебе удалены.\nСлужебная запись об остановке по безопасности сохранена по правилу теста. В ней нет текста рассказа. [срок не утверждён]'],
      ['fictional', fail, 'Сессия и статистика по тебе удалены.\nСлужебная запись о технической приостановке сохранена по правилу теста. В ней нет текста рассказа. [срок не утверждён]'],
      [undefined, () => true, 'Сессия и статистика по тебе удалены.\nПолное удаление не подтверждено.'],
    ]) {
      if (stand) process.env.TITRY_STAND = stand; else delete process.env.TITRY_STAND;
      const b = setup({ check });
      await b.story(); await b.play(); await b.play();
      await del(b);
      assert.equal(b.last(), expect);
    }
  } finally { if (saved === undefined) delete process.env.TITRY_STAND; else process.env.TITRY_STAND = saved; }
});

test('бот /delete: сочетания — два вида записи; запись + идущая проверка (вымышленный стенд)', async () => {
  const saved = process.env.TITRY_STAND;
  process.env.TITRY_STAND = 'fictional';
  try {
    // Два вида: technical для одного рассказа, safety для другого — у одного участника.
    let n = 0;
    const b = setup({ check: (t) => { n++; if (t.includes('Вечером пила чай')) return true; throw Object.assign(new Error('x'), { code: 'timeout' }); } });
    await b.story(); await b.play(); await b.play(); // technical для первого рассказа
    await b.bot.handleUpdate({ message: { chat, text: `${ex.story} Вечером пила чай.` } });
    for (let k = 0; k <= 4; k++) await b.bot.handleUpdate({ callback_query: { id: 'q', data: `play:${k}`, message: { chat } } });
    await del(b);
    assert.equal(b.last(), [
      'Сессия и статистика по тебе удалены.',
      'Служебная запись об остановке по безопасности сохранена по правилу теста. В ней нет текста рассказа. [срок не утверждён]',
      'Служебная запись о технической приостановке сохранена по правилу теста. В ней нет текста рассказа. [срок не утверждён]',
    ].join('\n'));

    // Известная запись + проверка ещё идёт: вид назван, полный результат не подтверждается.
    let release; const held = new Promise((r) => { release = r; });
    let calls = 0;
    const c = setup({ check: async () => { calls++; if (calls === 1) return true; await held; return false; } });
    await c.story(); await c.play(); // safety для первого рассказа
    await c.bot.handleUpdate({ message: { chat, text: `${ex.story} Вечером пила чай.` } });
    const p = c.bot.handleUpdate({ callback_query: { id: 'q', data: 'play:3', message: { chat } } });
    await new Promise((r) => setTimeout(r, 20));
    await del(c);
    assert.equal(c.last(), [
      'Сессия и статистика по тебе удалены.',
      'Служебная запись об остановке по безопасности сохранена по правилу теста. В ней нет текста рассказа. [срок не утверждён]',
      'Полное удаление не подтверждено.',
    ].join('\n'));
    release(); await p;
  } finally { if (saved === undefined) delete process.env.TITRY_STAND; else process.env.TITRY_STAND = saved; }
});
