// Один отклик на ролик (решение Claude 24.11; QA PR 35 на 9319ab0): метрики «Попадание» и «Вред» считаются по роликам.
// Под каждым роликом пишется первый ответ, а «Стало тяжелее» — ещё раз, если первым был другой. Ответ и блок помощи —
// при каждом нажатии. Номер ролика — случайный, один и тот же в метриках render и feedback; отклик принимается только
// на доставленный ролик. Настоящий createBot; подтверждения проходит хелпер. Только вымышленные данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBot, passConsent } from './helpers/consent.js';
import { TEXT } from '../server/bot.js';
import { helpMessage } from '../server/safety.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));

function setup({ cancelFirst = false, sendGate, failFeedback = 0 } = {}) {
  const sent = []; const log = []; const offered = [];
  let calls = 0;
  const tg = { send: async (c, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''),
    sendVideo: async (c, f, extra, o = {}) => {
      offered.push(extra); // кнопки, которые были бы под роликом
      if (cancelFirst && calls++ === 0) return null; // отмена прямо перед отправкой (ready() вернул false)
      if (o.ready && !(await o.ready())) return null;
      await sendGate; // загрузка идёт: Telegram уже показал ролик, ответа ещё нет
      sent.push({ video: true, extra }); return {};
    } };
  const metrics = { hash: () => 'qa-fictional', forget: async () => {},
    log: async (c, e, x) => {
      if (e === 'feedback' && failFeedback > 0) { failFeedback--; throw Object.assign(new Error('диск'), { code: 'ENOSPC' }); }
      if (e === 'feedback' || e === 'render') log.push({ e, ...x });
    } };
  const bot = createBot({ tg, metrics, safetyCheck: async () => false, checkRetryMs: 0,
    draft: async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }),
    render: async (e, o) => ({ seconds: 1, duration: 24, outPath: o.outPath }) });
  const chat = { id: 94001, type: 'private' };
  const say = (text) => bot.handleUpdate({ message: { chat, text } });
  const click = (data) => bot.handleUpdate({ callback_query: { id: 'q', data, message: { chat } } });
  const keys = (extra) => Object.fromEntries(extra.reply_markup.inline_keyboard[0].map((k) => [k.callback_data.split(':')[1], k.callback_data]));
  const video = async () => {
    await say(ex.story);
    await click(`play:${bot.sessions.get(chat.id).draftId}`);
    return keys(offered.at(-1));
  };
  // Начать доставку, не дожидаясь её конца: кнопки — как только запрос ушёл.
  const startVideo = async () => {
    await say(ex.story);
    const done = click(`play:${bot.sessions.get(chat.id).draftId}`);
    for (let i = 0; i < 200 && offered.length === 0; i++) await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); // ready() отработал
    return { k: keys(offered.at(-1)), done };
  };
  const fb = () => log.filter((r) => r.e === 'feedback');
  return { bot, sent, log, fb, say, click, video, startVideo };
}

test('один отклик на ролик: повторные нажатия под тем же роликом в метрики не пишутся, ответ — каждый раз', async () => {
  const t = setup();
  const k1 = await t.video();
  for (const v of ['fit', 'fit', 'miss', 'heavier']) {
    const n = t.sent.length;
    await t.click(k1[v]);
    assert.equal(t.sent[n].text, { fit: TEXT.fit, miss: TEXT.miss, heavier: TEXT.heavier }[v], `${v}: ответ есть`);
  }
  assert.equal(t.sent.at(-1).text, helpMessage('concern'), '«Стало тяжелее» — блок помощи и при повторе');
  assert.deepEqual(t.fb().map((r) => r.value), ['fit', 'heavier'], 'под первым роликом: первый ответ и «Стало тяжелее» (сигнал вреда не теряется); повторы не пишутся');
  const k2 = await t.video();
  assert.notEqual(k2.miss, k1.miss, 'у второго ролика свой номер в кнопках');
  await t.click(k2.miss); await t.click(k2.miss);
  await t.click(k1.heavier); // снова кнопка первого ролика
  assert.deepEqual(t.fb().map((r) => r.value), ['fit', 'heavier', 'miss'], 'второй ролик — свой один отклик; первый — без новых');
});

test('сквозной: два ролика одного участника — по записям оба сигнала связаны с первым роликом, второй отдельно', async () => {
  const t = setup();
  const k1 = await t.video();
  await t.click(k1.fit); await t.click(k1.heavier);
  const k2 = await t.video();
  await t.click(k2.miss);
  // Только сохранённые записи: render и feedback с номером ролика.
  const renders = t.log.filter((r) => r.e === 'render').map((r) => r.video);
  assert.equal(renders.length, 2);
  assert.match(renders[0], /^[0-9a-f]{16}$/, 'наружу — только случайная часть');
  assert.notEqual(renders[0], renders[1], 'у роликов разные номера');
  const byVideo = (id) => t.fb().filter((r) => r.video === id).map((r) => r.value);
  assert.deepEqual(byVideo(renders[0]), ['fit', 'heavier'], 'первый ролик: отклик и сигнал вреда');
  assert.deepEqual(byVideo(renders[1]), ['miss'], 'второй ролик: свой отклик');
  assert.equal(k1.fit.split(':')[3], renders[0], 'номер в кнопках — тот же, что в метрике render');
  for (const r of t.log) assert.deepEqual(Object.keys(r).filter((k) => !['e', 'value', 'video', 'seconds', 'mood', 'music', 'edits'].includes(k)), [], 'без лишних полей');
});

test('отменённая доставка: номер её ролика для метрик недопустим; доставленный следующий — допустим', async () => {
  const t = setup({ cancelFirst: true });
  const k1 = await t.video(); // отменён перед отправкой: ролика нет
  assert.ok(!t.sent.some((m) => m.video), 'ролик не отправлен');
  assert.equal(t.log.filter((r) => r.e === 'render').length, 0, 'метрики render нет');
  for (const v of ['fit', 'heavier']) await t.click(k1[v]);
  assert.deepEqual(t.fb(), [], 'отклик под недоставленным роликом не пишется');
  const k2 = await t.video();
  await t.click(k2.fit);
  assert.deepEqual(t.fb().map((r) => [r.value, r.video]), [['fit', k2.fit.split(':')[3]]], 'доставленный ролик — отклик пишется');
});

test('кнопка с номером ролика, которого не было, или без номера — в метрики не пишется, ответ прежний', async () => {
  const t = setup();
  const k = await t.video();
  const cycle = k.fit.split(':')[2];
  for (const data of [`fb:fit:${cycle}:ffffffff`, `fb:fit:${cycle}:1`, `fb:fit:${cycle}:`, `fb:fit:${cycle}`, `fb:fit:${cycle}:__proto__`]) {
    const n = t.sent.length;
    await t.click(data);
    assert.equal(t.sent[n].text, TEXT.fit, `${data}: ответ есть`);
  }
  assert.deepEqual(t.fb(), [], 'метрик нет');
});

test('нажатие до ответа Telegram на отправку (запрос уже ушёл) — отклик записывается', async () => {
  let release; const sendGate = new Promise((r) => { release = r; });
  const t = setup({ sendGate });
  const { k, done } = await t.startVideo();
  await t.click(k.heavier);
  release(); await done;
  assert.deepEqual(t.fb().map((r) => r.value), ['heavier'], '«Стало тяжелее» во время отправки не теряется');
  assert.equal(t.fb()[0].video, k.heavier.split(':')[3]);
});

test('сбой записи отклика — ответ не считается записанным, повтор записывает', async () => {
  const t = setup({ failFeedback: 1 });
  const k = await t.video();
  await t.click(k.heavier); // запись упала (ENOSPC)
  assert.deepEqual(t.fb(), []);
  assert.equal(t.sent.at(-1).text, helpMessage('concern'), 'помощь показана и при сбое записи');
  await t.click(k.heavier);
  assert.deepEqual(t.fb().map((r) => r.value), ['heavier'], 'сигнал вреда записан со второго нажатия');
});

test('подделанная кнопка: номер ролика прошлого согласия с текущим циклом — в метрики не пишется, помощь есть', async () => {
  const t = setup();
  const k = await t.video();
  await t.say('/start'); // новое прохождение согласия — та же сессия, номер старого ролика в ней остаётся
  await passConsent(t.bot.handleUpdate, { id: 94001, type: 'private' }, { begin: false, sessions: () => t.bot.sessions });
  const cycle = t.bot.sessions.get(94001).consent.cycle;
  assert.equal(t.bot.sessions.get(94001).consent.step, 'done', 'новое согласие дано');
  assert.notEqual(cycle, k.heavier.split(':')[2], 'цикл сменился');
  const n = t.sent.length;
  await t.click(`fb:heavier:${cycle}:${k.heavier.split(':')[3]}`);
  assert.deepEqual(t.fb(), [], 'отклик на ролик прошлого согласия не пишется');
  assert.equal(t.sent.at(-1).text, helpMessage('concern'));
  assert.ok(t.sent.length > n);
});

// QA PR 35 на d64c0e0: Telegram показал ролик, но ответ на отправку потерялся — у отклика есть ровно одна парная запись render.
test('ответ Telegram на отправку потерялся, отклик пришёл — одна запись render перед откликом; подтверждённая отправка — без дубля', async () => {
  const sent = []; const log = []; const offered = [];
  let lose = true;
  const tg = { send: async (c, text) => { sent.push({ text }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''),
    sendVideo: async (c, f, extra, o = {}) => { offered.push(extra); if (o.ready && !(await o.ready())) return null; if (lose) throw Object.assign(new Error('ответ потерян'), { code: 'timeout' }); return {}; } };
  const metrics = { hash: () => 'qa-fictional', log: async (c, e, x) => { if (e === 'feedback' || e === 'render') log.push({ e, ...x }); }, forget: async () => {} };
  const bot = createBot({ tg, metrics, safetyCheck: async () => false, checkRetryMs: 0,
    draft: async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }),
    render: async (e, o) => ({ seconds: 1, duration: 24, outPath: o.outPath }) });
  const chat = { id: 94002, type: 'private' };
  const click = (data) => bot.handleUpdate({ callback_query: { id: 'q', data, message: { chat } } });
  const keys = () => Object.fromEntries(offered.at(-1).reply_markup.inline_keyboard[0].map((k) => [k.callback_data.split(':')[1], k.callback_data]));
  await bot.handleUpdate({ message: { chat, text: ex.story } });
  await click(`play:${bot.sessions.get(chat.id).draftId}`);
  assert.equal(log.filter((r) => r.e === 'render').length, 0, 'подтверждения нет — render пока нет');
  const k = keys();
  await click(k.fit); await click(k.heavier);
  const id = k.fit.split(':')[3];
  assert.deepEqual(log.map((r) => `${r.e}:${r.value || ''}:${r.video}`), [`render::${id}`, `feedback:fit:${id}`, `feedback:heavier:${id}`]);
  assert.equal(log[0].restored, true, 'render восстановлен по отклику — помечен (не для расчёта задержек)');
  assert.equal(sent.at(-1).text, helpMessage('concern'), 'блок помощи');
  lose = false; // подтверждённая отправка, затем отклик — render один
  await bot.handleUpdate({ message: { chat, text: ex.story } });
  await click(`play:${bot.sessions.get(chat.id).draftId}`);
  const k2 = keys();
  await click(k2.miss);
  const id2 = k2.miss.split(':')[3];
  assert.equal(log.filter((r) => r.e === 'render' && r.video === id2).length, 1);
  assert.equal(log.find((r) => r.e === 'render' && r.video === id2).restored, undefined, 'подтверждённый render не помечен');
});

// Разборы 8bf68b4: render — ровно один и раньше откликов; сбой render не оставляет отклик без пары; цикл доставки.
test('нажатие до ответа Telegram, потом подтверждение; два быстрых нажатия — один render, раньше откликов', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const t = setup({ sendGate: gate });
  const { k, done } = await t.startVideo();
  const a = t.click(k.fit); const b = t.click(k.heavier);
  release(); await done; await a; await b;
  const id = k.fit.split(':')[3];
  const rows = t.log.filter((r) => r.video === id).map((r) => r.e);
  assert.deepEqual(rows, ['render', 'feedback', 'feedback'], 'render один и первым');
});

test('сбой записи render при отклике — отклик не записан; повторное нажатие пишет обе записи', async () => {
  let fail = 1;
  const log = []; const offered = [];
  const tg = { send: async () => {}, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''),
    sendVideo: async (c, f, extra, o = {}) => { offered.push(extra); if (o.ready && !(await o.ready())) return null; throw Object.assign(new Error('ответ потерян'), { code: 'timeout' }); } };
  const metrics = { hash: () => 'qa-fictional', forget: async () => {},
    log: async (c, e, x) => { if (e === 'render' && fail-- > 0) throw Object.assign(new Error('диск'), { code: 'ENOSPC' }); if (e === 'feedback' || e === 'render') log.push(e); } };
  const bot = createBot({ tg, metrics, safetyCheck: async () => false, checkRetryMs: 0,
    draft: async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }),
    render: async (e, o) => ({ seconds: 1, duration: 24, outPath: o.outPath }) });
  const chat = { id: 94003, type: 'private' };
  const click = (data) => bot.handleUpdate({ callback_query: { id: 'q', data, message: { chat } } });
  await bot.handleUpdate({ message: { chat, text: ex.story } });
  await click(`play:${bot.sessions.get(chat.id).draftId}`);
  const heavier = offered.at(-1).reply_markup.inline_keyboard[0].find((x) => x.callback_data.startsWith('fb:heavier')).callback_data;
  await click(heavier);
  assert.deepEqual(log, [], 'render не записался — и отклика нет');
  await click(heavier);
  assert.deepEqual(log, ['render', 'feedback']);
});

// QA PR 35 на 1eb3f77: совпадение случайного номера двух роликов одного участника.
// QA PR 35 на 1eb3f77 и 67f3133: номер не повторяется, даже если генератор выдаёт одно и то же; наружу — только случайная часть.
function constBot(chatId) {
  const log = []; const offered = [];
  const tg = { send: async () => {}, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''),
    sendVideo: async (c, f, extra, o = {}) => { offered.push(extra); if (o.ready && !(await o.ready())) return null; return {}; } };
  const metrics = { hash: () => 'qa-fictional', forget: async () => {}, log: async (c, e, x) => { if (e === 'feedback' || e === 'render') log.push({ e, v: x.value || '', video: x.video }); } };
  const bot = createBot({ tg, metrics, safetyCheck: async () => false, checkRetryMs: 0, newVideoId: () => 'aaaaaaaaaaaaaaaa', // всегда одно и то же
    draft: async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }),
    render: async (e, o) => ({ seconds: 1, duration: 24, outPath: o.outPath }) });
  const chat = { id: chatId, type: 'private' };
  const click = (data) => bot.handleUpdate({ callback_query: { id: 'q', data, message: { chat } } });
  const play = async () => { await bot.handleUpdate({ message: { chat, text: ex.story } }); await click(`play:${bot.sessions.get(chat.id).draftId}`); return offered.at(-1).reply_markup.inline_keyboard[0][0].callback_data; };
  const pairs = (video) => log.filter((r) => r.video === video).map((r) => r.e);
  const lastKeys = () => offered.at(-1).reply_markup.inline_keyboard[0].map((k) => k.callback_data);
  return { bot, chat, log, click, play, pairs, lastKeys };
}

test('генератор всегда выдаёт одно и то же — номера роликов различаются (16 hex); у каждого отклика свой render, раньше отклика', async () => {
  const t = constBot(94004);
  const fit1 = await t.play(); const fit2 = await t.play();
  const [v1, v2] = [fit1.split(':')[3], fit2.split(':')[3]];
  assert.notEqual(v1, v2, 'номера различаются');
  for (const k of t.lastKeys()) assert.ok(Buffer.byteLength(k) <= 64, `callback_data в пределе Telegram: ${k}`);
  await t.click(fit1); await t.click(fit2);
  assert.deepEqual(t.pairs(v1), ['render', 'feedback']);
  assert.deepEqual(t.pairs(v2), ['render', 'feedback']);
});

test('регрессия QA: сессия истекла между доставками, случайная часть совпала — у свежего отклика ровно один более ранний render', async () => {
  const t = constBot(94005);
  const fitA = await t.play();
  t.bot.sessions.get(t.chat.id).touched = Date.now() - 4 * 60 * 60 * 1000; // четыре часа без действий
  t.bot.sweep();
  assert.ok(!t.bot.sessions.has(t.chat.id), 'сессия удалена');
  await passConsent(t.bot.handleUpdate, t.chat, { sessions: () => t.bot.sessions });
  const fitB = await t.play();
  const vB = fitB.split(':')[3];
  assert.notEqual(fitA.split(':')[3], vB);
  await t.click(fitB);
  assert.deepEqual(t.pairs(vB), ['render', 'feedback'], 'ровно один render раньше отклика');
});

test('регрессия QA: кнопка ролика, вытесненного из последних 20, при совпавшей случайной части не пишет отклик', async () => {
  const t = constBot(94006);
  const first = await t.play();
  for (let i = 0; i < 21; i++) await t.play();
  const ids = t.log.filter((r) => r.e === 'render').map((r) => r.video);
  assert.equal(new Set(ids).size, 22, 'все номера различаются');
  const before = t.log.filter((r) => r.e === 'feedback').length;
  await t.click(first); // вытеснен
  assert.equal(t.log.filter((r) => r.e === 'feedback').length, before, 'число откликов прежнее');
});
