// Б2, вариант А (решение Дмитрия 24.11; чек-лист G0 v4, матрица Б-4): при любой неопределённости проверки ролика нет,
// человек видит мягкое «не получилось» (спокойному рассказу — без контактов помощи). Критерии строк 5, 9а, 9б и «после» — по чек-листу. Настоящий createBot
// (подтверждения — хелпер), подставная модель «не отвечает» и после повтора. Только вымышленные данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBot } from './helpers/consent.js';
import { TRY_LATER_TEXT } from '../server/safety.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const tick = () => new Promise((r) => setImmediate(r));
const waitFor = async (f) => { for (let i = 0; i < 200 && !f(); i++) await tick(); assert.ok(f(), 'условие не наступило'); };
const fail = () => { throw Object.assign(new Error('нет ответа'), { code: 'timeout' }); };

// check(text, call): подставная модель; storyCheck — для проверки перед сборкой (текст содержит рассказ).
function setup({ storyCheck = () => false, msgCheck = () => false, render } = {}) {
  const sent = []; const n = { check: 0, render: 0, video: 0 };
  const tg = { send: async (c, t) => { sent.push(t); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''),
    sendVideo: async (c, f, x, o = {}) => { if (o.ready && !(await o.ready())) return null; n.video++; return {}; } };
  const metrics = { hash: () => 'fictional', log: async () => {}, forget: async () => {} };
  const bot = createBot({ tg, metrics, checkRetryMs: 0,
    draft: async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }),
    safetyCheck: async (t) => { n.check++; return t.includes(ex.story.slice(0, 20)) ? storyCheck() : msgCheck(); },
    render: async (e, o) => { n.render++; if (render) await render(); return { seconds: 1, duration: 24, outPath: o.outPath }; } });
  const chat = { id: 77981, type: 'private' };
  const say = (text) => bot.handleUpdate({ message: { chat, text } });
  const play = () => bot.handleUpdate({ callback_query: { id: 'q', data: `play:${bot.sessions.get(chat.id).draftId}`, message: { chat } } });
  return { sent, n, say, play, setCheck: (f) => { storyCheck = f; }, setMsg: (f) => { msgCheck = f; } };
}

test('строка 5: локально чистый рассказ, модель не ответила и после повтора — стартов рендера 0, отправок 0, «не получилось»', async () => {
  const b = setup({ storyCheck: fail });
  await b.say(ex.story); await b.play();
  assert.equal(b.n.check, 2, 'один повтор');
  assert.deepEqual([b.n.render, b.n.video], [0, 0]);
  assert.equal(b.sent.at(-1), TRY_LATER_TEXT);
  // После: следующий разрешённый рассказ, модель отвечает «безопасно» — одна сборка и одна отправка.
  b.setCheck(() => false);
  await b.say(ex.story); await b.play();
  assert.deepEqual([b.n.render, b.n.video], [1, 1]);
});

test('строка 9а: окно доставки, сообщение без тревоги, неопределённость до старта рендера — отправок 0', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const b = setup({ storyCheck: () => gate, msgCheck: fail });
  await b.say(ex.story);
  const p = b.play(); await tick();
  await b.say('Пила чай с соседкой');
  assert.equal(b.sent.at(-1), TRY_LATER_TEXT);
  release(false); await p;
  assert.deepEqual([b.n.render, b.n.video], [0, 0]);
  b.setMsg(() => false);
  await b.say(ex.story); await b.play();
  assert.deepEqual([b.n.render, b.n.video], [1, 1], 'после: одна сборка и одна отправка');
});

test('строка 9б: окно доставки, рендер уже начат, неопределённость до отправки — отправок 0', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const b = setup({ msgCheck: fail, render: () => gate });
  await b.say(ex.story);
  const p = b.play();
  await waitFor(() => b.n.render === 1);
  await b.say('Пила чай с соседкой');
  release(); await p;
  assert.equal(b.n.video, 0, 'отправок после неопределённого результата 0; старт рендера — не нарушение');
  assert.ok(b.sent.includes(TRY_LATER_TEXT));
  b.setMsg(() => false);
  await b.say(ex.story); await b.play();
  assert.deepEqual([b.n.render, b.n.video], [2, 1], 'после: одна новая сборка и одна отправка');
});

test('сообщение окна и проверка рассказа обе «неизвестно» — «не получилось» один раз', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const b = setup({ storyCheck: () => gate.then(fail), msgCheck: fail });
  await b.say(ex.story);
  const p = b.play(); await tick();
  await b.say('Пила чай с соседкой');
  release(); await p;
  assert.equal(b.sent.filter((t) => t === TRY_LATER_TEXT).length, 1);
  assert.deepEqual([b.n.render, b.n.video], [0, 0]);
});

test('отзыв согласия (/start) во время проверки перед сборкой, затем «неизвестно» — без «не получилось»', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const b = setup({ storyCheck: () => gate.then(fail) });
  await b.say(ex.story);
  const p = b.play(); await tick();
  await b.say('/start');
  const n = b.sent.length;
  release(); await p;
  assert.ok(!b.sent.slice(n).includes(TRY_LATER_TEXT), 'после отзыва ответа о ролике нет');
  assert.deepEqual([b.n.render, b.n.video], [0, 0]);
});
