// Решение Дмитрия 24.11 (А8): после 6А первым — вопрос про возраст (6Г), затем согласие на обработку данных (6Б).
// Настоящий createBot без заданного порядка. Только вымышленные данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../server/bot.js';
import { CONSENT_TEXT } from '../server/consent.js';

function bot() {
  const sent = []; let forgot = 0; const events = [];
  const tg = { send: async (c, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => {} };
  const metrics = { hash: () => 'qa-fictional', log: async (c, e) => { events.push(e); }, forget: async () => { forgot++; } };
  const b = createBot({ tg, metrics, safetyCheck: async () => false, checkRetryMs: 0, draft: async () => ({ episode: null }), render: async () => ({}) });
  const chat = { id: 93001, type: 'private' };
  const cycle = () => b.sessions.get(chat.id).consent.cycle;
  const press = (step, a) => b.handleUpdate({ callback_query: { id: 'q', data: `cs:${step}:${a}:${cycle()}`, message: { chat } } });
  const buttons = () => sent.at(-1).extra?.reply_markup?.inline_keyboard?.flat().map((k) => k.callback_data.split(':').slice(1, 3).join(':'));
  return { b, sent, events, press, buttons, say: (text) => b.handleUpdate({ message: { chat, text } }), forgot: () => forgot, step: () => b.sessions.get(chat.id).consent.step };
}

test('после 6А — вопрос про возраст, затем согласие; после обоих «Да» — 6Ж', async () => {
  const t = bot();
  await t.say('/start');
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.intro);
  await t.press('intro', 'next');
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.age, 'первым — возраст');
  assert.deepEqual(t.buttons(), ['age:yes', 'age:no']);
  await t.press('pd', 'yes'); // кнопка чужого шага ничего не делает
  assert.equal(t.step(), 'age');
  await t.press('age', 'yes');
  assert.deepEqual(t.buttons(), ['pd:yes', 'pd:no'], 'затем — согласие 6Б');
  await t.press('pd', 'yes');
  assert.equal(t.step(), 'done');
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.ready);
});

test('«Нет» на возрасте первым — отказ без отметок о согласии (их ещё нет); 6Б не показывается', async () => {
  const t = bot();
  await t.say('/start'); await t.press('intro', 'next');
  const n = t.sent.length;
  await t.press('age', 'no');
  assert.equal(t.step(), 'declined');
  assert.deepEqual(t.sent.slice(n).map((m) => m.text), [CONSENT_TEXT.ageDeclined], 'без «отметки удалены» — согласия ещё не было');
  assert.deepEqual(t.events, [], 'метрик нет');
});

test('6А называет порядок шагов так же, как он идёт', () => {
  assert.match(CONSENT_TEXT.intro, /Дальше — вопрос про возраст и согласие\./);
  assert.doesNotMatch(CONSENT_TEXT.intro, /на следующем шаге/);
});

test('согласие давалось раньше, затем /start и «Нет» на возрасте — сообщение «отметки удалены», метрики удаляются', async () => {
  const t = bot();
  await t.say('/start'); await t.press('intro', 'next'); await t.press('age', 'yes'); await t.press('pd', 'yes');
  assert.equal(t.step(), 'done');
  await t.say('/start'); await t.press('intro', 'next');
  const n = t.sent.length;
  await t.press('age', 'no');
  assert.deepEqual(t.sent.slice(n).map((m) => m.text), [CONSENT_TEXT.ageDeclined, CONSENT_TEXT.ageDeleted]);
  assert.equal(t.forgot(), 1);
});

test('отметка о согласии хранит версию текста с пометкой о порядке А8', async () => {
  const { CONSENT_VERSION } = await import('../server/consent.js');
  assert.match(CONSENT_VERSION, /А8/);
});
