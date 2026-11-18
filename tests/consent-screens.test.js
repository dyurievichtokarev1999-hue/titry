// Экраны согласия 6А–6З (комплект для юриста v2, пакет согласия v8, 2.1–2.2) и приём рассказа до подтверждений:
// критерии QA «Приём рассказа до подтверждений» 1–3. Настоящий createBot (без хелпера подтверждений); подмены со
// счётчиками: скачивание голосового, SpeechKit, модель (черновик и проверка), метрика story, рендер. Синтетические данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBot, TEXT, splitForTelegram, TELEGRAM_TEXT_LIMIT } from '../server/bot.js';
import { CONSENT_TEXT, consentSteps } from '../server/consent.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const ORDERS = [['pd', 'age'], ['age', 'pd']];
const INVITES = [CONSENT_TEXT.ready, TEXT.year, TEXT.start];
const STORY = ex.story;

function setup(order, { draftGate, renderGate } = {}) {
  const sent = [];
  const n = { download: 0, stt: 0, draft: 0, check: 0, story: 0, render: 0, video: 0 };
  const tg = {
    send: async (c, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {},
    fileBuffer: async () => { n.download++; return Buffer.from('ogg'); },
    sendVideo: async () => { n.video++; },
  };
  const metrics = { hash: () => 'qa-fictional', log: async (c, event) => { if (event === 'story') n.story++; }, forget: async () => {} };
  const bot = createBot({
    tg, metrics, consentOrder: order,
    transcribe: async () => { n.stt++; return STORY; },
    draft: async () => { n.draft++; await draftGate; return { episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }; },
    safetyCheck: async () => { n.check++; return false; },
    checkRetryMs: 0,
    render: async (e, o) => { n.render++; await renderGate; return { seconds: 1, duration: 24, outPath: o.outPath }; },
  });
  const chat = { id: 88001, type: 'private' };
  const say = (text) => bot.handleUpdate({ message: { chat, text } });
  const press = (data) => bot.handleUpdate({ callback_query: { id: 'q', data, message: { chat } } });
  const voice = () => bot.handleUpdate({ message: { chat, voice: { file_id: 'f1', duration: 5 } } });
  const voiceCaption = () => bot.handleUpdate({ message: { chat, voice: { file_id: 'f2', duration: 5 }, caption: STORY } });
  const photoCaption = () => bot.handleUpdate({ message: { chat, photo: [{ file_id: 'p1' }], caption: STORY } });
  const s = () => bot.sessions.get(chat.id);
  return { bot, sent, n, say, press, voice, voiceCaption, photoCaption, s, texts: () => sent.map((m) => m.text) };
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

test('/year без подтверждений — 6А; после подтверждений приглашение — за год; голос после подтверждений расшифровывается', async () => {
  const b = setup(['pd', 'age']);
  await b.say('/year');
  assert.equal(b.texts()[0], CONSENT_TEXT.intro);
  for (const d of ['cs:intro:next', 'cs:pd:yes', 'cs:age:yes']) await b.press(d);
  assert.equal(b.texts().at(-1), TEXT.year);
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

test('исправленное сообщение до подтверждений не обрабатывается', async () => {
  const b = setup(['pd', 'age']);
  await b.say('/start');
  await b.bot.handleUpdate({ edited_message: { chat: { id: 88001, type: 'private' }, text: 'Не хочу жить.' } });
  assert.ok(!b.s().story);
  assert.deepEqual(b.texts(), [CONSENT_TEXT.intro]);
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
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(b.s().delivering, 'доставка идёт');
    await b.say('/start');
    assert.notEqual(b.s().consent.step, 'done');
    const q = b.say('Сдохну'); // локально urgent (решение 16.11): ролик отменяется
    await new Promise((r) => setTimeout(r, 20));
    release();
    await q;
  } finally { release(); await playing; }
  assert.equal(b.n.video, 0, 'ролик не отправлен');
  assert.ok(b.texts().some((t) => /112/.test(String(t))), 'экран остановки с 112');
});
