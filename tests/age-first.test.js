// Решение Дмитрия 24.11 (А8), комплект v2.7, § 2.1: первым — вопрос о возрасте (6Г), затем 6А «Как устроены „Титры“»,
// затем согласие на обработку данных (6Б). «Нет» на возрасте не открывает 6А и 6Б.
// Настоящий createBot без заданного порядка. Только вымышленные данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../server/bot.js';
import { CONSENT_TEXT, CONSENT_VERSION } from '../server/consent.js';

function bot() {
  const sent = []; let forgot = 0; const events = [];
  const tg = { send: async (c, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => {} };
  const metrics = { hash: () => 'qa-fictional', log: async (c, e) => { events.push(e); }, forget: async () => { forgot++; } };
  const b = createBot({ tg, metrics, safetyCheck: async () => false, checkRetryMs: 0, draft: async () => ({ episode: null }), render: async () => ({}) });
  const chat = { id: 93001, type: 'private' };
  const cycle = () => b.sessions.get(chat.id).consent.cycle;
  const press = (step, a) => b.handleUpdate({ callback_query: { id: 'q', data: `cs:${step}:${a}:${cycle()}`, message: { chat } } });
  const buttons = () => sent.at(-1).extra?.reply_markup?.inline_keyboard?.flat().map((k) => k.callback_data.split(':').slice(1, 3).join(':'));
  const consent = async () => { await say('/start'); await press('age', 'yes'); await press('intro', 'next'); await press('pd', 'yes'); };
  const say = (text) => b.handleUpdate({ message: { chat, text } });
  return { b, sent, events, press, buttons, say, consent, texts: () => sent.map((m) => m.text), forgot: () => forgot, step: () => b.sessions.get(chat.id).consent.step };
}

test('первым — вопрос о возрасте; «Да» → 6А → 6Б → 6Ж', async () => {
  const t = bot();
  await t.say('/start');
  assert.deepEqual(t.texts(), [CONSENT_TEXT.age], 'на /start — только вопрос о возрасте');
  assert.deepEqual(t.buttons(), ['age:yes', 'age:no']);
  await t.press('intro', 'next'); await t.press('pd', 'yes'); // кнопки чужих шагов ничего не делают
  assert.equal(t.step(), 'age');
  await t.press('age', 'yes');
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.intro, 'затем 6А');
  assert.deepEqual(t.buttons(), ['intro:next']);
  await t.press('intro', 'next');
  assert.deepEqual(t.buttons(), ['pd:yes', 'pd:no'], 'затем 6Б');
  await t.press('pd', 'yes');
  assert.equal(t.step(), 'done');
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.ready);
});

test('рассказ до подтверждений: 6З и вопрос о возрасте (не 6А)', async () => {
  const t = bot();
  await t.say('Вымышленный рассказ: утром убежал кофе.');
  assert.deepEqual(t.texts(), [CONSENT_TEXT.notYet, CONSENT_TEXT.age]);
});

test('«Нет» на возрасте при первом прохождении — только ответ об отказе; 6А и 6Б не открываются; метрик нет', async () => {
  const t = bot();
  await t.say('/start');
  const n = t.sent.length;
  await t.press('age', 'no');
  assert.equal(t.step(), 'declined');
  assert.deepEqual(t.texts().slice(n), [CONSENT_TEXT.ageDeclined]);
  await t.press('intro', 'next'); await t.press('pd', 'yes');
  assert.equal(t.step(), 'declined', '6А и 6Б после отказа не открываются');
  assert.deepEqual(t.events, []);
});

test('согласие было → /start → «Нет» на возрасте: «отметки удалены»; ещё /start → «Нет»: только отказ (QA PR 34)', async () => {
  const t = bot();
  await t.consent();
  assert.equal(t.step(), 'done');
  await t.say('/start');
  let n = t.sent.length;
  await t.press('age', 'no');
  assert.deepEqual(t.texts().slice(n), [CONSENT_TEXT.ageDeclined, CONSENT_TEXT.ageDeleted], 'первый отзыв после согласия');
  await t.say('/start');
  n = t.sent.length;
  await t.press('age', 'no');
  assert.deepEqual(t.texts().slice(n), [CONSENT_TEXT.ageDeclined], 'повторный отказ до нового согласия — без «отметки удалены»');
});

test('согласие было → /start → «Нет» на 6Б → /start → «Нет» на возрасте: только отказ (QA PR 34)', async () => {
  const t = bot();
  await t.consent();
  await t.say('/start'); await t.press('age', 'yes'); await t.press('intro', 'next');
  let n = t.sent.length;
  await t.press('pd', 'no');
  assert.deepEqual(t.texts().slice(n), [CONSENT_TEXT.pdDeclined]);
  await t.say('/start');
  n = t.sent.length;
  await t.press('age', 'no');
  assert.deepEqual(t.texts().slice(n), [CONSENT_TEXT.ageDeclined], 'отзыв уже был на 6Б — без «отметки удалены»');
});

test('6А называет следующий шаг так, как он идёт; версия текста помечена А8', () => {
  assert.match(CONSENT_TEXT.intro, /Дальше — согласие\./);
  assert.match(CONSENT_TEXT.intro, /Подробно — на следующем шаге\./);
  assert.match(CONSENT_VERSION, /А8/);
});

test('на шаге 6А (второй экран) рассказ, голосовое и подпись не обрабатываются; модель не вызывается', async () => {
  let drafts = 0; let stt = 0; const sent = [];
  const tg = { send: async (c, text) => { sent.push(text); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from('ogg'), sendVideo: async () => {} };
  const b = createBot({ tg, metrics: { hash: () => 'x', log: async () => {}, forget: async () => {} }, safetyCheck: async () => false, checkRetryMs: 0,
    transcribe: async () => { stt++; return 'Вымышленный рассказ.'; }, draft: async () => { drafts++; return { episode: null }; }, render: async () => ({}) });
  const chat = { id: 93003, type: 'private' };
  await b.handleUpdate({ message: { chat, text: '/start' } });
  await b.handleUpdate({ callback_query: { id: 'q', data: `cs:age:yes:${b.sessions.get(93003).consent.cycle}`, message: { chat } } });
  assert.equal(b.sessions.get(93003).consent.step, 'intro');
  await b.handleUpdate({ message: { chat, text: 'Вымышленный рассказ: утром убежал кофе, днём искали ключи.' } });
  await b.handleUpdate({ message: { chat, voice: { file_id: 'f', duration: 5 } } });
  await b.handleUpdate({ message: { chat, photo: [{ file_id: 'p' }], caption: 'Вымышленная подпись к фото про вечер.' } });
  assert.deepEqual({ drafts, stt }, { drafts: 0, stt: 0 });
  assert.ok(!b.sessions.get(93003).story);
  assert.ok(sent.includes(CONSENT_TEXT.notYet), '6З');
});

test('отзыв: «Нет» на возрасте после согласия удаляет метрики (как /delete)', async () => {
  const t = bot();
  await t.consent();
  await t.say('/start'); await t.press('age', 'no');
  assert.equal(t.forgot(), 1);
});

test('/year при порядке по умолчанию: вопрос о возрасте, затем 6А и 6Б; после — 6Ж, период года', async () => {
  const t = bot();
  await t.say('/year');
  assert.deepEqual(t.texts(), [CONSENT_TEXT.age]);
  await t.press('age', 'yes'); await t.press('intro', 'next'); await t.press('pd', 'yes');
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.ready);
  assert.equal(t.b.sessions.get(93001).period, 'year');
});
