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

function bot(consentLog, opts = {}) {
  const sent = []; let forgot = 0;
  const tg = { send: async (c, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => {} };
  const metrics = { hash: () => 'participant-a', log: async () => {}, forget: async () => { forgot++; } };
  const b = createBot({ tg, metrics, consentLog, safetyCheck: async () => false, checkRetryMs: 0, draft: async () => ({ episode: null }), render: async () => ({}), ...opts });
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
  await t.consent();
  await t.say('/delete'); // отзыв
  // Отметки отзыва пишутся без ожидания (отказ не задерживается): ждём, пока запись дойдёт до файла.
  for (let i = 0; i < 100 && (await read(file)).length < 8; i++) await new Promise((r) => setTimeout(r, 5));
  const rows = (await read(file)).map((r) => `${r.step}:${r.answer}`);
  assert.deepEqual(rows, ['age:yes', 'pd:yes', 'abroad:yes', 'age:withdraw', 'age:yes', 'pd:yes', 'abroad:yes', 'delete:withdraw']);
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

// Разборы 391b5ec.
test('/delete без согласия в сессии — без записи; после согласия — отзыв', async () => {
  const file = await tmpFile();
  const t = bot(makeConsentLog(file, { hash: () => 'participant-a' }));
  await t.say('/delete');
  await t.say('/start'); await t.press('age', 'no'); await t.say('/delete');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await read(file), [], 'ни согласия, ни записей');
});

test('«Нет» во время записи «Да» на 6Б: в хранилище за «Да» следует отзыв', async () => {
  const rows = []; let release; const gate = new Promise((r) => { release = r; });
  const t = bot({ record: async (id, m) => { if (m.step === 'pd' && m.answer === 'yes') await gate; rows.push(`${m.step}:${m.answer}`); } });
  await t.say('/start'); await t.press('age', 'yes'); await t.press('intro', 'next');
  const p = t.press('pd', 'yes');
  for (let i = 0; i < 50 && t.step() !== 'pd'; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await t.press('pd', 'no');
  release(); await p;
  for (let i = 0; i < 50 && rows.length < 3; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(rows, ['age:yes', 'pd:yes', 'pd:withdraw']);
  assert.equal(t.step(), 'declined');
});

test('запись висит дольше предела — «не получилось сохранить ответ», шаг не засчитан, повтор возможен', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  let hang = true;
  const t = bot({ record: async () => { if (hang) await new Promise(() => {}); } });
  await t.say('/start');
  const p = t.press('age', 'yes');
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  ctx.mock.timers.tick(5000);
  await p;
  assert.equal(t.sent.at(-1).text, TEXT.consentRecordFailed);
  assert.equal(t.step(), 'age');
  hang = false;
  await t.press('age', 'yes');
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.intro);
});

// QA PR 39 c0d69be: первая запись «да» на 6Б висит дольше предела, повторное «Да» принято, потом первая запись
// завершается. Последняя отметка 6Б — «да», шаг засчитан; позднее завершение первой попытки вторую не отзывает.
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
// Записи идут по очереди, как в makeConsentLog: первая «да» 6Б висит, пока её не отпустят.
function slowPd(slowStep = 'pd') {
  const rows = []; const gates = []; let ops = Promise.resolve();
  const record = (id, m) => {
    const slow = m.step === slowStep && m.answer === 'yes' && gates.length === 0;
    const gate = slow ? new Promise((r) => gates.push(r)) : null;
    const op = ops.then(async () => { if (gate) await gate; rows.push(`${m.step}:${m.answer}`); });
    ops = op.catch(() => {});
    return op;
  };
  return { rows, record, release: () => gates[0]() };
}
const timeout = async (ctx, p) => { await flush(); ctx.mock.timers.tick(5000); await p; };
test('просрочка первой «Да», повтор принят, первая запись завершилась позже — согласие действует (QA PR 39)', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const l = slowPd();
  const t = bot({ record: l.record });
  await t.say('/start'); await t.press('age', 'yes'); await t.press('intro', 'next');
  const p = t.press('pd', 'yes');
  await flush();
  ctx.mock.timers.tick(5000);
  await p;
  assert.equal(t.sent.at(-1).text, TEXT.consentRecordFailed);
  assert.equal(t.step(), 'pd');
  const retry = t.press('pd', 'yes'); // встаёт в очередь за висящей первой записью
  await flush();
  l.release(); await retry; await flush();
  assert.equal(t.step(), 'abroad', 'повтор засчитан');
  assert.deepEqual(l.rows, ['age:yes', 'pd:yes', 'pd:yes'], 'отзыва нет: последняя отметка 6Б — «да»');
  assert.equal(t.step(), 'abroad');
  await t.press('abroad', 'yes');
  assert.equal(t.step(), 'done');
});
test('единственная просроченная «Да»: запись завершилась позже — отзыв, шаг прежний', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const l = slowPd();
  const t = bot({ record: l.record });
  await t.say('/start'); await t.press('age', 'yes'); await t.press('intro', 'next');
  const p = t.press('pd', 'yes');
  await flush();
  ctx.mock.timers.tick(5000);
  await p;
  l.release(); await flush();
  assert.deepEqual(l.rows, ['age:yes', 'pd:yes', 'pd:withdraw']);
  assert.equal(t.step(), 'pd', 'действующего согласия нет');
  assert.deepEqual(t.b.sessions.get(93201).consent.given, {});
});
test('просрочка, повтор принят, затем /delete, и только потом поздняя запись — последней идёт отзыв', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const l = slowPd();
  const t = bot({ record: l.record });
  await t.say('/start'); await t.press('age', 'yes'); await t.press('intro', 'next');
  await timeout(ctx, t.press('pd', 'yes'));
  const retry = t.press('pd', 'yes'); await flush();
  await t.say('/delete');
  l.release(); await retry; await flush();
  assert.equal(l.rows.at(-1), 'pd:withdraw', 'после /delete последней идёт отзыв');
});
test('просрочка, повтор ещё пишется, «Нет» на 6Б — последней идёт отзыв', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const l = slowPd();
  const t = bot({ record: l.record });
  await t.say('/start'); await t.press('age', 'yes'); await t.press('intro', 'next');
  await timeout(ctx, t.press('pd', 'yes'));
  const retry = t.press('pd', 'yes'); await flush();
  await t.press('pd', 'no');
  l.release(); await retry; await flush();
  assert.equal(l.rows.at(-1), 'pd:withdraw');
  assert.equal(t.step(), 'declined');
});
test('обе попытки просрочены — обе «да» отозваны, шаг прежний', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const l = slowPd();
  const t = bot({ record: l.record });
  await t.say('/start'); await t.press('age', 'yes'); await t.press('intro', 'next');
  await timeout(ctx, t.press('pd', 'yes'));
  await timeout(ctx, t.press('pd', 'yes'));
  l.release(); await flush();
  assert.equal(l.rows.at(-1), 'pd:withdraw');
  assert.ok(l.rows.lastIndexOf('pd:withdraw') > l.rows.lastIndexOf('pd:yes'));
  assert.equal(t.step(), 'pd');
});

test('просрочка «Да» на возрасте, /start, повтор принят, поздняя запись — отзыва нет (code-review PR 39)', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const l = slowPd('age');
  const t = bot({ record: l.record });
  await t.say('/start');
  await timeout(ctx, t.press('age', 'yes'));
  await t.say('/start');
  const retry = t.press('age', 'yes'); await flush();
  l.release(); await retry; await flush();
  assert.equal(t.step(), 'intro');
  assert.deepEqual(l.rows, ['age:yes', 'age:yes']);
});
test('просрочка «Да» на 6Б, /start, поздняя запись — отзыв до нового прохождения; новое согласие действует', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const l = slowPd();
  const t = bot({ record: l.record });
  await t.say('/start'); await t.press('age', 'yes'); await t.press('intro', 'next');
  await timeout(ctx, t.press('pd', 'yes'));
  await t.say('/start');
  const a = t.press('age', 'yes'); await flush();
  l.release(); await a; await flush();
  await t.press('intro', 'next'); await t.press('pd', 'yes'); await flush();
  assert.equal(t.step(), 'abroad');
  const pd = l.rows.filter((r) => r.startsWith('pd:'));
  assert.deepEqual(pd, ['pd:yes', 'pd:withdraw', 'pd:yes'], 'старая «да» отозвана до новой; последняя отметка 6Б — «да»');
});

// QA PR 39 3548ae8: /delete заменяет сессию; поздняя запись первой попытки не должна отзывать «Да» новой сессии.
test('просрочка «Да» на возрасте, /delete, /start, «Да» принято, поздняя запись — отзыва после нового «Да» нет', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const l = slowPd('age');
  const t = bot({ record: l.record });
  await t.say('/start');
  await timeout(ctx, t.press('age', 'yes'));
  await t.say('/delete');
  await t.say('/start');
  const retry = t.press('age', 'yes'); await flush();
  l.release(); await retry; await flush();
  assert.equal(t.step(), 'intro');
  assert.equal(l.rows.filter((r) => r.startsWith('age:')).at(-1), 'age:yes', 'последняя отметка возраста — «да»');
});
test('просрочка «Да» на 6Б, /delete, новое прохождение до 6Б, поздняя запись — отзыва после нового «Да» нет', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const l = slowPd();
  const t = bot({ record: l.record });
  await t.say('/start'); await t.press('age', 'yes'); await t.press('intro', 'next');
  await timeout(ctx, t.press('pd', 'yes'));
  await t.say('/delete');
  await t.say('/start');
  const a = t.press('age', 'yes'); await flush();
  l.release(); await a; await flush();
  await t.press('intro', 'next'); await t.press('pd', 'yes'); await flush();
  assert.equal(t.step(), 'abroad');
  assert.deepEqual(l.rows.filter((r) => r.startsWith('pd:')), ['pd:yes', 'pd:withdraw', 'pd:yes'], 'поздняя «да» удалённой сессии отозвана до нового согласия');
});
test('просрочка «Да» на 6В, /delete, новое прохождение до 6В, поздняя запись — последняя отметка 6В «да»', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const l = slowPd('abroad');
  const t = bot({ record: l.record });
  await t.say('/start'); await t.press('age', 'yes'); await t.press('intro', 'next'); await t.press('pd', 'yes');
  await timeout(ctx, t.press('abroad', 'yes'));
  await t.say('/delete');
  await t.say('/start');
  const a = t.press('age', 'yes'); await flush();
  l.release(); await a; await flush();
  await t.press('intro', 'next'); await t.press('pd', 'yes'); await t.press('abroad', 'yes'); await flush();
  assert.equal(t.step(), 'done');
  assert.equal(l.rows.filter((r) => r.startsWith('abroad:')).at(-1), 'abroad:yes');
});
// Зависшая запись журнала: очередь не копится, новые отметки отклоняются сразу (порядок строк сохраняется).
test('модуль: запись висит дольше предела — новые отметки отклоняются сразу кодом consent_log_stuck', async () => {
  const file = await tmpFile();
  let t = 1;
  const log = makeConsentLog(file, { hash: () => 'participant-a', stuckMs: 1000, clock: () => t });
  await log.record(1, { step: 'age', answer: 'yes', version: 'v' });
  const orig = fs.appendFile; let release = null;
  fs.appendFile = async (...a) => { await new Promise((r) => { release = r; }); return orig(...a); };
  const held = async () => { for (let i = 0; i < 1000 && !release; i++) await new Promise((r) => setImmediate(r)); const r = release; release = null; assert.ok(r, 'запись дошла до appendFile'); return r; };
  try {
    const hung = log.record(1, { step: 'pd', answer: 'yes', version: 'v' });
    const first = await held();
    t = 500;
    const queued = log.record(1, { step: 'pd', answer: 'withdraw', version: 'v' }); // ещё не зависла — встаёт в очередь
    t = 2000;
    await assert.rejects(log.record(1, { step: 'abroad', answer: 'yes', version: 'v' }), { code: 'consent_log_stuck' });
    const late = log.record(2, { step: 'delete', answer: 'withdraw', version: 'v' }); // отзыв при зависании — в очередь
    first(); await hung;
    (await held())(); await queued;
    (await held())(); await late;
  } finally { fs.appendFile = orig; }
  assert.deepEqual((await read(file)).map((r) => `${r.step}:${r.answer}`), ['age:yes', 'pd:yes', 'pd:withdraw', 'delete:withdraw'], 'отзыв во время зависания не потерян');
  await log.record(1, { step: 'delete', answer: 'withdraw', version: 'v' }); // после освобождения — снова пишет
  assert.equal((await read(file)).at(-1).step, 'delete');
});
test('/delete после истечения сессии: отзыв пишется, если согласие давали в этом процессе', async () => {
  const rows = [];
  const t = bot({ record: async (id, m) => { rows.push(`${m.step}:${m.answer}`); } });
  await t.consent();
  t.b.sessions.delete(93201); // как sweep после 3 ч без сообщений
  await t.say('/delete'); await flush();
  assert.equal(rows.at(-1), 'delete:withdraw');
  const n = rows.length;
  await t.say('/delete'); await flush();
  assert.equal(rows.length, n, 'повторный /delete без нового согласия — без записи');
});
test('после истечения сессии /start → «Нет» на возрасте — отзыв и текст ageDeleted, как при живой сессии', async () => {
  const rows = [];
  const t = bot({ record: async (id, m) => { rows.push(`${m.step}:${m.answer}`); } });
  await t.consent();
  t.b.sessions.delete(93201);
  await t.say('/start'); await t.press('age', 'no'); await flush();
  assert.equal(rows.at(-1), 'age:withdraw');
  assert.equal(t.sent.at(-1).text, CONSENT_TEXT.ageDeleted);
});

// Решение Claude 27.11 (стык PR 40 и PR 44): /delete — отзыв и для чата, убранного из списка допуска после согласия.
test('согласился → убран из списка закрытого теста → /delete → отзыв записан; сессия удалена', async () => {
  const { makeAdmission } = await import('../server/admission.js');
  const allowed = new Set(['93201']);
  const rows = [];
  const t = bot({ record: async (id, m) => { rows.push(`${m.step}:${m.answer}`); } }, { admission: makeAdmission({ allowed, perDay: 5, concurrency: 1 }) });
  await t.consent();
  assert.equal(t.step(), 'done');
  allowed.delete('93201'); // организатор убрал чат из TITRY_ALLOWED_CHATS (в тесте — без перезапуска)
  await t.say('/delete'); await flush();
  assert.equal(rows.at(-1), 'delete:withdraw');
  assert.equal(t.b.sessions.has(93201), false, 'сессия удалена');
  const n = rows.length;
  await t.say('/delete'); await flush();
  assert.equal(rows.length, n, 'повторный /delete без согласия — без записи');
});
test('согласился → перезапуск без чата в списке → /delete → отзыв записан по журналу отметок', async () => {
  const { makeAdmission } = await import('../server/admission.js');
  const file = await tmpFile();
  const a = bot(makeConsentLog(file, { hash: () => 'participant-a' }));
  await a.consent();
  // перезапуск: новый процесс, память пуста, чата нет в списке; журнал тот же
  const b = bot(makeConsentLog(file, { hash: () => 'participant-a' }), { admission: makeAdmission({ allowed: new Set(['1']), perDay: 5, concurrency: 1 }) });
  await b.say('/delete');
  for (let i = 0; i < 50 && (await read(file)).at(-1).step !== 'delete'; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(`${(await read(file)).at(-1).step}:${(await read(file)).at(-1).answer}`, 'delete:withdraw');
  // повторный /delete — согласия по журналу уже нет, новой строки нет
  const n = (await read(file)).length;
  await b.say('/delete'); await flush(); await new Promise((r) => setTimeout(r, 20));
  assert.equal((await read(file)).length, n);
});
test('журнал: согласие 6Б действует до отзыва; отказ на 6В его не снимает; только «да» на возрасте — не согласие', async () => {
  const file = await tmpFile();
  const log = makeConsentLog(file, { hash: (id) => `p${id}` });
  assert.equal(await log.active(1), false, 'файла нет');
  await log.record(1, { step: 'age', answer: 'yes', version: 'v' });
  assert.equal(await log.active(1), false);
  await log.record(1, { step: 'pd', answer: 'yes', version: 'v' });
  await log.record(1, { step: 'abroad', answer: 'no', version: 'v' });
  assert.equal(await log.active(1), true);
  assert.equal(await log.active(2), false, 'другой участник');
  await log.record(1, { step: 'delete', answer: 'withdraw', version: 'v' });
  assert.equal(await log.active(1), false);
});
test('журнал: служебный отзыв поздней «да» на 6В не снимает согласие 6Б; два /delete после перезапуска — одна строка', async () => {
  const file = await tmpFile();
  const log = makeConsentLog(file, { hash: (id) => `p${id}` });
  for (const [step, answer] of [['age', 'yes'], ['pd', 'yes'], ['abroad', 'yes'], ['abroad', 'withdraw']]) await log.record(1, { step, answer, version: 'v' });
  assert.equal(await log.active(1), true, 'abroad:withdraw (settle) 6Б не снимает');
  const [a, b] = await Promise.all([log.withdrawIfActive(1, { step: 'delete', version: 'v' }), log.withdrawIfActive(1, { step: 'delete', version: 'v' })]);
  assert.deepEqual([a, b], [true, false]);
  assert.equal((await read(file)).filter((r) => r.step === 'delete').length, 1);
});
test('согласие → перезапуск → /start → «Нет» на возрасте: отзыв по журналу и текст ageDeleted', async () => {
  const file = await tmpFile();
  const a = bot(makeConsentLog(file, { hash: () => 'participant-a' }));
  await a.consent();
  const b = bot(makeConsentLog(file, { hash: () => 'participant-a' }));
  await b.say('/start'); await b.press('age', 'no'); await flush();
  const last = (await read(file)).at(-1);
  assert.equal(`${last.step}:${last.answer}`, 'age:withdraw');
  assert.equal(b.sent.at(-1).text, CONSENT_TEXT.ageDeleted);
  const n = (await read(file)).length;
  await b.say('/start'); await b.press('age', 'no'); await flush();
  assert.equal(b.sent.at(-1).text, CONSENT_TEXT.ageDeclined, 'повторный отказ — без «отозвано»');
  assert.equal((await read(file)).length, n + 0, 'и без новой строки');
});
test('согласие → перезапуск → /start → «Нет» на 6Б: отзыв pd:withdraw по журналу', async () => {
  const file = await tmpFile();
  const a = bot(makeConsentLog(file, { hash: () => 'participant-a' }));
  await a.consent();
  const b = bot(makeConsentLog(file, { hash: () => 'participant-a' }));
  await b.say('/start'); await b.press('age', 'yes'); await b.press('intro', 'next'); await b.press('pd', 'no');
  for (let i = 0; i < 50 && (await read(file)).at(-1).answer !== 'withdraw'; i++) await new Promise((r) => setTimeout(r, 5));
  const last = (await read(file)).at(-1);
  assert.equal(`${last.step}:${last.answer}`, 'pd:withdraw');
});
test('чат вне списка: поток /delete читает журнал не чаще раза в 10 минут', async () => {
  const { makeAdmission } = await import('../server/admission.js');
  let reads = 0;
  const t = bot({ record: async () => {}, withdrawIfActive: async () => { reads++; return false; } }, { admission: makeAdmission({ allowed: new Set(['1']), perDay: 5, concurrency: 1 }) });
  for (let i = 0; i < 5; i++) await t.say('/delete');
  assert.equal(reads, 1);
});
// Решение Claude 27.11: оборванная последняя строка (падение посреди дозаписи) не скрывает следующую запись.
test('журнал: оборванный хвост без перевода строки — следующая запись читается', async () => {
  const file = await tmpFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const log = makeConsentLog(file, { hash: (id) => `p${id}` });
  await log.record(1, { step: 'age', answer: 'yes', version: 'v' });
  await fs.appendFile(file, '{"at":"2026-11-27T00:00:00.000Z","partic'); // обрыв без \n
  await log.record(1, { step: 'pd', answer: 'yes', version: 'v' });
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  const last = JSON.parse(lines[2]);
  assert.equal(`${last.step}:${last.answer}`, 'pd:yes');
  assert.equal(await log.active(1), true, 'согласие 6Б видно по журналу');
});
test('сбой записи «Да» на 6Б (могла лечь без перевода строки) — шаг не засчитан, служебный отзыв pd:withdraw', async () => {
  const rows = []; let fail = true;
  const t = bot({ record: async (id, m) => { if (fail && m.step === 'pd' && m.answer === 'yes') { fail = false; throw Object.assign(new Error('диск'), { code: 'ENOSPC' }); } rows.push(`${m.step}:${m.answer}`); } });
  await t.say('/start'); await t.press('age', 'yes'); await t.press('intro', 'next'); await t.press('pd', 'yes'); await flush();
  assert.equal(t.step(), 'pd');
  assert.equal(rows.at(-1), 'pd:withdraw');
  await t.press('pd', 'yes'); await flush();
  assert.equal(t.step(), 'abroad', 'повтор засчитан');
  assert.equal(rows.at(-1), 'pd:yes');
});
// QA PR 47 на 4093338: сбой stat() или read() после открытия файла не мешает записать отзыв.
for (const fail of ['stat', 'read']) {
  test(`журнал: сбой ${fail}() при проверке хвоста — отзыв записан отдельной строкой, согласия больше нет`, async () => {
    const file = await tmpFile();
    const log = makeConsentLog(file, { hash: (id) => `p${id}` });
    await log.record(1, { step: 'pd', answer: 'yes', version: 'v' });
    const origOpen = fs.open;
    fs.open = async (...a) => {
      const fh = await origOpen(...a);
      if (a[1] === 'r') fh[fail] = async () => { throw Object.assign(new Error('сбой'), { code: 'EIO' }); };
      return fh;
    };
    let ok;
    try { ok = await log.withdrawIfActive(1, { step: 'delete', version: 'v' }); } finally { fs.open = origOpen; }
    assert.equal(ok, true);
    assert.match(await fs.readFile(file, 'utf8'), /}\n\n\{/, 'граница неизвестна — дозапись с начальным «\\n»');
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((r) => `${r.step}:${r.answer}`), ['pd:yes', 'delete:withdraw']);
    assert.equal(await log.active(1), false);
  });
}
test('журнал: сбой чтения всего файла при /delete — отзыв всё равно записан', async () => {
  const file = await tmpFile();
  const log = makeConsentLog(file, { hash: (id) => `p${id}` });
  await log.record(1, { step: 'pd', answer: 'yes', version: 'v' });
  const orig = fs.readFile;
  fs.readFile = async (f, ...a) => (f === file ? Promise.reject(Object.assign(new Error('сбой'), { code: 'EIO' })) : orig(f, ...a));
  let ok;
  try { ok = await log.withdrawIfActive(1, { step: 'delete', version: 'v' }); } finally { fs.readFile = orig; }
  assert.equal(ok, true);
  assert.equal(await log.active(1), false);
});
// Граница защиты чтения вне списка (критика PR 45, принято частично): в пределах кеша; при 10 000 записях — сброс.
test('чат вне списка: «не чаще раза в 10 минут» — в пределах кеша; при заполнении кеша защита сбрасывается', async () => {
  const { makeAdmission } = await import('../server/admission.js');
  let reads = 0;
  const t = bot({ record: async () => {}, withdrawIfActive: async () => { reads++; return false; } }, { admission: makeAdmission({ allowed: new Set(['1']), perDay: 5, concurrency: 1 }) });
  await t.say('/delete'); await t.say('/delete');
  assert.equal(reads, 1, 'повтор того же чата — без чтения');
  for (let i = 0; i < 10000; i++) await t.b.handleUpdate({ message: { chat: { id: 500000 + i, type: 'private' }, text: '/delete' } });
  const before = reads;
  await t.say('/delete');
  assert.equal(reads, before + 1, 'кеш очищен — тот же чат снова читает журнал (глобального предела нет)');
});

test('чат вне списка, согласия не давал — /delete без отметки', async () => {
  const { makeAdmission } = await import('../server/admission.js');
  const rows = [];
  const t = bot({ record: async (id, m) => { rows.push(`${m.step}:${m.answer}`); } }, { admission: makeAdmission({ allowed: new Set(['1']), perDay: 5, concurrency: 1 }) });
  await t.say('/delete'); await flush();
  assert.deepEqual(rows, []);
});

test('ответ «отметки удалены» помечен на согласование: проверка выпуска не пропускает', async () => {
  const { unfinishedTexts } = await import('../server/release.js');
  assert.ok(unfinishedTexts({ CONSENT_TEXT }).includes('CONSENT_TEXT.ageDeleted'));
});

test('отказ на 6В после прежнего согласия — отметка abroad:no; при первом прохождении — без записи', async () => {
  const rows = [];
  const t = bot({ record: async (id, m) => { rows.push(`${m.step}:${m.answer}`); } });
  await t.say('/start'); await t.press('age', 'yes'); await t.press('intro', 'next'); await t.press('pd', 'yes'); await t.press('abroad', 'no');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(rows, ['age:yes', 'pd:yes', 'abroad:no'], 'согласие 6Б уже было — отказ от передачи записан');
  const fresh = []; const f = bot({ record: async (id, m) => { fresh.push(`${m.step}:${m.answer}`); } });
  await f.say('/start'); await f.press('age', 'yes'); await f.press('intro', 'next');
  assert.deepEqual(fresh, ['age:yes']);
});

test('старт: хранилище отметок недоступно — отказ consent.log до хранилища запретов; доступно — файл 0600, в т. ч. существующий', async () => {
  const { prepareBot } = await import('../server/bot.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-consent-'));
  const env = { METRICS_SALT: 'test-salt-fictional-0001', ANTHROPIC_API_KEY: 'dummy-not-a-key' };
  let loaded = 0;
  const opts = { env, log: () => {}, checkRender: async () => {}, cleanup: async () => {}, cleanupTmp: async () => 0, ledger: { load: async () => { loaded++; } } };
  const blocker = path.join(dir, 'file');
  await fs.writeFile(blocker, 'x');
  await assert.rejects(prepareBot({ ...opts, consentFile: path.join(blocker, 'consent.jsonl') }), { stage: 'consent.log' });
  assert.equal(loaded, 0);
  const file = path.join(dir, 'data', 'consent.jsonl');
  await fs.mkdir(path.dirname(file)); await fs.writeFile(file, '', { mode: 0o644 });
  await prepareBot({ ...opts, consentFile: file });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(loaded, 1);
});

test('код участника — HMAC метрик (как в main): в файле не номер чата', async () => {
  const { makeMetrics } = await import('../server/bot.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-consent-'));
  const m = makeMetrics(path.join(dir, 'metrics.jsonl'), 'test-salt-fictional-0001');
  const file = path.join(dir, 'consent.jsonl');
  await makeConsentLog(file, { hash: m.hash }).record(93201, { step: 'pd', answer: 'yes', version: 'v' });
  const [row] = await read(file);
  assert.equal(row.participant, m.hash(93201));
  assert.ok(!(await fs.readFile(file, 'utf8')).includes('93201'));
});
