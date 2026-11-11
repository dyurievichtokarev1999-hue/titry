// Короткий текст (меньше 12 знаков) и «/текст» — решение Claude 11.11 15:05 п. 1 (PR 15). Только вымышленные фразы.
//  1) локальный фильтр ≠ none → путь рассказа (остановка и помощь), без «подробнее»;
//  2) none → отдельная модельная проверка до ответа: опасно → остановка; безопасно → «подробнее»;
//     неизвестно (сбой, нет ключа, пауза) → без «подробнее»: текст неизвестного исхода и контакты помощи;
//  3) «/текст»: неизвестная команда — путь рассказа; у известной команды с хвостом проверяется хвост.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot, TEXT } from '../server/bot.js';
import { assessRisk, helpContacts, helpMessage } from '../server/safety.js';
import { makeDraft } from '../server/draft.js';

const chat = { id: 77501, type: 'private' };
const MORE = /Расскажи чуть подробнее/;
const HELP = /помощ|112|телефон доверия|8-800/i;
const URGENT_CARD = /Сейчас важнее не титры/;

function setup({ check = () => false, hasKey } = {}) {
  const sent = []; const counters = { draft: 0, render: 0, check: 0 };
  const tg = { send: async (c, text) => { sent.push(text); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => {} };
  const metrics = { hash: () => 'fictional', log: async () => {}, forget: async () => {} };
  const bot = createBot({
    tg, metrics,
    draft: async (st, o) => { counters.draft++; return makeDraft(st, { ...o, provider: 'manual' }); }, // настоящий путь остановки, без модели
    safetyCheck: async (t) => { counters.check++; return check(t, counters.check); },
    ...(hasKey ? { hasKey } : {}),
    render: async () => { counters.render++; return { seconds: 1, duration: 24 }; },
  });
  return { sent, counters, say: (text) => bot.handleUpdate({ message: { chat, text } }), all: () => sent.join('\n') };
}

for (const text of ['Убить себя', 'Убью брата', 'Прибью мужа', 'Я его убью']) {
  test(`путь 1: короткий текст с признаками опасности «${text}» → помощь, без «подробнее»`, async () => {
    assert.ok(text.length < 12);
    assert.notEqual(assessRisk(text).level, 'none');
    const b = setup();
    await b.say(text);
    assert.doesNotMatch(b.all(), MORE);
    assert.match(b.all(), HELP);
    assert.equal(b.counters.render, 0);
  });
}

test('путь 2а: короткий текст без признаков, модель — безопасно → «подробнее», черновика нет', async () => {
  for (const text of ['Устала', 'Пила чай', 'Привет']) {
    const b = setup();
    await b.say(text);
    assert.match(b.sent.at(-1), MORE, text);
    assert.equal(b.counters.check, 1, `${text}: модельная проверка до ответа`);
    assert.equal(b.counters.draft, 0);
  }
});

test('путь 2б: короткий текст без признаков, модель — опасно → остановка; повтор — снова остановка без проверки', async () => {
  const b = setup({ check: () => true });
  await b.say('Сдохну');
  assert.match(b.sent.at(-1), URGENT_CARD);
  assert.doesNotMatch(b.all(), MORE);
  await b.say('Сдохну');
  assert.match(b.sent.at(-1), URGENT_CARD);
  assert.equal(b.counters.check, 1, 'запрет держится без повторной проверки');
  assert.equal(b.counters.render, 0);
});

const unknownTail = `${TEXT.checkUnavailable}\n\n${helpContacts()}`;
test('путь 2в: проверка не завершена (сбой) → текст неизвестного исхода и контакты, без «подробнее»; паузы для слова нет', async () => {
  let fail = true;
  const b = setup({ check: () => { if (fail) throw Object.assign(new Error('сбой'), { code: 'incomplete_response' }); return false; } });
  for (let i = 0; i < 3; i++) {
    await b.say('Привет');
    assert.equal(b.sent.at(-1), unknownTail, `сбой ${i + 1}: неизвестный исход, без технической паузы`);
  }
  assert.doesNotMatch(b.all(), MORE);
  assert.doesNotMatch(b.sent.at(-1), /похоже|заметил/i, 'без «мы заметили» и «похоже»');
  fail = false; // модель снова отвечает — короткое слово не закрыто навсегда
  await b.say('Привет');
  assert.match(b.sent.at(-1), MORE);
});

test('путь 2г: модель недоступна (нет ключа) → текст неизвестного исхода и контакты, проверка не вызывается', async () => {
  const b = setup({ hasKey: () => false });
  await b.say('Пила чай');
  assert.equal(b.sent.at(-1), unknownTail);
  assert.equal(b.counters.check, 0);
  assert.doesNotMatch(b.all(), MORE);
});

test('«/текст»: неизвестная команда — путь рассказа; известная команда с хвостом — проверяется хвост', async () => {
  for (const text of ['/хочу умереть', '/start Убить себя', '/year Убью брата', '/Не хочу жить']) {
    const b = setup();
    await b.say(text);
    assert.match(b.all(), HELP, text);
    assert.doesNotMatch(b.all(), MORE, text);
  }
  const m = setup({ check: () => true });
  await m.say('/сдохну');
  assert.match(m.sent.at(-1), URGENT_CARD, 'короткий хвост — модельная проверка');
  const k = setup();
  await k.say('/start');
  assert.equal(k.sent.at(-1), TEXT.start, 'известная команда без хвоста — как прежде');
  const k2 = setup();
  await k2.say('/start@titry_bot');
  assert.equal(k2.sent.at(-1), TEXT.start);
});

test('однословные формы самоповреждения — urgent (узкое «б»); «Сдохну» — не в словаре, уходит на модель', () => {
  for (const t of ['Порежусь', 'Отравлюсь', 'Удавлюсь', 'Утоплюсь', 'Застрелюсь', 'Вскроюсь', 'Убьюсь', 'Самоубьюсь', 'Выпилюсь', 'Наглотаюсь', 'Не жить мне', 'Мне не жить', 'УБЬЮСЬ.', 'вскроюсь']) {
    assert.equal(assessRisk(t).level, 'urgent', t);
  }
  for (const t of ['Сдохну', 'Порезалась', 'Устала', 'Режу хлеб', 'Убилась на работе']) assert.notEqual(assessRisk(t).level, 'urgent', t);
  assert.ok(helpMessage('urgent').includes(helpContacts().split('\n\n')[1]), 'контакты те же, что на экране остановки');
});

test('«/START», «//текст», «/cmd» с переводом строки, «/start_x …»', async () => {
  const k = setup();
  await k.say('/START');
  assert.equal(k.sent.at(-1), TEXT.start);
  for (const text of ['//порежусь', '/start\nхочу умереть', '/help\nубьюсь', '/start_x убьюсь', '/ хочу умереть']) {
    const b = setup();
    await b.say(text);
    assert.match(b.all(), URGENT_CARD, JSON.stringify(text));
    assert.doesNotMatch(b.all(), MORE, JSON.stringify(text));
  }
});

test('безопасный короткий текст не трогает показанный черновик; опасный — уничтожает', async () => {
  const story = 'Утром я пила чай на кухне. Вечером я читала книгу у окна.';
  const b = setup();
  await b.say(story);
  const bot = b; // черновик показан
  const before = b.sent.length;
  await bot.say('Привет');
  assert.match(b.sent.at(-1), MORE);
  // Правка после «подробнее» работает: черновик на месте.
  await bot.say('название: Вечер у окна');
  assert.ok(b.sent.length > before + 1);
  assert.doesNotMatch(b.sent.at(-1), /Нет черновика|Сначала/);
  const d = setup({ check: (t) => t === 'Сдохну' });
  await d.say(story);
  await d.say('Сдохну');
  assert.match(d.sent.at(-1), URGENT_CARD);
  // Запрет — на короткий текст, а не на прежний безобидный рассказ.
  await d.say(story);
  assert.doesNotMatch(d.sent.at(-1), URGENT_CARD, 'прежний рассказ не попал в запрет');
});

test('/delete во время проверки короткого текста: в чат ничего не уходит; повтор — остановка', async () => {
  let release;
  const b = setup({ check: (t) => (t === 'Сдохну' ? new Promise((r) => { release = r; }) : false) });
  const p = b.say('Сдохну');
  await new Promise((r) => setImmediate(r));
  await b.say('/delete');
  const n = b.sent.length;
  release(true);
  await p;
  assert.equal(b.sent.length, n, 'удалённая сессия не получает ответ проверки');
  await b.say('Сдохну');
  assert.match(b.sent.at(-1), URGENT_CARD, 'запрет участника остался после /delete');
});

test('журнал и метрики короткого пути — без текста', async () => {
  const out = []; const events = [];
  const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...a) => out.push(a.map(String).join(' '));
  try {
    for (const check of [() => true, () => { throw Object.assign(new Error('сбой Сдохну'), { code: 'incomplete_response' }); }]) {
      const tg = { send: async () => {}, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => {} };
      const metrics = { hash: () => 'f', log: async (id, ev, extra = {}) => { events.push({ ev, ...extra }); }, forget: async () => {} };
      const bot = createBot({ tg, metrics, safetyCheck: async (t) => check(t), render: async () => ({}) });
      await bot.handleUpdate({ message: { chat, text: 'Сдохну' } });
    }
  } finally { Object.assign(console, saved); }
  const all = `${out.join('\n')}\n${JSON.stringify(events)}`.toLowerCase();
  assert.ok(!all.includes('сдохну'), all);
  assert.ok(events.some((e) => e.ev === 'safety' && e.at === 'short' && e.byModel === true));
});
