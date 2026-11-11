// Короткий текст (меньше 12 знаков) с признаками опасности не получает «Расскажи чуть подробнее»:
// он идёт путём рассказа — остановка и помощь. Обычный короткий текст — как прежде. Только вымышленные фразы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../server/bot.js';
import { assessRisk } from '../server/safety.js';
import { makeDraft } from '../server/draft.js';

const chat = { id: 77501, type: 'private' };
const MORE = /Расскажи чуть подробнее/;
const HELP = /помощ|112|телефон доверия|8-800/i;

function setup() {
  const sent = []; const counters = { draft: 0, render: 0 };
  const tg = { send: async (c, text) => { sent.push(text); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => {} };
  const metrics = { hash: () => 'fictional', log: async () => {}, forget: async () => {} };
  const bot = createBot({
    tg, metrics,
    draft: async (st, o) => { counters.draft++; return makeDraft(st, { ...o, provider: 'manual' }); }, // настоящий путь остановки, без модели
    safetyCheck: async () => false,
    render: async () => { counters.render++; return { seconds: 1, duration: 24 }; },
  });
  return { sent, counters, say: (text) => bot.handleUpdate({ message: { chat, text } }) };
}

for (const text of ['Убить себя', 'Убью брата', 'Прибью мужа', 'Я его убью']) {
  test(`короткий опасный текст «${text}» → помощь, без просьбы подробностей`, async () => {
    assert.ok(text.length < 12);
    assert.notEqual(assessRisk(text).level, 'none');
    const b = setup();
    await b.say(text);
    const all = b.sent.join('\n');
    assert.doesNotMatch(all, MORE);
    assert.match(all, HELP);
    assert.equal(b.counters.render, 0);
  });
}

test('обычный короткий текст — по-прежнему просьба рассказать подробнее', async () => {
  for (const text of ['Устала', 'Пила чай', 'Привет']) {
    const b = setup();
    await b.say(text);
    assert.match(b.sent.at(-1), MORE, text);
    assert.equal(b.counters.draft, 0);
  }
});
