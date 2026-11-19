// Экраны согласия 6А–6З (комплект для юриста v2, пакет согласия v8, 2.1–2.2) и приём рассказа до подтверждений:
// критерии QA «Приём рассказа до подтверждений» 1–3. Настоящий createBot (без хелпера подтверждений); подмены со
// счётчиками: скачивание голосового, SpeechKit, модель (черновик и проверка), метрика story, рендер. Синтетические данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBot, TEXT, splitForTelegram, TELEGRAM_TEXT_LIMIT } from '../server/bot.js';
import { CONSENT_TEXT, consentSteps } from '../server/consent.js';
import { helpMessage } from '../server/safety.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const ORDERS = [['pd', 'age'], ['age', 'pd']];
const INVITES = [CONSENT_TEXT.ready, TEXT.year];
const STORY = ex.story;

function setup(order, { draftGate, renderGate, unsafe, sendGate, botName, onForget, check } = {}) {
  const sent = [];
  const n = { download: 0, stt: 0, draft: 0, check: 0, story: 0, render: 0, video: 0 };
  const tg = {
    send: async (c, text, extra) => { sent.push({ text, extra }); if (sendGate) await sendGate(text); }, action: async () => {}, answer: async () => {},
    fileBuffer: async () => { n.download++; return Buffer.from('ogg'); },
    sendVideo: async () => { n.video++; },
  };
  const events = [];
  const metrics = { hash: () => 'qa-fictional', log: async (c, event) => { events.push(event); if (event === 'story') n.story++; }, forget: async () => { if (onForget) onForget(); } };
  const bot = createBot({
    tg, metrics, consentOrder: order, botName,
    transcribe: async () => { n.stt++; return STORY; },
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
  return { bot, sent, n, events, say, press, voice, voiceCaption, photoCaption, s, texts: () => sent.map((m) => m.text) };
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
    assert.deepEqual(b.events, ['start'], 'в метриках только /start: опасные сообщения не записаны');
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
