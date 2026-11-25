// Экраны согласия 6А–6З (комплект для юриста v2, пакет согласия v8, 2.1–2.2) и приём рассказа до подтверждений:
// критерии QA «Приём рассказа до подтверждений» 1–3. Настоящий createBot (без хелпера подтверждений); подмены со
// счётчиками: скачивание голосового, SpeechKit, модель (черновик и проверка), метрика story, рендер. Синтетические данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBot, TEXT, splitForTelegram, TELEGRAM_TEXT_LIMIT, makeMetrics } from '../server/bot.js';
import os from 'node:os';
import path from 'node:path';
import { CONSENT_TEXT, consentSteps } from '../server/consent.js';
import { helpMessage } from '../server/safety.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const ORDERS = [['pd', 'age'], ['age', 'pd']];
const INVITES = [CONSENT_TEXT.ready, TEXT.year];
const STORY = ex.story;

function setup(order, { draftGate, renderGate, unsafe, sendGate, botName, onForget, check, sendVideoGate, hold, transcribeGate, transcript = STORY, actionGate, downloadGate, fetchGate } = {}) {
  const sent = [];
  const n = { download: 0, stt: 0, draft: 0, check: 0, story: 0, render: 0, video: 0 };
  let fetched = 0;
  const tg = {
    send: async (c, text, extra) => { sent.push({ text, extra }); if (sendGate) await sendGate(text); }, action: async () => { await actionGate; }, answer: async () => {},
    // Как адаптер Telegram: getFile (download, может ждать), затем ready(), затем запрос байтов (fetched).
    fileBuffer: async (id, o = {}) => { n.download++; await downloadGate; if (o.ready && !(await o.ready())) return null; fetched++; await fetchGate; return Buffer.from('ogg'); },
    sendVideo: async (c, f, extra, o = {}) => { if (hold?.video) await hold.video; if (o.ready && !(await o.ready())) return null; n.video++; },
  };
  const events = [];
  const extras = [];
  const metrics = { hash: () => 'qa-fictional', log: async (c, event, extra) => { events.push(event); extras.push(extra); if (event === 'story') n.story++; if (hold?.[event]) await hold[event]; }, forget: async () => { if (onForget) onForget(); } };
  const bot = createBot({
    tg, metrics, consentOrder: order, botName,
    transcribe: async () => { n.stt++; await transcribeGate; return transcript; },
    draft: async () => { n.draft++; await draftGate; if (unsafe) return { episode: null, risk: { level: 'urgent', byModel: true } }; return { episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }; },
    safetyCheck: async (t) => { n.check++; return check ? check(t) : false; },
    checkRetryMs: 0,
    render: async (e, o) => { n.render++; await renderGate; return { seconds: 1, duration: 24, outPath: o.outPath }; },
  });
  const chat = { id: 88001, type: 'private' };
  const say = (text) => bot.handleUpdate({ message: { chat, text } });
  // Кнопки согласия привязаны к прохождению: «cs:шаг:ответ» дополняется меткой текущего цикла, как на экране.
  const cs = (data) => (/^cs:[a-z]+:[a-z]+$/.test(data) ? `${data}:${bot.sessions.get(chat.id)?.consent?.cycle}` : data);
  const press = (data) => bot.handleUpdate({ callback_query: { id: 'q', data: cs(data), message: { chat } } });
  const voice = () => bot.handleUpdate({ message: { chat, voice: { file_id: 'f1', duration: 5 } } });
  const voiceCaption = () => bot.handleUpdate({ message: { chat, voice: { file_id: 'f2', duration: 5 }, caption: STORY } });
  const photoCaption = () => bot.handleUpdate({ message: { chat, photo: [{ file_id: 'p1' }], caption: STORY } });
  const s = () => bot.sessions.get(chat.id);
  return { bot, sent, n, events, extras, say, press, voice, voiceCaption, photoCaption, s, texts: () => sent.map((m) => m.text), fetched: () => fetched };
}

// Все входящие с рассказом: текст, голосовое, голосовое с подписью, фото с подписью — ничего не обрабатывается.
async function sendAllKinds(b) {
  await b.say(STORY); await b.voice(); await b.voiceCaption(); await b.photoCaption();
}
function assertNothingProcessed(b, label) {
  assert.deepEqual(b.n, { download: 0, stt: 0, draft: 0, check: 0, story: 0, render: 0, video: 0 }, `счётчики: ${label}`);
  const s = b.s();
  assert.ok(!s.story && !s.originalStory && !s.episode, `содержание рассказа не в сессии: ${label}`);
  for (const t of b.texts()) assert.ok(!INVITES.includes(t), `нет приглашения рассказать раньше 6Ж: ${label}`);
}


for (const order of ORDERS) {
  const tag = order.join('→');
  const pressTo = async (b, step) => {
    await b.press('cs:intro:next');
    for (const st of order) { if (st === step) return; await b.press(`cs:${st}:yes`); }
  };

  test(`[${tag}] первый вход /start, /year и без команды; незавершённый диалог на каждом шаге — рассказ не принимается`, async () => {
    for (const entry of ['/start', '/year', null]) {
      for (const step of ['intro', ...order]) {
        const b = setup(order);
        if (entry) await b.say(entry); else await b.say('привет');
        if (!entry) assert.deepEqual(b.texts(), [CONSENT_TEXT.notYet, CONSENT_TEXT.intro], 'без команды — 6З и 6А');
        else assert.equal(b.texts()[0], CONSENT_TEXT.intro, `${entry} → 6А`);
        if (step !== 'intro') await pressTo(b, step);
        assert.equal(b.s().consent.step, step);
        const before = b.sent.length;
        await sendAllKinds(b);
        const after = b.texts().slice(before);
        assertNothingProcessed(b, `${entry || 'без команды'} / ${step}`);
        // 6З не чаще раза на шаг (без команды 6З уже был на шаге 6А).
        const expected = !entry && step === 'intro' ? [] : [CONSENT_TEXT.notYet];
        assert.deepEqual(after, expected, `ответ в рамках шага: ${entry} / ${step}`);
      }
    }
  });

  test(`[${tag}] отказ на каждом обязательном шаге: ничего не обрабатывается, бот молчит; отметки по ветке`, async () => {
    for (const refuse of order) {
      const b = setup(order);
      await b.say('/start');
      await pressTo(b, refuse);
      const hadPd = order.indexOf('pd') < order.indexOf(refuse);
      await b.press(`cs:${refuse}:no`);
      const last = b.texts().slice(-2);
      if (refuse === 'pd') assert.equal(b.texts().at(-1), CONSENT_TEXT.pdDeclined);
      else {
        // 6Г «Нет»: первое сообщение всегда; второе — по факту удаления, только если отметка о согласии была.
        if (hadPd) assert.deepEqual(last, [CONSENT_TEXT.ageDeclined, CONSENT_TEXT.ageDeleted]);
        else assert.equal(b.texts().at(-1), CONSENT_TEXT.ageDeclined);
        assert.ok(!b.texts().includes(CONSENT_TEXT.ageDeleted) || hadPd);
      }
      assert.deepEqual(b.s().consent.given, {}, 'после отказа отметок о согласии нет');
      assert.equal(b.s().consent.step, 'declined');
      const before = b.sent.length;
      await sendAllKinds(b);
      for (const o of order) await b.press(`cs:${o}:yes`); // устаревшие кнопки после отказа не засчитываются
      assert.equal(b.sent.length, before, 'после отказа бот не отвечает и не напоминает');
      assertNothingProcessed(b, `отказ ${refuse}`);
      // Повторный /start — снова с 6А, прежние нажатия не засчитываются.
      await b.say('/start');
      assert.equal(b.texts().at(-1), CONSENT_TEXT.intro);
      assert.deepEqual(b.s().consent.given, {});
    }
  });

  test(`[${tag}] после всех подтверждений — 6Ж, и обычный рассказ даёт ровно один черновик`, async () => {
    const b = setup(order);
    await b.say('/start');
    await pressTo(b, 'done');
    assert.equal(b.texts().filter((t) => t === CONSENT_TEXT.ready).length, 1, '6Ж — один раз, в конце');
    assert.equal(b.texts().at(-1), CONSENT_TEXT.ready);
    assert.equal(b.s().consent.given.pd.version.includes('v8'), true, 'отметка: версия текста и время — в памяти сессии');
    await b.say(STORY);
    assert.equal(b.n.draft, 1, 'один черновик');
    assert.equal(b.n.story, 1);
    assert.deepEqual([b.n.download, b.n.stt, b.n.render], [0, 0, 0]);
  });
}

test('порядок экранов: по умолчанию как в комплекте (6Б, затем 6Г); TITRY_CONSENT_ORDER=age_first — возраст первым', () => {
  assert.deepEqual(consentSteps({}), ['pd', 'age']);
  assert.deepEqual(consentSteps({ TITRY_CONSENT_ORDER: 'age_first' }), ['age', 'pd']);
});

test('/year без подтверждений — 6А; после подтверждений — 6Ж (решение Claude, п. 5), период года сохранён; голос расшифровывается', async () => {
  const b = setup(['pd', 'age']);
  await b.say('/year');
  assert.equal(b.texts()[0], CONSENT_TEXT.intro);
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(d);
  assert.equal(b.texts().at(-1), CONSENT_TEXT.ready);
  assert.equal(b.s().period, 'year');
  await b.voice();
  assert.equal(b.n.download, 1); assert.equal(b.n.stt, 1); assert.equal(b.n.draft, 1);
});

test('6Б — частями в пределах лимита Telegram, кнопки под последней частью; текст — без потерь', async () => {
  const parts = splitForTelegram(CONSENT_TEXT.pd);
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= TELEGRAM_TEXT_LIMIT));
  assert.equal(parts.join('\n\n'), CONSENT_TEXT.pd);
  const b = setup(['pd', 'age']);
  await b.say('/start'); await b.press('cs:intro:next');
  const shown = b.sent.slice(1);
  assert.equal(shown.map((m) => m.text).join('\n\n'), CONSENT_TEXT.pd);
  assert.ok(shown.at(-1).extra.reply_markup, 'кнопки — под последней частью');
  assert.ok(shown.slice(0, -1).every((m) => !m.extra), 'остальные части без кнопок');
});

test('исправленное сообщение до подтверждений: в рассказ не попадает; явная опасность — экран остановки (п. 6)', async () => {
  const b = setup(['pd', 'age']);
  await b.say('/start');
  await b.bot.handleUpdate({ edited_message: { chat: { id: 88001, type: 'private' }, text: 'Утром пила чай.' } });
  await b.bot.handleUpdate({ edited_message: { chat: { id: 88001, type: 'private' }, text: 'Не хочу жить.' } });
  assert.ok(!b.s().story);
  assert.deepEqual(b.texts(), [CONSENT_TEXT.intro, helpMessage('urgent')]);
});

// Решение Claude 18.11, п. 6: до подтверждений явная опасность — экран остановки с 112, только локальный фильтр.
test('опасное сообщение до подтверждений — экран остановки с 112; модель, сохранение и метрики не вызываются (п. 6)', async () => {
  for (const order of ORDERS) {
    const b = setup(order);
    await b.say('Не хочу жить.'); // без начатого диалога
    assert.equal(b.texts().at(-1), helpMessage('urgent'));
    assert.match(b.texts().at(-1), /112/);
    await b.say('/start');
    await b.press('cs:intro:next');
    await b.say('Не хочу жить.'); // на шаге 6Б/6Г — снова экран, а не 6З
    assert.equal(b.texts().at(-1), helpMessage('urgent'));
    await b.photoCaption(); // безопасная подпись — 6З, как раньше
    assert.equal(b.texts().at(-1), CONSENT_TEXT.notYet);
    await b.bot.handleUpdate({ message: { chat: { id: 88001, type: 'private' }, voice: { file_id: 'f3', duration: 5 }, caption: 'Не хочу жить.' } });
    assert.equal(b.texts().at(-1), helpMessage('urgent'), 'подпись к голосовому — тоже текст');
    await b.press(`cs:${order[0]}:no`);
    await b.say('Не хочу жить.'); // после отказа бот молчит, но не на опасность
    assert.equal(b.texts().at(-1), helpMessage('urgent'));
    assert.deepEqual({ ...b.n }, { download: 0, stt: 0, draft: 0, check: 0, story: 0, render: 0, video: 0 });
    assert.ok(!b.s().story && !b.s().blocked, 'текст и запрет в сессию не пишутся');
    assert.deepEqual(b.events, [], 'до подтверждений метрик нет: ни /start, ни опасных сообщений (проверка перед запуском, п. 3)');
  }
});

test('«Нет» на 6Г после повторного /start: рассказ и черновик удалены из памяти сессии (п. 7)', async () => {
  const b = setup(['pd', 'age']);
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(d);
  await b.say(STORY);
  assert.ok(b.s().story && b.s().episode);
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:no']) await b.press(d);
  for (const k of ['story', 'originalStory', 'episode', 'skeleton', 'overflow']) assert.ok(!b.s()[k], k);
});

test('черновик, начатый до повторного /start, не появляется после нового 6Ж (п. 8)', async () => {
  let release;
  const b = setup(['pd', 'age'], { draftGate: new Promise((r) => { release = r; }) });
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(d);
  const pending = b.say(STORY);
  await new Promise((r) => setImmediate(r));
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(d);
  release();
  await pending;
  assert.equal(b.texts().at(-1), CONSENT_TEXT.ready, 'после 6Ж черновик не показан');
  assert.ok(!b.sent.some((m) => m.extra?.reply_markup?.inline_keyboard?.flat().some((k) => /^play:/.test(k.callback_data))));
  assert.ok(!b.s().story && !b.s().episode);
  assert.equal(b.n.story, 0);
});

test('/delete стирает отметку о согласии вместе с сессией: рассказ снова не принимается', async () => {
  const b = setup(['pd', 'age']);
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(d);
  await b.say('/delete');
  await b.say(STORY);
  assert.equal(b.n.draft, 0);
  assert.deepEqual(b.texts().slice(-2), [CONSENT_TEXT.notYet, CONSENT_TEXT.intro]);
});

test('черновик, который готовился до повторного /start и отказа на 6Г, не показывается и не ставит рендер (разбор, п. 1)', async () => {
  let release;
  const b = setup(['pd', 'age'], { draftGate: new Promise((r) => { release = r; }) });
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(d);
  const pending = b.say(STORY); // рассказ принят после подтверждений, черновик ещё у модели
  await new Promise((r) => setImmediate(r));
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:no']) await b.press(d);
  release();
  await pending;
  for (let id = 0; id <= 3; id++) { await b.press(`play:${id}`); await b.press(`mood:${id}`); await b.press(`music:${id}`); }
  assert.equal(b.n.draft, 1);
  assert.equal(b.n.render, 0, 'рендер не поставлен');
  assert.equal(b.n.story, 0, 'метрика story не записана');
  assert.equal(b.s().consent.step, 'declined');
  assert.ok(!b.sent.some((m) => m.extra?.reply_markup?.inline_keyboard?.flat().some((k) => /^play:/.test(k.callback_data))), 'черновик не показан');
  assert.ok(!b.texts().includes(TEXT.noDraft), 'старые кнопки не приглашают рассказать (разбор, п. 2)');
});

test('/start во время подготовки ролика: согласие сброшено, но сообщения проверяются, как прежде — «Сдохну» отменяет ролик', async () => {
  let release;
  const b = setup(['pd', 'age'], { renderGate: new Promise((r) => { release = r; }) });
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(d);
  await b.say(STORY);
  const id = b.s().draftId;
  const playing = b.press(`play:${id}`);
  try {
    for (let i = 0; i < 200 && !(b.n.render === 1 && b.s().delivering); i++) await new Promise((r) => setImmediate(r));
    assert.ok(b.s().delivering, 'доставка идёт');
    await b.say('/start');
    assert.notEqual(b.s().consent.step, 'done');
    const q = b.say('Сдохну'); // локально urgent (решение 16.11): ролик отменяется
    for (let i = 0; i < 200 && !b.texts().some((t) => /112/.test(String(t))); i++) await new Promise((r) => setImmediate(r));
    release();
    await q;
  } finally { release(); await playing; }
  assert.equal(b.n.video, 0, 'ролик не отправлен');
  assert.ok(b.texts().some((t) => /112/.test(String(t))), 'экран остановки с 112');
});

// Разбор правок пп. 5–8: сброс во время доставки ролика — после её конца; опасный сброшенный черновик — экран остановки.
const ticks = async (k = 50) => { for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r)); };
async function delivering(b) {
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(d);
  await b.say(STORY);
  const id = b.s().draftId;
  const p = b.press(`play:${id}`); await ticks();
  assert.ok(b.s().delivering, 'ролик готовится');
  return { id, p };
}

test('«Нет» на 6Г во время доставки ролика: рассказ и черновик стираются после доставки (п. 7)', async () => {
  let release;
  const b = setup(['pd', 'age'], { renderGate: new Promise((r) => { release = r; }) });
  const { p } = await delivering(b);
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:no']) await b.press(d);
  release(); await p; await ticks();
  for (const k of ['story', 'originalStory', 'episode']) assert.ok(!b.s()[k], k);
});

test('повторные подтверждения во время доставки: старый черновик после неё не работает (п. 8)', async () => {
  let release;
  const b = setup(['pd', 'age'], { renderGate: new Promise((r) => { release = r; }) });
  const { id, p } = await delivering(b);
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(d);
  release(); await p; await ticks();
  const renders = b.n.render;
  for (const d of [`play:${id}`, `mood:${id}`, `music:${id}`]) await b.press(d);
  await ticks();
  assert.equal(b.n.render, renders, 'старая ▶ не рендерит');
  assert.ok(!b.s().episode && !b.s().story);
});

test('черновик опасен по модели, во время ожидания — /start (и второй сброс): экран остановки и запрет — всё равно (п. 8)', async () => {
  const after = [['/start'], ['/start', '/start'], ['/start', 'cs:intro:next', 'cs:pd:no']];
  for (const steps of after) {
    let release;
    const b = setup(['pd', 'age'], { draftGate: new Promise((r) => { release = r; }), unsafe: true });
    await b.say('/start');
    for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(d);
    const p = b.say(STORY); await ticks(5);
    for (const x of steps) await (x.startsWith('/') ? b.say(x) : b.press(x));
    release(); await p; await ticks();
    assert.equal(b.texts().at(-1), helpMessage('urgent'), steps.join(' → '));
    assert.ok(b.s().blocked?.size, 'рассказ запомнен как запрещённый');
  }
});

test('/start во время доставки: старые кнопки черновика до новых подтверждений ничего не запускают', { timeout: 5000 }, async () => {
  let release;
  const b = setup(['pd', 'age'], { renderGate: new Promise((r) => { release = r; }) });
  const { id, p } = await delivering(b);
  await b.say('/start');
  b.s().stage = 'draft'; // окно, когда проверка сообщения вернула стадию черновика (duringRender)
  const renders = b.n.render;
  await b.press(`play:${id}`); await ticks();
  assert.equal(b.n.render, renders, 'вторая доставка не началась');
  release(); await p;
});

// Критик реализации 18.11 21:40: кнопка с экрана прежнего прохождения не засчитывается в новом.
test('кнопки 6Б и 6Г прежнего прохождения после /start ничего не меняют; кнопки нового экрана работают (оба порядка)', async () => {
  for (const order of ORDERS) {
    for (const answer of ['yes', 'no']) {
      const b = setup(order);
      await b.say('/start');
      const buttons = () => b.sent.flatMap((m) => m.extra?.reply_markup?.inline_keyboard?.flat() || []).map((k) => k.callback_data);
      for (const st of ['intro:next', `${order[0]}:yes`]) await b.press(`cs:${st}`);
      const old = buttons().filter((d) => /^cs:(pd|age):/.test(d)); // кнопки первого прохождения
      await b.say('/start');
      for (const st of ['intro:next', `${order[0]}:yes`]) await b.press(`cs:${st}`); // новый цикл на том же шаге
      const before = structuredClone(b.s().consent);
      const sentBefore = b.sent.length;
      for (const d of old.filter((x) => x.includes(`:${answer}:`))) {
        await b.bot.handleUpdate({ callback_query: { id: 'q', data: d, message: { chat: { id: 88001, type: 'private' } } } });
      }
      assert.deepEqual(b.s().consent, before, `${order} ${answer}: состояние и отметки не изменились`);
      assert.equal(b.sent.length, sentBefore, 'ни 6Ж, ни ответа на отказ');
      await b.press(`cs:${order[1]}:yes`);
      assert.equal(b.texts().at(-1), CONSENT_TEXT.ready, 'кнопка нового экрана работает');
    }
  }
});

test('/start, пока отправляется первая часть 6Б: кнопки старого 6Б несут метку прежнего прохождения и не засчитываются', async () => {
  const [first, ...rest] = splitForTelegram(CONSENT_TEXT.pd);
  let hold; let held = false;
  const gate = new Promise((r) => { hold = r; });
  const b = setup(['pd', 'age'], { sendGate: (text) => (text === first && !held ? (held = true, gate) : undefined) });
  await b.say('/start');
  const pd = b.press('cs:intro:next'); // первая часть 6Б «отправляется»
  await ticks(5);
  await b.say('/start'); // новый цикл до того, как ушли кнопки старого 6Б
  hold(); await pd;
  const oldPd = b.sent.find((m) => m.text === rest.at(-1)).extra.reply_markup.inline_keyboard.flat().map((k) => k.callback_data);
  await b.press('cs:intro:next'); // новый цикл дошёл до 6Б
  const before = structuredClone(b.s().consent);
  for (const d of oldPd) await b.bot.handleUpdate({ callback_query: { id: 'q', data: d, message: { chat: { id: 88001, type: 'private' } } } });
  assert.deepEqual(b.s().consent, before, 'кнопка старого 6Б не засчитана');
});

// Решение Claude 19.11 (справка к комплекту v2.2): отзыв согласия во время подготовки — ролик не уходит.
test('отзыв согласия во время рендера (/start, «Нет» на 6Б, «Нет» на 6Г, повторные «Да»): ролик не отправляется, рассказ стёрт', async () => {
  for (const after of [['/start'], ['/start', 'cs:intro:next', 'cs:pd:no'], ['/start', 'cs:intro:next', 'cs:pd:yes', 'cs:age:no'], ['/start', 'cs:intro:next', 'cs:pd:yes', 'cs:age:yes']]) {
    let release;
    const b = setup(['pd', 'age'], { renderGate: new Promise((r) => { release = r; }) });
    const { p } = await delivering(b);
    for (const x of after) await (x.startsWith('/') ? b.say(x) : b.press(x));
    release(); await p; await ticks();
    assert.equal(b.n.render, 1, after.join(' → '));
    assert.equal(b.n.video, 0, `ролик не отправлен: ${after.join(' → ')}`);
    for (const k of ['story', 'originalStory', 'episode']) assert.ok(!b.s()[k], `${k}: ${after.join(' → ')}`);
  }
});

test('отзыв согласия во время доставки (рендер готов, ролик ждёт проверки сообщения окна): ролик не отправляется', async () => {
  let releaseRender; let releaseCheck;
  const renderGate = new Promise((r) => { releaseRender = r; });
  const held = new Promise((r) => { releaseCheck = r; });
  const LATE = 'Вечером ещё долго смотрела в окно на дождь.';
  // Модельная проверка сообщения, пришедшего во время подготовки, задерживает доставку готового ролика.
  const b = setup(['pd', 'age'], { renderGate, check: async (t) => (t.includes(LATE) ? held.then(() => false) : false) });
  const { p } = await delivering(b);
  const late = b.say(LATE); await ticks(); // сообщение окна: доставка ждёт его проверки
  releaseRender(); await ticks();
  assert.equal(b.n.video, 0, 'ролик ещё ждёт проверки');
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:no']) await b.press(d);
  releaseCheck(); await late; await p; await ticks(100);
  assert.equal(b.n.render, 1);
  assert.equal(b.n.video, 0, 'ролик не отправлен');
  assert.ok(!b.s().story && !b.s().episode);
});

function setupNamed(botName) {
  let forgot = 0;
  const b = setup(['pd', 'age'], { botName, onForget: () => { forgot++; } });
  return { ...b, forgot: () => forgot };
}

// Решение Claude 19.11: одна нормализация команд — регистр не важен, «@имя_бота» отрезается только для своего бота.
test('команды: «/DELETE» и «/delete@бот» удаляют, «/Start@бот» — 6А; «/команда@другой_бот» — не команда; «/» и «//» — без ответа', async () => {
  for (const cmd of ['/DELETE', '/delete@TitryBot', '/Delete@titrybot']) {
    const b = setupNamed('TitryBot');
    await b.say('/start');
    for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(d);
    assert.ok(b.s(), 'сессия есть');
    await b.say(cmd);
    assert.equal(b.s(), undefined, `${cmd}: сессия удалена`);
    assert.equal(b.forgot(), 1, `${cmd}: статистика удалена`);
  }
  const s = setupNamed('TitryBot');
  await s.say('/Start@TitryBot');
  assert.equal(s.texts().at(-1), CONSENT_TEXT.intro);
  const o = setupNamed('TitryBot');
  await o.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await o.press(d);
  await o.say('/delete@OtherBot');
  assert.ok(o.s(), '«/delete@другой_бот» не удаляет');
  for (const t of ['/', '//']) {
    const e = setupNamed('TitryBot');
    await e.say('/start');
    for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await e.press(d);
    const before = e.sent.length;
    await e.say(t);
    assert.equal(e.sent.length, before, `«${t}» — без ответа`);
  }
});

// Разбор PR (code-review high, ponytail-review): после отзыва согласия во время подготовки сообщения идут по правилам
// до 6Ж — без «Собираю ролик», без скачивания и распознавания голоса; старая ▶ не запускает проверку и рендер.
test('после отзыва во время подготовки: «ок» и голос — не «Собираю ролик», голос не скачивается; старая ▶ — без проверки и рендера', async () => {
  let release;
  const b = setup(['pd', 'age'], { renderGate: new Promise((r) => { release = r; }) });
  const { id, p } = await delivering(b);
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:no']) await b.press(d);
  const before = b.sent.length;
  await b.say('ок');
  await b.voice();
  assert.ok(!b.texts().slice(before).includes(TEXT.rendering), 'нет «Собираю ролик»');
  assert.equal(b.n.download + b.n.stt, 0, 'голос не скачан и не распознан');
  release(); await p; await ticks();
  const c = setup(['pd', 'age'], { renderGate: new Promise((r) => { release = r; }) });
  const d = await delivering(c);
  await c.say('/start');
  for (const x of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await c.press(x);
  const checks = c.n.check;
  await c.press(`play:${d.id}`); await ticks();
  assert.equal(c.n.check, checks, 'старая ▶ не отправляет рассказ на проверку');
  release(); await d.p; await ticks();
  assert.equal(c.n.render, 1);
  assert.equal(c.n.video, 0);
  void id;
});

test('новый рассказ после повторных подтверждений во время обречённой доставки не стирается по её окончании', async () => {
  let release;
  const b = setup(['pd', 'age'], { renderGate: new Promise((r) => { release = r; }) });
  const { p } = await delivering(b);
  await b.say('/start');
  for (const x of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(x);
  await b.say(STORY); await ticks();
  assert.ok(b.s().episode, 'новый черновик показан');
  release(); await p; await ticks();
  assert.ok(b.s().story && b.s().episode, 'новый рассказ на месте после конца старой доставки');
  assert.equal(b.n.video, 0, 'старый ролик не ушёл');
});

test('«/delete@ДругойБот» — без ответа и не рассказ', async () => {
  const b = setupNamed('TitryBot');
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(d);
  const before = b.sent.length; const drafts = b.n.draft;
  await b.say('/delete@OtherBot');
  assert.equal(b.sent.length, before);
  assert.equal(b.n.draft, drafts);
  assert.ok(b.s());
});

test('команда другому боту с хвостом: хвост идёт по пути рассказа (проверка безопасности), не в тишину', async () => {
  // Модель здесь подменена: проверяем маршрут — хвост дошёл до черновика (там локальный фильтр и модель), ответ есть.
  for (const t of ['/start@OtherBot убьюсь', '/x@a\nубьюсь', '/start@OtherBot сегодня долго гуляла по парку']) {
    const b = setupNamed('TitryBot');
    await b.say('/start');
    for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(d);
    const drafts = b.n.draft; const before = b.sent.length;
    await b.say(t);
    assert.equal(b.n.draft, drafts + 1, t);
    assert.ok(b.sent.length > before, `есть ответ: ${t}`);
  }
});

// QA PR 27: гонки отмены — сброс согласия до записи метрики; перепроверка перед самой отправкой; правка после отказа.
test('/start во время доставки при зависшей записи метрики: согласие сброшено сразу, ролик не уходит', async () => {
  const hold = {};
  let releaseVideo; hold.video = new Promise((r) => { releaseVideo = r; }); // доставка ждёт у отправки
  const b = setup(['pd', 'age'], { hold });
  const { p } = await delivering(b);
  let releaseLog; hold.start = new Promise((r) => { releaseLog = r; });
  const start = b.say('/start'); await ticks(5); // запись метрики /start ещё не завершена
  assert.equal(b.s().consent.step, 'intro', 'согласие сброшено до записи метрики');
  releaseVideo(); await p; await ticks();
  assert.equal(b.n.video, 0, 'ролик не ушёл');
  releaseLog(); await start;
});

test('отзыв, пока файл ролика читается перед отправкой: запроса на отправку нет', async () => {
  const hold = {};
  let releaseVideo; hold.video = new Promise((r) => { releaseVideo = r; });
  const b = setup(['pd', 'age'], { hold });
  const { p } = await delivering(b); // рендер готов сразу; доставка ждёт «чтения файла» (hold.video)
  await ticks();
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:no']) await b.press(d);
  const ev = b.events.length;
  releaseVideo(); await p; await ticks();
  assert.equal(b.n.video, 0, 'после отзыва отправки нет');
  assert.ok(!b.events.slice(ev).includes('render'), 'метрики render нет');
});

test('правка сообщения с опасным текстом после отказа во время доставки: экран остановки, без записи текста и метрики', async () => {
  let release;
  const b = setup(['pd', 'age'], { renderGate: new Promise((r) => { release = r; }) });
  const { p } = await delivering(b);
  await b.say('/start');
  for (const d of ['cs:intro:next', 'cs:pd:no']) await b.press(d);
  const ev = b.events.length;
  await b.bot.handleUpdate({ edited_message: { chat: { id: 88001, type: 'private' }, text: 'Не хочу жить.' } });
  assert.equal(b.texts().at(-1), helpMessage('urgent'));
  assert.notEqual(b.s().story, 'Не хочу жить.', 'текст правки не записан в сессию');
  assert.deepEqual(b.events.slice(ev), [], 'метрика не записана');
  release(); await p; await ticks();
});

test('telegram().sendVideo: ready() после чтения файла вернул false — HTTP-запроса нет; true — запрос есть', async () => {
  const { telegram } = await import('../server/bot.js');
  const os = await import('node:os'); const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-sv-'));
  const file = path.join(dir, 'v.mp4'); await fs.writeFile(file, 'x');
  const orig = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return { json: async () => ({ ok: true, result: {} }) }; };
  try {
    const tg = telegram('dummy-not-a-token');
    assert.equal(await tg.sendVideo(1, file, {}, { ready: () => false }), null);
    assert.equal(calls, 0, 'запроса нет');
    await tg.sendVideo(1, file, {}, { ready: () => true });
    assert.equal(calls, 1, 'запрос есть');
    assert.equal(await tg.sendVideo(1, file, {}, { ready: async () => false }), null, 'асинхронный ready: false — запроса нет');
    assert.equal(calls, 1);
    await tg.sendVideo(1, file, {}, { ready: async () => true });
    assert.equal(calls, 2, 'асинхронный ready: true — запрос есть');
  } finally { globalThis.fetch = orig; await fs.rm(dir, { recursive: true, force: true }); }
});

// QA PR 27, повторная приёмка: проверка сообщения, зарегистрированная, пока читался файл, учитывается до отправки.
for (const [label, danger, video] of [['опасно — ролика и render нет', true, 0], ['безопасно — ролик уходит', false, 1]]) {
  test(`сообщение во время чтения файла ролика, проверка моделью: ${label}`, async () => {
    const hold = {};
    let releaseVideo; hold.video = new Promise((r) => { releaseVideo = r; });
    let releaseCheck; const checked = new Promise((r) => { releaseCheck = r; });
    const LATE = 'Вечером ещё долго смотрела в окно на дождь.';
    const b = setup(['pd', 'age'], { hold, check: async (t) => (t.includes(LATE) ? checked.then(() => danger) : false) });
    const { p } = await delivering(b); // рендер готов; доставка «читает файл» (hold.video)
    await ticks();
    const late = b.say(LATE); await ticks(); // новая проверка зарегистрирована во время чтения файла
    const ev = b.events.length;
    releaseVideo(); await ticks();
    assert.equal(b.n.video, 0, 'до итога проверки ролик не уходит');
    releaseCheck(); await late; await p; await ticks(50);
    assert.equal(b.n.video, video);
    assert.equal(b.events.slice(ev).includes('render'), video === 1);
  });
}

// Проверка перед запуском, п. 3: метрики пишутся только при действующем согласии текущей сессии —
// не до 6Ж, не после отказа или /start, не после /delete (в том числе от поздних кнопок старых сообщений).
const consentAll = async (b, order) => { await b.say('/start'); await b.press('cs:intro:next'); for (const o of order) await b.press(`cs:${o}:yes`); };

test('метрики до согласия: /start, /year, рассказ, кнопки отклика, отказ — ни одной записи', async () => {
  for (const order of ORDERS) {
    const b = setup(order);
    await b.press('fb:fit'); await b.say('/year'); await b.say('/start'); await b.say(STORY);
    await b.press('cs:intro:next'); await b.press('fb:heavier'); await b.press(`cs:${order[0]}:no`); await b.say('/year');
    assert.deepEqual(b.events, [], order.join('→'));
  }
});

test('метрики после /delete: поздняя кнопка отклика и новые сообщения новой записи не создают', async () => {
  const b = setup(['pd', 'age']);
  await consentAll(b, ['pd', 'age']);
  await b.say(STORY);
  await b.press(`play:${b.s().draftId}`);
  assert.equal(b.n.video, 1);
  assert.ok(b.events.includes('story') && b.events.includes('render'), 'после согласия метрики пишутся');
  const cycle = b.s().consent.cycle; // метка в кнопках отклика под роликом
  const vid = [...b.s().feedbackFor.keys()].at(-1); // номер доставленного ролика в кнопках
  await b.press(`fb:fit:${cycle}:${vid}`);
  assert.equal(b.events.at(-1), 'feedback');
  const before = b.events.length;
  await b.say('/delete');
  await b.press(`fb:heavier:${cycle}:${vid}`); // кнопка старого сообщения с роликом
  await b.say(STORY); await b.say('/year');
  assert.equal(b.events.length, before, 'после /delete записей нет');
  assert.ok(b.texts().includes(helpMessage('concern')), 'помощь по «тяжелее» показана и без записи');
  // Новое согласие: кнопка старого ролика (прежний цикл) по-прежнему не пишется; новый рассказ — пишется.
  await consentAll(b, ['pd', 'age']);
  await b.say(STORY); await b.press(`play:${b.s().draftId}`);
  const fresh = b.events.length;
  const vid2 = [...b.s().feedbackFor.keys()].at(-1);
  await b.press(`fb:fit:${cycle}:${vid2}`); // номер доставленного ролика допустим, цикл прежний
  assert.equal(b.events.length, fresh, 'старый ролик после нового согласия не пишется (проверка цикла)');
  // Подделанная кнопка: новый цикл и номер ролика, доставленного до /delete, — сессия новая, номера нет.
  await b.press(`fb:heavier:${b.s().consent.cycle}:${vid}`);
  assert.equal(b.events.length, fresh, 'старый ролик с новым циклом не пишется');
  assert.ok(b.events.length > before, 'при новом согласии метрики пишутся');
});

test('метрики после отзыва согласия (/start, «Нет»): поздние кнопки и сообщения не пишутся', async () => {
  for (const withdraw of ['start', 'no']) {
    const b = setup(['pd', 'age']);
    await consentAll(b, ['pd', 'age']);
    await b.say(STORY);
    const before = b.events.length;
    assert.ok(before > 0);
    await b.say('/start');
    if (withdraw === 'no') { await b.press('cs:intro:next'); await b.press('cs:pd:no'); }
    await b.press('fb:fit'); await b.say(STORY);
    assert.equal(b.events.length, before, withdraw);
  }
});

test('метрики: новое согласие во время старой доставки — метрики нового рассказа пишутся', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const b = setup(['pd', 'age'], { hold: { video: gate } });
  await consentAll(b, ['pd', 'age']);
  await b.say(STORY);
  const playing = b.press(`play:${b.s().draftId}`);
  for (let i = 0; i < 20 && !b.s().delivering; i++) await new Promise((r) => setImmediate(r));
  assert.ok(b.s().delivering, 'доставка идёт');
  await consentAll(b, ['pd', 'age']); // /start и подтверждения заново, пока ролик доставляется
  const before = b.events.length;
  await b.say(STORY);
  assert.ok(b.events.slice(before).includes('story'), 'рассказ при новом согласии записан');
  release(); await playing;
});

// Решение Claude 20.11: отзыв согласия («Нет» на 6Б/6Г после согласия) = удаление метрик, как /delete.
test('отзыв согласия «Нет» на 6Б и 6Г — метрики участника удаляются; ответы прежние; повторный /start без «Нет» не стирает', async () => {
  for (const order of ORDERS) for (const refuse of ['pd', 'age']) {
    let forgot = 0;
    const b = setup(order, { onForget: () => { forgot++; } });
    await consentAll(b, order);
    await b.say(STORY);
    assert.ok(b.events.length > 0);
    await b.say('/start');
    assert.equal(forgot, 0, '/start сам по себе не стирает');
    await b.press('cs:intro:next');
    for (const st of order) { if (st === refuse) break; await b.press(`cs:${st}:yes`); }
    await b.press(`cs:${refuse}:maybe`); // не «Нет»: ничего не происходит
    assert.equal(forgot, 0, 'иное значение кнопки — не отказ');
    const n = b.sent.length;
    await b.press(`cs:${refuse}:no`);
    assert.equal(forgot, 1, `«Нет» на ${refuse}: метрики удалены`);
    const hadPd = order.indexOf('pd') < order.indexOf(refuse);
    const expected = refuse === 'pd' ? [CONSENT_TEXT.pdDeclined] : [CONSENT_TEXT.ageDeclined, ...(hadPd ? [CONSENT_TEXT.ageDeleted] : [])];
    assert.deepEqual(b.texts().slice(n), expected, `ответы человеку прежние: ${order.join('→')}, «Нет» на ${refuse}`);
  }
});

test('отзыв согласия: удаление метрик не подтверждено — ответы прежние, затем честное сообщение; в журнале только код', async () => {
  const b = setup(['pd', 'age'], { onForget: () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } });
  await consentAll(b, ['pd', 'age']);
  await b.say('/start'); await b.press('cs:intro:next');
  const errs = []; const orig = console.error; console.error = (l) => errs.push(String(l));
  const n = b.sent.length;
  try { await b.press('cs:pd:no'); } finally { console.error = orig; }
  assert.deepEqual(b.texts().slice(n), [CONSENT_TEXT.pdDeclined, TEXT.withdrawForgetFailed]);
  // Текст редактора (ПРАВКА-ЗАПРОС 21.11) — литералом; «/delete» отдельным словом, без знаков препинания рядом.
  assert.equal(TEXT.withdrawForgetFailed, 'Пока не удалось подтвердить удаление твоей статистики. Чтобы повторить запрос, отправь /delete чуть позже.');
  assert.match(TEXT.withdrawForgetFailed, / \/delete /);
  assert.match(errs.join('\n'), /metrics\.forget\.withdraw/);
  assert.ok(!errs.join('\n').includes('88001'), 'идентификатора чата в журнале нет');
});

test('отзыв согласия: строки участника удалены из файла метрик, строки другого участника остаются', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-withdraw-'));
  try {
    const metrics = makeMetrics(path.join(dir, 'm.jsonl'), 'fictional-salt-0001');
    const sent = [];
    const tg = { send: async (c, text) => { sent.push(text); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => {} };
    const bot = createBot({ tg, metrics, consentOrder: ['pd', 'age'], safetyCheck: async () => false, checkRetryMs: 0,
      draft: async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }),
      render: async (e, o) => ({ seconds: 1, duration: 24, outPath: o.outPath }) });
    const run = async (id, steps) => {
      const chat = { id, type: 'private' };
      const press = (d) => bot.handleUpdate({ callback_query: { id: 'q', data: `${d}:${bot.sessions.get(id).consent.cycle}`, message: { chat } } });
      await bot.handleUpdate({ message: { chat, text: '/start' } });
      await press('cs:intro:next'); await press('cs:pd:yes'); await press('cs:age:yes');
      await bot.handleUpdate({ message: { chat, text: STORY } });
      for (const st of steps) await (st.startsWith('/') ? bot.handleUpdate({ message: { chat, text: st } }) : press(st));
    };
    await run(91001, []);
    await run(91002, []);
    const before = (await fs.readFile(path.join(dir, 'm.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(before.some((l) => l.user === metrics.hash(91002)), 'до отзыва строки участника есть');
    const chat = { id: 91002, type: 'private' };
    await bot.handleUpdate({ message: { chat, text: '/start' } });
    for (const d of ['cs:intro:next', 'cs:pd:no']) await bot.handleUpdate({ callback_query: { id: 'q', data: `${d}:${bot.sessions.get(91002).consent.cycle}`, message: { chat } } });
    const lines = (await fs.readFile(path.join(dir, 'm.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(lines.length > 0 && lines.every((l) => l.user === metrics.hash(91001)), 'остались только строки другого участника');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
// QA PR 31 (05d5aba): согласие проверяется и в очереди прямо перед записью; метрика старой доставки — только в её цикле.
function setupQueued(order, { sendVideo } = {}) {
  // Подмена очереди метрик: запись ждёт release, затем — как настоящая очередь — спрашивает allow() перед записью.
  const q = []; const written = [];
  const sent = [];
  const metrics = { hash: () => 'qa-fictional', forget: async () => {},
    log: (c, event, extra, o = {}) => new Promise((done) => q.push(() => { if (!o.allow || o.allow()) written.push(event); done(); })) };
  const tg = { send: async (c, text) => { sent.push(text); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''),
    sendVideo: sendVideo || (async (c, f, extra, o = {}) => { if (o.ready && !(await o.ready())) return null; }) };
  const bot = createBot({ tg, metrics, consentOrder: order, safetyCheck: async () => false, checkRetryMs: 0,
    draft: async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }),
    render: async (e, o) => ({ seconds: 1, duration: 24, outPath: o.outPath }) });
  const chat = { id: 88101, type: 'private' };
  const say = (text) => bot.handleUpdate({ message: { chat, text } });
  const press = (d) => bot.handleUpdate({ callback_query: { id: 'q', data: /^cs:/.test(d) ? `${d}:${bot.sessions.get(chat.id).consent.cycle}` : d, message: { chat } } });
  const flush = async () => { while (q.length) q.shift()(); await new Promise((r) => setImmediate(r)); };
  const consent = async () => { await say('/start'); await press('cs:intro:next'); for (const o of order) await press(`cs:${o}:yes`); };
  return { bot, chat, say, press, flush, consent, written, q, s: () => bot.sessions.get(chat.id) };
}
const tick = () => new Promise((r) => setImmediate(r));

// Выполнить действие бота, освобождая записи метрик, пока оно не завершится (записи ждут в очереди-подмене).
async function settle(b, p) {
  let done = false; p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 500 && !done; i++) { await b.flush(); }
  await p;
}

// «Нет» доступно только после /start, а /start уже сам меняет цикл: отдельного сценария для «Нет» нет.
test('метрики: /start, пришедший, пока запись ждала в очереди, её отменяет; запись действующего цикла проходит', async () => {
  const b = setupQueued(['pd', 'age']);
  await settle(b, b.consent());
  const story = b.say(STORY);
  for (let i = 0; i < 50 && !b.q.length; i++) await tick();
  assert.ok(b.q.length > 0, 'запись story ждёт в очереди');
  await b.say('/start'); // /start метрик не пишет и очередь не ждёт
  await settle(b, story);
  assert.deepEqual(b.written, [], 'ожидавшая запись не прошла');
  const c = setupQueued(['pd', 'age']);
  await settle(c, c.consent());
  await settle(c, c.say(STORY));
  assert.ok(c.written.includes('story'), 'без отзыва запись проходит');
});

test('метрики: render старой доставки не пишется в новом цикле согласия; новая доставка — одна запись render', async () => {
  const b = setupQueued(['pd', 'age']);
  await settle(b, b.consent());
  await settle(b, b.say(STORY));
  const n = b.written.length;
  const playing = b.press(`play:${b.s().draftId}`);
  // ждём, пока в очереди окажется запись render (ролик уже отправлен)
  for (let i = 0; i < 200; i++) { await tick(); if (b.q.length) break; }
  assert.ok(b.q.length > 0, 'запись render ждёт в очереди');
  await settle(b, b.consent()); // человек начинает заново и снова соглашается, пока запись ждала
  await settle(b, playing);
  assert.ok(!b.written.slice(n).includes('render'), 'render старой доставки не записан');
  await settle(b, b.say(STORY));
  await settle(b, b.press(`play:${b.s().draftId}`));
  assert.equal(b.written.filter((e) => e === 'render').length, 1, 'новая доставка — одна запись render');
});

test('очередь метрик: allow() проверяется прямо перед записью в файл', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-allow-'));
  try {
    const m = makeMetrics(path.join(dir, 'm.jsonl'), 'fictional-salt-0001');
    let ok = true;
    const a = m.log(1, 'story', {}, { allow: () => ok });
    ok = false; // отзыв, пока запись ждала (fs.mkdir, очередь)
    await a;
    await m.log(2, 'story', {}, { allow: () => true });
    const lines = (await fs.readFile(path.join(dir, 'm.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.user), [m.hash(2)]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// QA PR 31, п. 2: окно загрузки ролика. Отзыв проверен перед запросом, загрузка уже идёт; человек снова соглашается и
// присылает новый рассказ (draftId меняется, отложенный сброс больше не держит). Только цикл не пускает render старой доставки.
test('метрики: render ролика, загруженного до нового согласия и нового рассказа, не пишется в новом цикле', async () => {
  let release; const upload = new Promise((r) => { release = r; });
  const b = setupQueued(['pd', 'age'], { sendVideo: async (c, f, extra, o = {}) => { if (o.ready && !(await o.ready())) return null; await upload; return {}; } });
  await settle(b, b.consent());
  await settle(b, b.say(STORY));
  const playing = b.press(`play:${b.s().draftId}`);
  for (let i = 0; i < 200 && !b.s().delivering; i++) await tick();
  for (let i = 0; i < 50; i++) await tick(); // ready пройдена, загрузка ждёт
  await settle(b, b.consent());
  await settle(b, b.say(STORY)); // новый рассказ в новом цикле
  const before = b.written.length;
  release();
  await settle(b, playing);
  assert.ok(!b.written.slice(before).includes('render'), 'render старой доставки не записан');
});

test('метрики: поздняя остановка по рассказу прежнего цикла не пишется в новом цикле; экран помощи показан', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const b = setup(['pd', 'age'], { draftGate: gate, unsafe: true });
  await consentAll(b, ['pd', 'age']);
  const story = b.say(STORY);
  for (let i = 0; i < 50; i++) await tick();
  await consentAll(b, ['pd', 'age']); // новый цикл, пока модель думала
  const before = b.events.length;
  release(); await story;
  assert.ok(!b.events.slice(before).includes('safety'), 'safety прежнего цикла не записана');
});

// QA PR 31 (5d24307): голосовое относится к циклу согласия, в котором пришло, а не к циклу после распознавания.
test('метрики: голосовое, пришедшее до нового согласия, не пишется в новом цикле; новое голосовое — пишется', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const b = setup(['pd', 'age'], { transcribeGate: gate });
  await consentAll(b, ['pd', 'age']);
  const voice = b.voice();
  for (let i = 0; i < 50 && !b.n.stt; i++) await tick();
  assert.equal(b.n.stt, 1, 'распознавание идёт');
  await consentAll(b, ['pd', 'age']); // новый цикл, пока распознавалось
  const before = b.events.length;
  const drafts = b.n.draft;
  release(); await voice;
  assert.ok(!b.events.slice(before).includes('story') && !b.events.slice(before).includes('draft'), 'голосовое прежнего цикла не записано');
  assert.equal(b.n.draft, drafts, 'голосовое прежнего цикла не идёт в модель и не открывает черновик');
  const before2 = b.events.length;
  await b.voice(); // в новом цикле — пишется
  assert.ok(b.events.slice(before2).includes('story'), 'новое голосовое записано');
});

test('голосовое: согласие отозвано во время распознавания — без модели, эха и записи; явная опасность — экран остановки', async () => {
  for (const unsafeText of [false, true]) {
    let release; const gate = new Promise((r) => { release = r; });
    const b = setup(['pd', 'age'], { transcribeGate: gate, transcript: unsafeText ? 'Не хочу жить.' : STORY });
    await consentAll(b, ['pd', 'age']);
    const voice = b.voice();
    for (let i = 0; i < 50 && !b.n.stt; i++) await tick();
    await b.say('/start'); // отзыв, нового согласия нет
    const n = b.sent.length; const events = b.events.length;
    release(); await voice;
    const after = b.texts().slice(n);
    assert.equal(b.n.draft, 0, 'модель не вызывается');
    assert.ok(!after.some((t) => t.startsWith('Расшифровка')), 'эха расшифровки нет');
    assert.equal(b.events.length, events, 'метрик нет');
    assert.ok(!b.s().story, 'рассказ в сессию не пишется');
    if (unsafeText) assert.deepEqual(after, [helpMessage('urgent')], 'экран остановки');
    else assert.ok(!after.includes(helpMessage('urgent')));
  }
});

test('голосовое во время доставки: согласие отозвано во время распознавания — без проверки, эха и метрик; ролика нет', async () => {
  let releaseStt; const stt = new Promise((r) => { releaseStt = r; });
  let releaseRender; const renderGate = new Promise((r) => { releaseRender = r; });
  const b = setup(['pd', 'age'], { transcribeGate: stt, renderGate });
  const { p } = await delivering(b);
  const voice = b.voice();
  for (let i = 0; i < 50 && !b.n.stt; i++) await tick();
  await b.say('/start');
  const n = b.sent.length; const events = b.events.length; const checks = b.n.check;
  releaseStt(); await voice;
  assert.ok(!b.texts().slice(n).some((t) => t.startsWith('Расшифровка')), 'эха расшифровки нет');
  assert.equal(b.n.check, checks, 'модельной проверки голосового нет');
  assert.equal(b.events.length, events, 'метрик нет');
  releaseRender(); await p;
  assert.equal(b.n.video, 0, 'ролик после отзыва не уходит');
});

// QA PR 31 (ef95836): граница рассказа — согласие сменилось, пока бот отправлял эхо или ответ про голосовое.
test('голосовое: новое согласие во время отправки эха — модель не вызывается, черновика и метрик нет; опасность — экран остановки', async () => {
  for (const unsafeText of [false, true]) {
    let release; const gate = new Promise((r) => { release = r; });
    const b = setup(['pd', 'age'], { transcript: unsafeText ? 'Не хочу жить.' : STORY, sendGate: (t) => (String(t).startsWith('Расшифровка') ? gate : null) });
    await consentAll(b, ['pd', 'age']);
    const voice = b.voice();
    for (let i = 0; i < 50 && !b.texts().some((t) => String(t).startsWith('Расшифровка')); i++) await tick();
    await consentAll(b, ['pd', 'age']); // новый цикл, пока эхо отправлялось
    const n = b.sent.length; const events = b.events.length;
    release(); await voice;
    assert.equal(b.n.draft, 0, 'модель не вызывается');
    assert.ok(!b.s().story && !b.s().episode, 'черновик нового цикла не меняется');
    assert.equal(b.events.length, events, 'метрик нет');
    const after = b.texts().slice(n);
    if (unsafeText) assert.deepEqual(after, [helpMessage('urgent')], 'экран остановки');
    else assert.deepEqual(after, []);
  }
});

test('голосовое отклонено (длинное) с подписью: новое согласие во время ответа — подпись не идёт в модель и метрики', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const b = setup(['pd', 'age'], { sendGate: (t) => (t === TEXT.voiceLong ? gate : null) });
  await consentAll(b, ['pd', 'age']);
  const voice = b.bot.handleUpdate({ message: { chat: { id: 88001, type: 'private' }, voice: { file_id: 'f9', duration: 100000 }, caption: STORY } });
  for (let i = 0; i < 50 && !b.texts().includes(TEXT.voiceLong); i++) await tick();
  await consentAll(b, ['pd', 'age']);
  const events = b.events.length;
  release(); await voice;
  assert.equal(b.n.draft, 0, 'подпись не идёт в модель');
  assert.equal(b.events.length, events, 'метрик нет');
  await b.say(STORY); // новый рассказ в новом цикле — обычный путь
  assert.equal(b.n.draft, 1, 'новый рассказ обрабатывается');
});

test('рассказ: новое согласие, пока отправлялось «Монтирую…», — модель не вызывается, метрик нет; новый рассказ — обычный путь', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let hold = true;
  const b = setup(['pd', 'age'], { sendGate: (t) => (hold && t === TEXT.working ? gate : null) });
  await consentAll(b, ['pd', 'age']);
  const story = b.say(STORY);
  for (let i = 0; i < 50 && !b.texts().includes(TEXT.working); i++) await tick();
  await consentAll(b, ['pd', 'age']);
  const events = b.events.length;
  hold = false; release(); await story;
  assert.equal(b.n.draft, 0, 'модель не вызывается');
  assert.ok(!b.events.slice(events).includes('draft'), 'метрики draft нет');
  await b.say(STORY);
  assert.equal(b.n.draft, 1, 'новый рассказ — обычный путь');
});

// QA PR 31 (be03e4e): граница скачивания и распознавания голосового.
test('голосовое: /start, пока показывался индикатор, — ни скачивания, ни распознавания, ни модели', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let hold = false;
  const b = setup(['pd', 'age'], { actionGate: { then: (r) => (hold ? gate.then(r) : r()) } });
  await consentAll(b, ['pd', 'age']);
  hold = true;
  const voice = b.voice(); await tick();
  hold = false;
  await b.say('/start');
  release(); await voice;
  assert.deepEqual({ download: b.n.download, stt: b.n.stt, draft: b.n.draft }, { download: 0, stt: 0, draft: 0 });
});

test('голосовое: /delete или /start во время скачивания — распознавание не запускается; /delete — без ответа', async () => {
  for (const cmd of ['/delete', '/start']) {
    for (const busy of [false, true]) {
      let release; const gate = new Promise((r) => { release = r; });
      let hold = false;
      const b = setup(['pd', 'age'], { downloadGate: { then: (r) => (hold ? gate.then(r) : r()) }, renderGate: busy ? new Promise(() => {}) : undefined });
      if (busy) await delivering(b); else await consentAll(b, ['pd', 'age']);
      hold = true;
      const voice = b.voice();
      for (let i = 0; i < 50 && !b.n.download; i++) await tick();
      assert.equal(b.n.download, 1, 'скачивание началось');
      hold = false;
      await b.say(cmd);
      const n = b.sent.length; const events = b.events.length;
      release(); await voice;
      assert.equal(b.n.stt, 0, `${cmd}${busy ? ' (доставка)' : ''}: распознавание не запускается`);
      assert.equal(b.fetched(), 0, `${cmd}${busy ? ' (доставка)' : ''}: байты аудио не запрашиваются`);
      assert.equal(b.events.length, events, 'метрик нет');
      if (cmd === '/delete') assert.deepEqual(b.texts().slice(n), [], '/delete — без ответа');
    }
  }
});

test('голосовое при действующем согласии: скачивание, распознавание и черновик — как обычно', async () => {
  const b = setup(['pd', 'age']);
  await consentAll(b, ['pd', 'age']);
  await b.voice();
  assert.deepEqual({ download: b.n.download, stt: b.n.stt, draft: b.n.draft }, { download: 1, stt: 1, draft: 1 });
  assert.equal(b.fetched(), 1, 'файл запрошен один раз');
});

test('telegram().fileBuffer: ready() между getFile и запросом байтов — false: аудио не запрашивается, null; true — один запрос', async () => {
  const { telegram } = await import('../server/bot.js');
  const orig = globalThis.fetch; const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/getFile')) return { json: async () => ({ ok: true, result: { file_path: 'voice/f.oga' } }) };
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(3) };
  };
  const audio = () => urls.filter((u) => u.includes('/file/bot')).length;
  try {
    const tg = telegram('dummy-not-a-token');
    assert.equal(await tg.fileBuffer('f', { ready: () => false }), null);
    assert.equal(audio(), 0, 'байты не запрошены');
    assert.equal(await tg.fileBuffer('f', { ready: async () => false }), null, 'асинхронный ready');
    assert.equal(audio(), 0);
    assert.equal((await tg.fileBuffer('f', { ready: () => true })).length, 3);
    assert.equal(audio(), 1, 'один запрос байтов');
    assert.equal((await tg.fileBuffer('f')).length, 3, 'без ready — как раньше');
  } finally { globalThis.fetch = orig; }
});

test('голосовое: /delete или /start, пока скачивались байты аудио, — распознавание не запускается (обычный путь и доставка)', { timeout: 10000 }, async () => {
  for (const cmd of ['/delete', '/start']) {
    for (const busy of [false, true]) {
      let release; const gate = new Promise((r) => { release = r; });
      let hold = false;
      const b = setup(['pd', 'age'], { fetchGate: { then: (r) => (hold ? gate.then(r) : r()) }, renderGate: busy ? new Promise(() => {}) : undefined });
      if (busy) await delivering(b); else await consentAll(b, ['pd', 'age']);
      hold = true;
      const voice = b.voice();
      for (let i = 0; i < 50 && !b.fetched(); i++) await tick();
      assert.equal(b.fetched(), 1, 'байты запрашиваются');
      hold = false;
      await b.say(cmd);
      const events = b.events.length;
      release(); await voice;
      assert.equal(b.n.stt, 0, `${cmd}${busy ? ' (доставка)' : ''}: распознавание не запускается`);
      assert.equal(b.events.length, events, 'метрик нет');
    }
  }
});

// Кнопки отклика под роликом: принимаются только три показанных значения.
test('отклик под роликом: чужое значение не пишется в метрики и не получает ответа; три кнопки — как обычно', async () => {
  const b = setup(['pd', 'age']);
  await consentAll(b, ['pd', 'age']);
  const cycle = b.s().consent.cycle;
  const ids = ['0000000a', '0000000b', '0000000c']; // три доставленных ролика: по одному отклику на каждый
  b.s().feedbackFor = new Map(ids.map((id) => [id, { cycle, done: new Set(), rendered: true }])); // доставлены, render записан
  for (const v of ['вымышленный текст', 'fit2', '', 'heavier ']) {
    const n = b.sent.length; const events = b.events.length;
    await b.press(`fb:${v}:${cycle}:${ids[0]}`);
    assert.equal(b.events.length, events, `«${v}»: метрики нет`);
    assert.equal(b.sent.length, n, `«${v}»: ответа нет`);
  }
  for (const [i, [v, reply]] of [['fit', TEXT.fit], ['miss', TEXT.miss], ['heavier', TEXT.heavier]].entries()) {
    const n = b.sent.length; const e = b.events.length;
    await b.press(`fb:${v}:${cycle}:${ids[i]}`);
    assert.equal(b.events.length, e + 1, `${v}: ровно одна метрика`);
    assert.equal(b.events.at(-1), 'feedback');
    assert.deepEqual(b.extras.at(-1), { value: v, video: ids[i] }, `${v}: записано своё значение и номер ролика`);
    assert.equal(b.texts()[n], reply, `${v}: ответ прежний`);
  }
  assert.equal(b.texts().at(-1), helpMessage('concern'), '«Стало тяжелее» — блок помощи');
});

// QA PR 32 (03b4b93): экран принимает только свои кнопки — 6А «Далее»; 6Б и 6Г «Да» и «Нет».
test('кнопки согласия: «Далее» на 6Б/6Г, «Да»/«Нет» на 6А и чужие значения — шаг, отметки и метрики не меняются, экрана нет', { timeout: 15000 }, async () => {
  for (const order of ORDERS) {
    let forgot = 0;
    const b = setup(order, { onForget: () => { forgot++; } });
    await consentAll(b, order);
    await b.say(STORY); // метрики участника есть
    const events = b.events.length;
    await b.say('/start');
    const probe = async (step, answers) => {
      for (const a of answers) {
        const before = { step: b.s().consent.step, given: JSON.stringify(b.s().consent.given), sent: b.sent.length };
        await b.bot.handleUpdate({ callback_query: { id: 'q', data: `cs:${step}:${a}:${b.s().consent.cycle}`, message: { chat: { id: 88001, type: 'private' } } } });
        assert.deepEqual({ step: b.s().consent.step, given: JSON.stringify(b.s().consent.given), sent: b.sent.length }, before, `${order.join('→')}: ${step}:${a}`);
      }
    };
    await probe('intro', ['yes', 'no', 'maybe']);
    await b.press('cs:intro:next');
    for (const st of order) {
      await probe(st, ['next', 'maybe', '']);
      await b.press(`cs:${st}:yes`);
    }
    assert.equal(b.s().consent.step, 'done', 'обычное согласие проходит');
    assert.equal(forgot, 0, 'до штатного отказа удаления метрик не было');
    await probe('done', ['yes', 'no', 'next']); // после согласия кнопок нет
    assert.equal(forgot, 0, 'чужие кнопки после согласия удаление не запускают');
    await b.say('/start'); await b.press('cs:intro:next'); await b.press(`cs:${order[0]}:no`);
    assert.equal(b.s().consent.step, 'declined');
    const forgotAfterNo = forgot;
    await probe('declined', ['yes', 'no', 'next']); // после отказа кнопок нет
    assert.equal(forgot, forgotAfterNo, 'после отказа чужие кнопки удаление не запускают');
    assert.equal(forgotAfterNo, 1, 'штатное «Нет» — ровно одно удаление');
    assert.equal(b.events.length, events, 'метрики не менялись');
  }
});

// QA PR 32 (39b4695): кнопка с чужого экрана не трогает файл метрик — байты и счётчик удаления до и после равны.
test('кнопки согласия: чужое действие — файл метрик байт в байт и счётчик удаления прежние; «Нет» — удаление (оба порядка)', { timeout: 20000 }, async () => {
  for (const order of ORDERS) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-buttons-'));
    try {
      const file = path.join(dir, 'm.jsonl');
      const real = makeMetrics(file, 'fictional-salt-0001');
      let forgets = 0;
      const metrics = { ...real, forget: (id) => { forgets++; return real.forget(id); } };
      const tg = { send: async () => {}, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => {} };
      const bot = createBot({ tg, metrics, consentOrder: order, safetyCheck: async () => false, checkRetryMs: 0,
        draft: async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }),
        render: async (e, o) => ({ seconds: 1, duration: 24, outPath: o.outPath }) });
      const chat = { id: 91101, type: 'private' };
      const press = (step, a) => bot.handleUpdate({ callback_query: { id: 'q', data: `cs:${step}:${a}:${bot.sessions.get(91101).consent.cycle}`, message: { chat } } });
      const settle = async () => { await real.log(91199, 'probe'); }; // очередь записей пройдена (строка другого вымышленного участника)
      await bot.handleUpdate({ message: { chat, text: '/start' } });
      await press('intro', 'next'); for (const st of order) await press(st, 'yes');
      await bot.handleUpdate({ message: { chat, text: STORY } });
      await bot.handleUpdate({ message: { chat, text: '/start' } });
      await settle();
      const check = async (step, answers) => {
        for (const a of answers) {
          const bytes = await fs.readFile(file); const n = forgets;
          await press(step, a); await settle();
          const after = await fs.readFile(file);
          // строка probe дописывается в конец; строки до неё — те же байты
          assert.ok(after.subarray(0, bytes.length).equals(bytes), `${order.join('→')} ${step}:${a}: прежние строки файла не изменились`);
          assert.ok(!after.subarray(bytes.length).toString().includes(real.hash(91101)), `${order.join('→')} ${step}:${a}: новых строк участника нет`);
          assert.equal(forgets, n, `${order.join('→')} ${step}:${a}: удаления нет`);
        }
      };
      assert.ok((await fs.readFile(file, 'utf8')).includes(real.hash(91101)), 'файл метрик участника непустой');
      await check('intro', ['yes', 'no', 'maybe']);
      await press('intro', 'next');
      await check(order[0], ['next', 'maybe', '']);
      // Положительный контроль: штатное «Нет» удаляет строки участника.
      const n = forgets;
      await press(order[0], 'no'); await settle();
      assert.equal(forgets, n + 1, '«Нет» — одно удаление');
      assert.ok(!(await fs.readFile(file, 'utf8')).includes(real.hash(91101)), 'строки участника удалены');
      await check('declined', ['yes', 'no', 'next']);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});
