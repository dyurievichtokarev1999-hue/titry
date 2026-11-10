// G0-fixes (критик реализации 10.11): отказы при удалении метрик не дают ответа «всё удалено».
// Подставные отказы fs; данные вымышленные, ключей и данных участников нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBot, makeMetrics } from '../server/bot.js';

const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));
const chat = { id: 771003, type: 'private' };
const fakeTg = (sent) => ({ send: async (id, text) => sent.push(text), action: async () => {}, answer: async () => {}, sendVideo: async () => {} });

async function withPatched(name, impl, fn) {
  const original = fs[name];
  fs[name] = impl(original);
  try { return await fn(); } finally { fs[name] = original; }
}

test('сбой rename: forget отклоняется, временный файл убран, строки на месте, ответ не «удалено»', async () => {
  const dir = await tmp('titry-mf-rename-');
  try {
    const file = path.join(dir, 'm.jsonl');
    const metrics = makeMetrics(file, 'mf-salt');
    await metrics.log(chat.id, 'start');
    await metrics.log(2, 'start');
    const before = await fs.readFile(file, 'utf8');
    const sent = [];
    const bot = createBot({ safetyCheck: async () => false, tg: fakeTg(sent), metrics });
    await withPatched('rename', (orig) => async (a, b) => { if (b === file) throw Object.assign(new Error('подставной отказ'), { code: 'EIO' }); return orig.call(fs, a, b); }, async () => {
      await bot.handleUpdate({ message: { chat, text: '/delete' } });
    });
    assert.equal(sent.at(-1), 'Сессия удалена, а удаление статистики по тебе подтвердить не получилось. Попробуй /delete ещё раз чуть позже.');
    assert.equal(bot.sessions.size, 0);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['m.jsonl'], 'временный файл не остаётся');
    assert.equal(await fs.readFile(file, 'utf8'), before, 'файл не обрезан');
    // Повторный /delete без отказа — честное «удалено», строк человека нет, чужие на месте.
    await bot.handleUpdate({ message: { chat, text: '/delete' } });
    assert.equal(sent.at(-1), 'Сессия и статистика по тебе удалены.');
    const rows = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.user), [metrics.hash(2)]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('сбой чтения (не ENOENT): forget отклоняется; нет файла — удалять нечего, это успех', async () => {
  const dir = await tmp('titry-mf-read-');
  try {
    const file = path.join(dir, 'm.jsonl');
    const metrics = makeMetrics(file, 'mf-salt');
    await metrics.forget(chat.id); // файла ещё нет
    await metrics.log(chat.id, 'start');
    await withPatched('readFile', (orig) => async (p, ...rest) => { if (p === file) throw Object.assign(new Error('подставной отказ'), { code: 'EACCES' }); return orig.call(fs, p, ...rest); }, async () => {
      await assert.rejects(metrics.forget(chat.id), { code: 'EACCES' });
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('зависшая запись: forget отклоняется по тайм-ауту, удаление выполняется позже и строки не возвращаются', async () => {
  const dir = await tmp('titry-mf-timeout-');
  let release;
  const hold = new Promise((r) => { release = r; });
  try {
    const file = path.join(dir, 'm.jsonl');
    const metrics = makeMetrics(file, 'mf-salt', { forgetTimeoutMs: 50 });
    await metrics.log(chat.id, 'start');
    let pending;
    let entered;
    const inAppend = new Promise((r) => { entered = r; });
    await withPatched('appendFile', (orig) => async (...args) => { entered(); await hold; return orig.call(fs, ...args); }, async () => {
      pending = metrics.log(2, 'start'); // очередь занята зависшей записью другого человека
      await inAppend; // сигнал, а не таймер: запись точно в очереди и висит
      await assert.rejects(metrics.forget(chat.id), { code: 'timeout' });
      release();
      await pending;
    });
    await metrics.log(3, 'start'); // очередь дошла до удаления
    const users = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l).user);
    assert.ok(!users.includes(metrics.hash(chat.id)), 'удаление выполнено после тайм-аута');
    assert.deepEqual(users, [metrics.hash(2), metrics.hash(3)]);
  } finally { release(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('карта поколений не растёт: после завершения операций записей не остаётся', async () => {
  const dir = await tmp('titry-mf-gen-');
  try {
    const metrics = makeMetrics(path.join(dir, 'm.jsonl'), 'mf-salt');
    for (let id = 1; id <= 20; id++) { await metrics.log(id, 'start'); await metrics.forget(id); }
    await Promise.all([metrics.log(21, 'start'), metrics.forget(21), metrics.log(21, 'render')]);
    assert.equal(metrics.trackedUsers, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// Критик реализации 10.11: двойной отказ (rename и удаление временной копии) не скрывается,
// копия удаляется позже, после перезапуска — тоже; повторы ограничены.
const tmpNames = async (dir) => (await fs.readdir(dir)).filter((n) => n.includes('.tmp-'));
const fault = (code) => Object.assign(new Error('подставной отказ'), { code });

test('rename и удаление копии оба отказали: честная ошибка, сигнал оператору без пути, копия убирается позже', async (t) => {
  const dir = await tmp('titry-mf-double-');
  const errors = t.mock.method(console, 'error', () => {});
  try {
    const file = path.join(dir, 'm.jsonl');
    const metrics = makeMetrics(file, 'mf-salt');
    await metrics.log(101, 'start');
    await metrics.log(202, 'start');
    const origRename = fs.rename, origRm = fs.rm;
    fs.rename = async (a, b) => { if (b === file) throw fault('EIO'); return origRename.call(fs, a, b); };
    fs.rm = async (p, o) => { if (String(p).includes('.tmp-')) throw fault('EACCES'); return origRm.call(fs, p, o); };
    try {
      await assert.rejects(metrics.forget(101), (e) => e.code === 'EIO' && e.tmpCleanup === 'failed');
    } finally { fs.rename = origRename; fs.rm = origRm; }
    assert.equal((await tmpNames(dir)).length, 1, 'копия осталась — и это известно');
    assert.equal(metrics.pendingTmpCleanup, 1);
    const msgs = errors.mock.calls.map((c) => c.arguments.join(' '));
    assert.ok(msgs.some((m) => m.includes('metrics_tmp_cleanup_failed')));
    assert.ok(msgs.every((m) => !m.includes(dir) && !m.includes(metrics.hash(101)) && !m.includes(metrics.hash(202))), 'без пути и хэшей');
    // Отказ снят: следующая операция убирает копию, данные второго человека на месте.
    await metrics.log(202, 'render');
    assert.deepEqual(await tmpNames(dir), []);
    assert.equal(metrics.pendingTmpCleanup, 0);
    const users = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l).user);
    assert.ok(users.filter((u) => u === metrics.hash(202)).length === 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('частичная запись копии и отказ её удаления: ошибка честная, копия убирается позже', async (t) => {
  const dir = await tmp('titry-mf-partial-');
  t.mock.method(console, 'error', () => {});
  try {
    const file = path.join(dir, 'm.jsonl');
    const metrics = makeMetrics(file, 'mf-salt');
    await metrics.log(101, 'start');
    const origWrite = fs.writeFile, origRm = fs.rm;
    fs.writeFile = async (p, data, ...rest) => { if (String(p).includes('.tmp-')) { await origWrite.call(fs, p, String(data).slice(0, 5)); throw fault('ENOSPC'); } return origWrite.call(fs, p, data, ...rest); };
    fs.rm = async (p, o) => { if (String(p).includes('.tmp-')) throw fault('EACCES'); return origRm.call(fs, p, o); };
    try {
      await assert.rejects(metrics.forget(101), (e) => e.code === 'ENOSPC' && e.tmpCleanup === 'failed');
    } finally { fs.writeFile = origWrite; fs.rm = origRm; }
    assert.equal((await tmpNames(dir)).length, 1);
    await metrics.forget(101); // повтор без отказов: копия убрана, строки человека удалены
    assert.deepEqual(await tmpNames(dir), []);
    assert.equal(await fs.readFile(file, 'utf8'), '');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('после перезапуска оставшаяся копия этого журнала удаляется при первой операции', async () => {
  const dir = await tmp('titry-mf-restart-');
  try {
    const file = path.join(dir, 'm.jsonl');
    await fs.writeFile(`${file}.tmp-99999`, '{"user":"synthetic"}\n');
    await fs.writeFile(path.join(dir, 'other.jsonl.tmp-1'), 'x'); // чужой файл не трогаем
    const metrics = makeMetrics(file, 'mf-salt');
    await metrics.log(1, 'start');
    assert.deepEqual((await fs.readdir(dir)).sort(), ['m.jsonl', 'other.jsonl.tmp-1']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('постоянный отказ удаления копии: попыток не больше трёх, оператору сообщено, бесконечных повторов нет', async (t) => {
  const dir = await tmp('titry-mf-exhaust-');
  const errors = t.mock.method(console, 'error', () => {});
  try {
    const file = path.join(dir, 'm.jsonl');
    await fs.writeFile(`${file}.tmp-99999`, 'x');
    const metrics = makeMetrics(file, 'mf-salt');
    const origRm = fs.rm;
    let rmCalls = 0;
    fs.rm = async (p, o) => { if (String(p).includes('.tmp-')) { rmCalls++; throw fault('EACCES'); } return origRm.call(fs, p, o); };
    try {
      for (let i = 0; i < 6; i++) await metrics.log(1, 'start');
    } finally { fs.rm = origRm; }
    assert.equal(rmCalls, 3);
    assert.equal(metrics.pendingTmpCleanup, 1, 'очистка остаётся неподтверждённой');
    assert.equal(errors.mock.calls.filter((c) => String(c.arguments[0]).includes('metrics_tmp_cleanup_exhausted')).length, 1);
    const rows = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
    assert.equal(rows.length, 6, 'записи метрик не страдают от отказа очистки');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// Разбор 10.11: forget не подтверждает удаление, пока копия журнала (возможно, со строками человека) не убрана.
test('копия после перезапуска не удаляется: forget не подтверждает удаление, /delete не пишет «удалено»', async (t) => {
  const dir = await tmp('titry-mf-pending-');
  t.mock.method(console, 'error', () => {});
  try {
    const file = path.join(dir, 'm.jsonl');
    const metrics0 = makeMetrics(file, 'mf-salt');
    await fs.writeFile(`${file}.tmp-99999`, JSON.stringify({ user: metrics0.hash(chat.id), event: 'start' }) + '\n');
    const metrics = makeMetrics(file, 'mf-salt');
    const sent = [];
    const bot = createBot({ safetyCheck: async () => false, tg: fakeTg(sent), metrics });
    const origRm = fs.rm;
    fs.rm = async (p, o) => { if (String(p).includes('.tmp-')) throw fault('EACCES'); return origRm.call(fs, p, o); };
    try {
      await bot.handleUpdate({ message: { chat, text: '/delete' } });
      assert.equal(sent.at(-1), 'Сессия удалена, а удаление статистики по тебе подтвердить не получилось. Попробуй /delete ещё раз чуть позже.');
      await assert.rejects(metrics.forget(chat.id), { code: 'tmp_cleanup_pending' });
    } finally { fs.rm = origRm; }
    await bot.handleUpdate({ message: { chat, text: '/delete' } }); // отказ снят
    assert.equal(sent.at(-1), 'Сессия и статистика по тебе удалены.');
    assert.deepEqual(await tmpNames(dir), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('посторонние файлы с похожим именем не трогаются', async () => {
  const dir = await tmp('titry-mf-names-');
  try {
    const file = path.join(dir, 'm.jsonl');
    const keep = ['m.jsonl.tmp-old.jsonl', 'm.jsonl.tmp-backup', 'xm.jsonl.tmp-1'];
    for (const n of keep) await fs.writeFile(path.join(dir, n), 'x');
    await fs.writeFile(`${file}.tmp-123`, 'x');
    const metrics = makeMetrics(file, 'mf-salt');
    await metrics.log(1, 'start');
    assert.deepEqual((await fs.readdir(dir)).sort(), ['m.jsonl', ...keep].sort());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('папку не удалось проверить (не ENOENT): сигнал оператору, удаление не подтверждается, проверка повторяется', async (t) => {
  const dir = await tmp('titry-mf-scan-');
  const errors = t.mock.method(console, 'error', () => {});
  try {
    const file = path.join(dir, 'm.jsonl');
    const metrics = makeMetrics(file, 'mf-salt');
    const origReaddir = fs.readdir;
    fs.readdir = async (p, ...rest) => { if (p === dir) throw fault('EACCES'); return origReaddir.call(fs, p, ...rest); };
    try {
      await metrics.log(1, 'start');
      await assert.rejects(metrics.forget(1), { code: 'tmp_cleanup_pending' });
    } finally { fs.readdir = origReaddir; }
    assert.ok(errors.mock.calls.some((c) => String(c.arguments[0]).includes('metrics_tmp_scan_failed')));
    await metrics.forget(1); // проверка удалась — удаление подтверждено
    assert.equal(await fs.readFile(file, 'utf8'), '');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// Разбор 10.11: после исчерпания фоновых попыток явный /delete снова пробует очистку — повтор помогает без перезапуска.
test('после исчерпания попыток отказ снят: явный forget убирает копию и подтверждает удаление', async (t) => {
  const dir = await tmp('titry-mf-retry-');
  t.mock.method(console, 'error', () => {});
  try {
    const file = path.join(dir, 'm.jsonl');
    await fs.writeFile(`${file}.tmp-77`, 'x');
    await fs.mkdir(path.join(dir, 'm.jsonl.tmp-88')); // папка с похожим именем — не копия, не мешает
    const metrics = makeMetrics(file, 'mf-salt');
    const origRm = fs.rm, origReaddir = fs.readdir;
    fs.rm = async (p, o) => { if (String(p).includes('.tmp-')) throw fault('EACCES'); return origRm.call(fs, p, o); };
    try {
      for (let i = 0; i < 4; i++) await metrics.log(1, 'start'); // фоновые попытки исчерпаны
      await assert.rejects(metrics.forget(1), { code: 'tmp_cleanup_pending' });
    } finally { fs.rm = origRm; }
    await metrics.forget(1);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['m.jsonl', 'm.jsonl.tmp-88']);
    // То же для проверки папки.
    const m2 = makeMetrics(path.join(dir, 'n.jsonl'), 'mf-salt');
    fs.readdir = async (p, ...rest) => { if (p === dir) throw fault('EACCES'); return origReaddir.call(fs, p, ...rest); };
    try {
      for (let i = 0; i < 4; i++) await m2.log(1, 'start');
      await assert.rejects(m2.forget(1), { code: 'tmp_cleanup_pending' });
    } finally { fs.readdir = origReaddir; }
    await m2.forget(1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
