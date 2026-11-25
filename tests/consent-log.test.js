// Хранилище отметок о согласии (решение Дмитрия 24.11, А7): код участника, шаг, кнопка, версия текста, время;
// текстов рассказов и номера Telegram нет. «Да» засчитывается только после записи отметки; отказ и /delete не
// задерживаются. Настоящий createBot без заданного порядка; файл — во временном каталоге. Только вымышленные данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBot, TEXT } from '../server/bot.js';
import { CONSENT_TEXT, CONSENT_VERSION } from '../server/consent.js';
import { makeConsentLog } from '../server/consent-log.js';

const STORY = 'Утром убежал кофе, днём полчаса искали ключи, вечером соседи принесли пирог.';
const tmpFile = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'titry-consent-')), 'data', 'consent.jsonl');
const read = async (file) => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

function bot(consentLog) {
  const sent = []; let forgot = 0;
  const tg = { send: async (c, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => {} };
  const metrics = { hash: () => 'participant-a', log: async () => {}, forget: async () => { forgot++; } };
  const b = createBot({ tg, metrics, consentLog, safetyCheck: async () => false, checkRetryMs: 0, draft: async () => ({ episode: null }), render: async () => ({}) });
  const chat = { id: 93201, type: 'private' };
  const cycle = () => b.sessions.get(chat.id).consent.cycle;
  const press = (step, a) => b.handleUpdate({ callback_query: { id: 'q', data: `cs:${step}:${a}:${cycle()}`, message: { chat } } });
  const say = (text) => b.handleUpdate({ message: { chat, text } });
  const consent = async () => { await say('/start'); await press('age', 'yes'); await press('intro', 'next'); await press('pd', 'yes'); await press('abroad', 'yes'); };
  return { b, sent, press, say, consent, step: () => b.sessions.get(chat.id)?.consent?.step, forgot: () => forgot };
}

test('полное согласие: отметки 6Г, 6Б, 6В — код участника, шаг, кнопка, версия, время; ни номера чата, ни рассказа', async () => {
  const file = await tmpFile();
  const t = bot(makeConsentLog(file, { hash: () => 'participant-a' }));
  await t.consent();
  assert.equal(t.step(), 'done');
  await t.say(STORY);
  const rows = await read(file);
  assert.deepEqual(rows.map((r) => `${r.step}:${r.answer}`), ['age:yes', 'pd:yes', 'abroad:yes']);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['answer', 'at', 'participant', 'step', 'version']);
    assert.equal(r.participant, 'participant-a');
    assert.equal(r.version, CONSENT_VERSION);
    assert.ok(!Number.isNaN(Date.parse(r.at)));
  }
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes('93201"') && !raw.includes(':93201'), 'номера чата нет');
  assert.ok(!raw.includes('кофе'), 'текста рассказа нет');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('сбой записи «Да»: шаг не засчитан, «не получилось сохранить ответ»; повтор — засчитан', async () => {
  let fail = true;
  const log = { record: async () => { if (fail) throw Object.assign(new Error('диск'), { code: 'ENOSPC' }); } };
  const t = bot(log);
  await t.say('/start');
  await t.press('age', 'yes');
  assert.equal(t.step(), 'age', 'шаг не засчитан');
  assert.equal(t.sent.at(-1).text, TEXT.consentRecordFailed);
  fail = false;
  await t.press('age', 'yes');
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.intro, 'повтор — следующий экран');
});

test('двойное нажатие «Да», пока отметка пишется: одна запись, один следующий экран', async () => {
  const calls = []; let release; const gate = new Promise((r) => { release = r; });
  const t = bot({ record: async (id, m) => { calls.push(m.step); await gate; } });
  await t.say('/start');
  const p1 = t.press('age', 'yes'); const p2 = t.press('age', 'yes');
  release(); await p1; await p2;
  assert.deepEqual(calls, ['age']);
  assert.equal(t.sent.filter((m) => m.text === CONSENT_TEXT.intro).length, 1);
});

test('/start во время записи «Да»: старый шаг не засчитывается', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let writing = false;
  const t = bot({ record: async () => { writing = true; await gate; } });
  await t.say('/start');
  const p = t.press('age', 'yes');
  for (let i = 0; i < 50 && !writing; i++) await new Promise((r) => setImmediate(r));
  assert.ok(writing, 'запись идёт');
  await t.say('/start');
  release(); await p;
  assert.equal(t.step(), 'age');
  assert.ok(!t.sent.some((m) => m.text === CONSENT_TEXT.intro), '6А не показан по старому нажатию');
});

test('отзыв: /delete и «Нет» после согласия — отметки withdraw; «Нет» без прежнего согласия — без записи; сбой записи отказ не задерживает', async () => {
  const file = await tmpFile();
  const t = bot(makeConsentLog(file, { hash: () => 'participant-a' }));
  await t.say('/start'); await t.press('age', 'no'); // без прежнего согласия
  assert.deepEqual(await read(file), []);
  await t.consent();
  await t.say('/start'); await t.press('age', 'no'); // отзыв
  await t.say('/delete');
  // Отметки отзыва пишутся без ожидания (отказ не задерживается): ждём, пока запись дойдёт до файла.
  for (let i = 0; i < 100 && (await read(file)).length < 5; i++) await new Promise((r) => setTimeout(r, 5));
  const rows = (await read(file)).map((r) => `${r.step}:${r.answer}`);
  assert.deepEqual(rows.slice(-2), ['age:withdraw', 'delete:withdraw']);
  const f = bot({ record: async (id, m) => { if (m.answer !== 'yes') throw new Error('диск'); } });
  await f.consent();
  await f.say('/start'); await f.press('age', 'no');
  assert.equal(f.sent.at(-1).text, CONSENT_TEXT.ageDeleted, 'отказ прошёл, несмотря на сбой записи');
  await f.say('/delete');
  assert.ok(f.sent.at(-1).text.length > 0, '/delete ответил');
});

test('модуль: неизвестная отметка отклоняется; без функции кода участника — ошибка создания', async () => {
  const log = makeConsentLog(await tmpFile(), { hash: () => 'x' });
  await assert.rejects(log.record(1, { step: 'story', answer: 'yes' }), { code: 'consent_bad_mark' });
  assert.throws(() => makeConsentLog('f', {}));
});
