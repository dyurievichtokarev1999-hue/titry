// Голос выключен флагом TITRY_VOICE=off (решение Дмитрия 24.11, А4: в G0 только текст). Голосовое не скачивается и не
// распознаётся; ответ — «пока только текстом»; подпись к нему идёт как текст. На реальных данных старт требует off.
// Настоящий createBot (подтверждения — хелпер), подмены со счётчиками. Синтетические данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { TEXT, TEXT_ONLY, voiceEnabled, prepareBot } from '../server/bot.js';
import { createBot } from './helpers/consent.js';
import { NOT_HEARD_TEXT, assessRisk } from '../server/safety.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const tick = () => new Promise((r) => setImmediate(r));
const waitFor = async (f) => { for (let i = 0; i < 200 && !f(); i++) await tick(); assert.ok(f(), 'условие не наступило'); };

function setup({ voice, render } = {}) {
  const sent = []; const events = []; const n = { download: 0, stt: 0, draft: 0, render: 0, video: 0 };
  const tg = {
    send: async (c, text) => { sent.push(text); }, action: async () => {}, answer: async () => {},
    fileBuffer: async () => { n.download++; return Buffer.from('ogg'); }, sendVideo: async () => { n.video++; },
  };
  const metrics = { hash: () => 'fictional', log: async (id, ev, extra = {}) => { events.push({ ev, ...extra }); }, forget: async () => {} };
  const bot = createBot({
    tg, metrics, checkRetryMs: 0, ...(voice === undefined ? {} : { voice }),
    transcribe: async () => { n.stt++; return ex.story; },
    // Как makeDraft: при urgent черновика нет (остановка), иначе — вымышленный эпизод.
    draft: async (st) => { n.draft++; return assessRisk(st).level === 'urgent' ? { risk: assessRisk(st), episode: null, provider: null } : { episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }; },
    safetyCheck: async () => false,
    render: async (e, o) => { n.render++; if (render) await render(); return { seconds: 1, duration: 24, outPath: o.outPath }; },
  });
  const chat = { id: 77955, type: 'private' };
  return {
    sent, events, n,
    say: (text) => bot.handleUpdate({ message: { chat, text } }),
    voice: (caption) => bot.handleUpdate({ message: { chat, voice: { file_id: 'f', duration: 5 }, ...(caption ? { caption } : {}) } }),
    note: () => bot.handleUpdate({ message: { chat, video_note: { file_id: 'v' } } }),
    play: () => bot.handleUpdate({ callback_query: { id: 'q', data: 'play:1', message: { chat } } }),
  };
}

test('флаг: голос выключен только при TITRY_VOICE=off', () => {
  for (const v of ['off', 'OFF', ' Off ']) assert.equal(voiceEnabled({ TITRY_VOICE: v }), false, v);
  for (const env of [{}, { TITRY_VOICE: 'on' }, { TITRY_VOICE: '' }]) assert.equal(voiceEnabled(env), true);
});

test('голос выключен: «пока только текстом», без скачивания, распознавания, модели и метрик рассказа', async () => {
  const b = setup({ voice: false });
  await b.voice();
  assert.equal(b.sent.at(-1), TEXT.voiceTextOnly);
  assert.match(TEXT.voiceTextOnly, /^Пока только текстом/);
  assert.deepEqual([b.n.download, b.n.stt, b.n.draft], [0, 0, 0]);
  assert.ok(!b.events.some((e) => e.ev === 'story'), 'метрики рассказа нет');
});

test('голос выключен: подпись к голосовому — как текст (черновик из подписи, источник text)', async () => {
  const b = setup({ voice: false });
  await b.voice(ex.story);
  assert.ok(b.sent.includes(TEXT.voiceTextOnlyCaption), 'подпись взята — не просим прислать ещё раз');
  assert.ok(!b.sent.includes(TEXT.voiceTextOnly));
  assert.equal(b.n.download + b.n.stt, 0);
  assert.equal(b.n.draft, 1, 'подпись ушла в черновик');
  assert.equal(b.events.find((e) => e.ev === 'story')?.source, 'text');
});

test('голос выключен: явная опасность в подписи — экран остановки, голосовое не скачивается', async () => {
  const b = setup({ voice: false });
  await b.voice('Не хочу жить.');
  assert.match(b.sent.join('\n'), /Для этого рассказа ролика не будет/, 'экран остановки');
  assert.equal(b.n.download + b.n.stt, 0);
  assert.ok(!b.events.some((e) => e.ev === 'draft'), 'черновика нет');
});

test('голос выключен во время подготовки ролика: «пока только текстом», а не «не получилось разобрать»; ролик уходит', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const b = setup({ voice: false, render: () => gate });
  await b.say(ex.story);
  const p = b.play();
  await waitFor(() => b.n.render === 1);
  await b.voice();
  release(); await p;
  assert.ok(b.sent.includes(TEXT.voiceTextOnly));
  assert.ok(!b.sent.includes(NOT_HEARD_TEXT));
  assert.equal(b.n.download + b.n.stt, 0);
  assert.equal(b.n.video, 1);
});

test('голос выключен во время подготовки ролика: явная опасность в подписи — экран остановки, ролик не уходит', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const b = setup({ voice: false, render: () => gate });
  await b.say(ex.story);
  const p = b.play();
  await waitFor(() => b.n.render === 1);
  await b.voice('Не хочу жить.');
  release(); await p;
  assert.match(b.sent.join('\n'), /Для этого рассказа ролика не будет/, 'экран остановки');
  assert.equal(b.n.download + b.n.stt, 0);
  assert.equal(b.n.video, 0);
});

test('голос выключен во время подготовки ролика: кружок — «пока только текстом»', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const b = setup({ voice: false, render: () => gate });
  await b.say(ex.story);
  const p = b.play();
  await waitFor(() => b.n.render === 1);
  await b.note();
  release(); await p;
  assert.ok(b.sent.includes(TEXT.voiceTextOnly));
  assert.ok(!b.sent.includes(NOT_HEARD_TEXT));
});

test('голос выключен: /year и «нет черновика» не предлагают голос', async () => {
  const b = setup({ voice: false });
  await b.say('/year');
  assert.equal(b.sent.at(-1), TEXT_ONLY.year);
  await b.play(); // черновика нет
  assert.equal(b.sent.at(-1), TEXT_ONLY.noDraft);
  for (const t of Object.values(TEXT_ONLY)) assert.doesNotMatch(t, /голос/i);
  const on = setup();
  await on.say('/year');
  assert.equal(on.sent.at(-1), TEXT.year, 'с голосом — прежний текст');
});

// createBot по умолчанию — с голосом и не читает окружение (тесты не зависят от TITRY_VOICE оболочки); флаг передаёт main.
test('голос включён (по умолчанию): голосовое распознаётся, как раньше, даже при TITRY_VOICE=off в окружении', async () => {
  const prev = process.env.TITRY_VOICE; process.env.TITRY_VOICE = 'off';
  try {
    const b = setup();
    await b.voice();
    assert.deepEqual([b.n.download, b.n.stt, b.n.draft], [1, 1, 1]);
    assert.ok(!b.sent.includes(TEXT.voiceTextOnly));
  } finally { if (prev === undefined) delete process.env.TITRY_VOICE; else process.env.TITRY_VOICE = prev; }
});

test('старт на реальных данных (TITRY_RELEASE_REAL_DATA=1) без TITRY_VOICE=off — отказ release_voice до очистки', async () => {
  const env = { METRICS_SALT: 'test-salt-fictional-0001', TITRY_RELEASE_REAL_DATA: '1', ANTHROPIC_API_KEY: 'dummy-not-a-key' };
  const texts = { CONSENT_TEXT: { pd: 'Окончательный вымышленный текст.' }, TEXT: { start: 'Привет.' } };
  let done = 0;
  const opts = { texts, log: () => {}, checkRender: async () => {}, cleanup: async () => { done++; }, cleanupTmp: async () => { done++; return 0; }, ledger: { load: async () => { done++; } } };
  await assert.rejects(prepareBot({ env, ...opts }), { code: 'release_voice', stage: 'release.voice' });
  assert.equal(done, 0, 'ни очистки, ни хранилища');
  await prepareBot({ env: { ...env, TITRY_VOICE: 'off' }, ...opts });
  assert.equal(done, 3, 'голос выключен — старт продолжается');
  // Вымышленный стенд без реальных данных — флаг не обязателен.
  await prepareBot({ env: { METRICS_SALT: env.METRICS_SALT, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }, ...opts });
  assert.equal(done, 6, 'вымышленный стенд — старт продолжается');
});
