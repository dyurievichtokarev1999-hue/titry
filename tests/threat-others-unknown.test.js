// Решение 17.11 ~20:05 (PR 21): модель не ответила («неизвестно» и после повтора) + узкий локальный concern на угрозу
// другому → TRY_LATER и контакты, не ролик. Обе точки входа: монтажная (createApp) и бот (createBot). Гиперболы —
// прежнее поведение (ролик). Подставные: проверка, генератор, рендер, Telegram. Фразы вымышленные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createBot } from '../server/bot.js';
import { assessRisk, TRY_LATER_TEXT } from '../server/safety.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const OTHERS = [
  'Я его так отделал, что он теперь в больнице.',
  'Купил топор. Завтра сосед ответит за всё.',
  'Сосед своё получит, я уже канистру бензина купил.',
  'Держала сестру взаперти.',
];
const HYPERBOLE = [
  'Убил бы за это опоздание.',
  'Брат меня сегодня просто убил своей шуткой.',
  'Готова была разорвать этот принтер.',
  'Порвал всех на турнире по шахматам.',
  'Убила бы за чашку кофе с утра.',
];
// Сочетания нет — concern не поднимается: отдельные слова «топор», «бензин», «больница», «взаперти».
const SINGLE_WORDS = [
  'Купил топор для дачи.',
  'Залил бензин и поехал к маме.',
  'Бабушка в больнице, навещала её.',
  'Сидела взаперти весь день из-за дождя.',
  'Начальник ещё ответит за переработки.',
];
const unknown = () => { throw Object.assign(new Error('сбой'), { code: 'incomplete_response' }); };

test('локальный уровень: четыре фразы — concern; гиперболы и отдельные слова — none', () => {
  for (const p of OTHERS) assert.equal(assessRisk(p).level, 'concern', p);
  for (const p of [...HYPERBOLE, ...SINGLE_WORDS]) assert.equal(assessRisk(p).level, 'none', p);
});

async function studio(story) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-tou-'));
  const n = { check: 0, render: 0 };
  const server = createApp({ dataDir, safetyCheck: async () => { n.check++; return unknown(); }, hasKey: () => true, checkRetryMs: 0, render: async (e, o) => { n.render++; return { seconds: 1, outPath: o.outPath }; } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ story, episode: structuredClone(ex.episode) }) });
    return { status: res.status, body: await res.json(), n };
  } finally { server.closeAllConnections(); server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
}

test('монтажная, модель недоступна: четыре фразы → TRY_LATER с 112, рендера нет', async () => {
  for (const p of OTHERS) {
    const r = await studio(`${ex.story} ${p}`);
    assert.equal(r.status, 503, p); assert.equal(r.body.unknown, true, p);
    assert.notEqual(r.body.kind, 'safety', p);
    assert.match(r.body.help, /112/, p);
    assert.equal(r.n.check, 2, 'один повтор'); assert.equal(r.n.render, 0, p);
  }
});

test('монтажная, модель недоступна: гиперболы → ролик, как раньше', async () => {
  for (const p of HYPERBOLE) {
    const r = await studio(`${ex.story} ${p}`);
    assert.equal(r.status, 200, p); assert.equal(r.n.render, 1, p);
  }
});

async function bot(storyText) {
  const sent = [];
  const n = { check: 0, render: 0, video: 0 };
  const chat = { id: 77021, type: 'private' };
  const b = createBot({
    tg: { send: async (c, t) => { sent.push(t); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => { n.video++; } },
    metrics: { hash: () => 'qa-fictional', log: async () => {}, forget: async () => {} },
    draft: async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }),
    safetyCheck: async () => { n.check++; return unknown(); },
    checkRetryMs: 0,
    render: async (e, o) => { n.render++; return { seconds: 1, duration: 24, outPath: o.outPath }; },
  });
  await b.handleUpdate({ message: { chat, text: storyText } });
  for (let id = 0; id <= 2; id++) await b.handleUpdate({ callback_query: { id: 'q', data: `play:${id}`, message: { chat } } });
  return { sent, n };
}

test('бот, модель недоступна: четыре фразы → TRY_LATER с контактами, ролика нет', async () => {
  for (const p of OTHERS) {
    const r = await bot(`${ex.story} ${p}`);
    assert.equal(r.n.render, 0, p); assert.equal(r.n.video, 0, p);
    const all = r.sent.join('\n');
    assert.ok(all.includes(TRY_LATER_TEXT), p);
    assert.match(all, /\+7/, `контакты: ${p}`);
  }
});

test('бот, модель недоступна: гиперболы → ролик, как раньше', async () => {
  for (const p of HYPERBOLE) {
    const r = await bot(`${ex.story} ${p}`);
    assert.equal(r.n.video, 1, p);
  }
});
