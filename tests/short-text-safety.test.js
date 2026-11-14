// Короткий текст (меньше 12 знаков) и «/текст» — PR 15 с решением владельца кода 13.11 15:00. Только вымышленные фразы.
//  1) локальный фильтр ≠ none → путь рассказа (остановка и помощь), без «подробнее»;
//  2) none → «Расскажи чуть подробнее» без модельной проверки (модельная проверка одна — перед рендером);
//  3) «/текст»: неизвестная команда — путь рассказа; у известной команды с хвостом проверяется хвост.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot, TEXT } from '../server/bot.js';
import { assessRisk, helpMessage } from '../server/safety.js';
import { makeDraft } from '../server/draft.js';

const chat = { id: 77501, type: 'private' };
const MORE = /Расскажи чуть подробнее/;
const HELP = /помощ|112|телефон доверия|8-800/i;
const URGENT_CARD = /Для этого рассказа ролика не будет/;

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

test('путь 2: короткий текст без признаков → «подробнее» без модельной проверки, черновика нет', async () => {
  for (const text of ['Устала', 'Пила чай', 'Привет', 'Сдохну']) {
    const b = setup();
    await b.say(text);
    assert.match(b.sent.at(-1), MORE, text);
    assert.equal(b.counters.check, 0, `${text}: модельной проверки коротких текстов нет`);
    assert.equal(b.counters.draft, 0);
  }
});

// Удалены (решение 13.11 15:00): «модель — опасно → остановка» для короткого текста, «проверка не завершена →
// текст неизвестного исхода» и «нет ключа → текст неизвестного исхода» — модельной проверки коротких текстов нет.
test('нет ключа: «Привет» → «подробнее», без «проверка не завершилась»', async () => {
  const b = setup({ hasKey: () => false });
  await b.say('Привет');
  assert.match(b.sent.at(-1), MORE);
  assert.doesNotMatch(b.all(), /не завершил|не завершилась/);
  assert.equal(b.counters.check, 0);
});

test('«/текст»: неизвестная команда — путь рассказа; известная команда с хвостом — проверяется хвост', async () => {
  for (const text of ['/хочу умереть', '/start Убить себя', '/year Убью брата', '/Не хочу жить']) {
    const b = setup();
    await b.say(text);
    assert.match(b.all(), HELP, text);
    assert.doesNotMatch(b.all(), MORE, text);
  }
  const m = setup({ check: () => true });
  await m.say('/порежусь');
  assert.match(m.sent.at(-1), URGENT_CARD, 'короткий хвост — локальный фильтр');
  assert.equal(m.counters.check, 0);
  const k = setup();
  await k.say('/start');
  assert.equal(k.sent.at(-1), TEXT.start, 'известная команда без хвоста — как прежде');
  const k2 = setup();
  await k2.say('/start@titry_bot');
  assert.equal(k2.sent.at(-1), TEXT.start);
});

test('однословные формы самоповреждения — urgent (узкое «б»); «Сдохну» — не в словаре', () => {
  for (const t of ['Порежусь', 'Отравлюсь', 'Удавлюсь', 'Утоплюсь', 'Застрелюсь', 'Вскроюсь', 'Убьюсь', 'Самоубьюсь', 'Выпилюсь', 'Наглотаюсь', 'Не жить мне', 'УБЬЮСЬ.', 'вскроюсь']) {
    assert.equal(assessRisk(t).level, 'urgent', t);
  }
  for (const t of ['Сдохну', 'Мне не жить в Москве, переезжаю', 'Порезалась', 'Устала', 'Режу хлеб', 'Убилась на работе']) assert.notEqual(assessRisk(t).level, 'urgent', t);
  assert.match(helpMessage('urgent'), /112/, 'на экране остановки — 112');
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
  const d = setup();
  await d.say(story);
  await d.say('Порежусь');
  assert.match(d.sent.at(-1), URGENT_CARD);
  // Запрет — на короткий текст, а не на прежний безобидный рассказ.
  await d.say(story);
  assert.doesNotMatch(d.sent.at(-1), URGENT_CARD, 'прежний рассказ не попал в запрет');
});

// Удалён «/delete во время проверки короткого текста»: модельной проверки коротких текстов нет.

test('журнал и метрики короткого пути — без текста', async () => {
  const out = []; const events = [];
  const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...a) => out.push(a.map(String).join(' '));
  try {
    for (const text of ['Порежусь', 'Сдохну']) {
      const tg = { send: async () => {}, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => {} };
      const metrics = { hash: () => 'f', log: async (id, ev, extra = {}) => { events.push({ ev, ...extra }); }, forget: async () => {} };
      const bot = createBot({ tg, metrics, safetyCheck: async () => false, draft: (st, o) => makeDraft(st, { ...o, provider: 'manual' }), render: async () => ({}) });
      await bot.handleUpdate({ message: { chat, text } });
    }
  } finally { Object.assign(console, saved); }
  const all = `${out.join('\n')}\n${JSON.stringify(events)}`.toLowerCase();
  assert.ok(!all.includes('сдохну') && !all.includes('порежусь'), all);
  assert.ok(events.some((e) => e.ev === 'safety'));
});

test('«мне не жить» (решение 16:05): urgent в конце фразы и рядом с «больше/дальше/так/без …»; о месте и о совместной жизни — нет', () => {
  for (const t of ['Мне не жить', 'Мне не жить.', 'Мне не жить больше', 'мне больше не жить', 'Мне так не жить', 'Мне не жить дальше', 'Без неё мне не жить', 'Всё, мне не жить, хватит', 'Мне не жить\nВсё', 'Мне не жить\r\nвсё', 'Мне не жить — всё кончено', 'мне не жить: всё', 'Мне не жить» — сказала себе', 'МНЕ НЕ ЖИТЬ...', 'Мне уже не жить', 'мне теперь не жить.', 'Мне не жить без неё', 'Мне не жить без кофе']) {
    assert.equal(assessRisk(t).level, 'urgent', t);
  }
  for (const t of ['Мне не жить в Москве, переезжаю', 'Мне уже не жить в Москве', 'Мне не жить на юге', 'Мне не жить с ним под одной крышей', 'Мне с ним не жить', 'Мне не жить там, где холодно']) {
    assert.notEqual(assessRisk(t).level, 'urgent', t);
  }
});
