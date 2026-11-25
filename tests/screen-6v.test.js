// Экран 6В «Согласие на передачу рассказа за границу» (решение Дмитрия 24.11, А2: модель Anthropic; очередь G0, п. 5).
// Текст — черновик из «Комплект для юриста — v2.7» с маркером: проверка выпуска не пропускает его до ответа юриста.
// Порядок 6Г → 6А → 6Б → 6В → 6Ж. Настоящий createBot без заданного порядка. Только вымышленные данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../server/bot.js';
import { CONSENT_TEXT } from '../server/consent.js';
import { markerHits, unfinishedTexts } from '../server/release.js';

function bot() {
  const sent = []; let forgot = 0; const events = []; const n = { draft: 0, check: 0 };
  const tg = { send: async (c, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => {} };
  const metrics = { hash: () => 'qa-fictional', log: async (c, e) => { events.push(e); }, forget: async () => { forgot++; } };
  const b = createBot({ tg, metrics, safetyCheck: async () => { n.check++; return false; }, checkRetryMs: 0, draft: async () => { n.draft++; return { episode: null }; }, render: async () => ({}) });
  const chat = { id: 93101, type: 'private' };
  const cycle = () => b.sessions.get(chat.id).consent.cycle;
  const press = (step, a) => b.handleUpdate({ callback_query: { id: 'q', data: `cs:${step}:${a}:${cycle()}`, message: { chat } } });
  const say = (text) => b.handleUpdate({ message: { chat, text } });
  const toAbroad = async () => { await say('/start'); await press('age', 'yes'); await press('intro', 'next'); await press('pd', 'yes'); };
  const buttons = () => sent.at(-1).extra?.reply_markup?.inline_keyboard?.flat().map((k) => [k.text, k.callback_data.split(':').slice(1, 3).join(':')]);
  return { b, sent, events, n, press, say, toAbroad, buttons, texts: () => sent.map((m) => m.text), forgot: () => forgot, s: () => b.sessions.get(chat.id) };
}

test('6В после 6Б: текст из комплекта, кнопки «Даю согласие на передачу» / «Не сейчас»; «Да» → 6Ж, отметка 6В', async () => {
  const t = bot();
  await t.toAbroad();
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.abroad);
  assert.deepEqual(t.buttons(), [['Даю согласие на передачу', 'abroad:yes'], ['Не сейчас', 'abroad:no']]);
  assert.equal(t.s().consent.step, 'abroad', 'до 6В рассказ ещё не принимается');
  await t.say('Утром убежал кофе, днём искали ключи.');
  assert.equal(t.n.draft + t.n.check, 0, 'рассказ на 6В не обрабатывается');
  await t.press('abroad', 'yes');
  assert.equal(t.s().consent.step, 'done');
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.ready);
  assert.ok(t.s().consent.given.pd && t.s().consent.given.abroad, 'отметки 6Б и 6В');
});

test('6В «Не сейчас»: ответ из комплекта, рассказ не принимается, согласие 6Б не отзывается (метрики не удаляются)', async () => {
  const t = bot();
  await t.toAbroad();
  await t.press('abroad', 'no');
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.abroadDeclined);
  assert.equal(t.s().consent.step, 'declined');
  assert.ok(t.s().consent.given.pd, 'отметка 6Б остаётся');
  assert.equal(t.forgot(), 0, 'отказ от передачи — не отзыв согласия на обработку');
  const n = t.sent.length;
  await t.say('Утром убежал кофе.');
  assert.equal(t.sent.length, n, 'после отказа — тишина');
  assert.equal(t.n.draft, 0);
  await t.say('/start');
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.age, '/start — заново с вопроса о возрасте');
});

test('6В: чужое значение кнопки и кнопка прошлого прохождения ничего не меняют', async () => {
  const t = bot();
  await t.toAbroad();
  const old = t.s().consent.cycle;
  await t.b.handleUpdate({ callback_query: { id: 'q', data: `cs:abroad:next:${old}`, message: { chat: { id: 93101, type: 'private' } } } });
  assert.equal(t.s().consent.step, 'abroad');
  await t.say('/start');
  await t.b.handleUpdate({ callback_query: { id: 'q', data: `cs:abroad:yes:${old}`, message: { chat: { id: 93101, type: 'private' } } } });
  assert.equal(t.s().consent.step, 'age', 'кнопка прошлого прохождения не засчитывается');
});

test('6В — черновик: маркер «на согласование с юристом» и поле контакта; проверка выпуска его не пропускает', () => {
  assert.equal(markerHits(CONSENT_TEXT.abroad).length, 1, 'маркер черновика');
  assert.match(CONSENT_TEXT.abroad, /\[ЗАПОЛНИТЬ после встречи 26\.11: контакт \(А5\)\]/);
  assert.ok(unfinishedTexts({ CONSENT_TEXT }).includes('CONSENT_TEXT.abroad'));
  assert.ok(!unfinishedTexts({ CONSENT_TEXT: { abroadDeclined: CONSENT_TEXT.abroadDeclined } }).length, 'ответ на отказ — без полей');
  assert.match(CONSENT_TEXT.intro, /два согласия/);
});

// Разборы dec5ea1: отказ на 6В и прежняя логика отказов.
test('«Да» на 6Б → «Не сейчас» на 6В → /start → «Нет» на возрасте: «отметки удалены» и удаление метрик', async () => {
  const t = bot();
  await t.toAbroad(); await t.press('abroad', 'no');
  await t.say('/start'); await t.press('age', 'no');
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.ageDeleted, 'согласие 6Б было — сообщаем об удалении');
  assert.equal(t.forgot(), 1);
});

test('«Да» на 6Б → /start прямо на экране 6В → «Нет» на возрасте: «отметки удалены»', async () => {
  const t = bot();
  await t.toAbroad(); await t.say('/start'); await t.press('age', 'no');
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.ageDeleted);
});

test('полное согласие → /start → «Не сейчас» на 6В: метрики не удаляются; затем /start → «Нет» на возрасте — удаляются', async () => {
  const t = bot();
  await t.toAbroad(); await t.press('abroad', 'yes');
  await t.say('/start');
  await t.press('age', 'yes'); await t.press('intro', 'next'); await t.press('pd', 'yes'); await t.press('abroad', 'no');
  assert.equal(t.forgot(), 0, 'отказ от передачи — не отзыв согласия на обработку');
  const events = t.events.length;
  await t.say('Утром убежал кофе.');
  assert.equal(t.events.length, events, 'после отказа на 6В метрики не пишутся');
  await t.say('/start'); await t.press('age', 'no');
  assert.deepEqual(t.texts().slice(-2), [CONSENT_TEXT.ageDeclined, CONSENT_TEXT.ageDeleted]);
  assert.equal(t.forgot(), 1);
});
