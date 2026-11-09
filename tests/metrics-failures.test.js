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
    const bot = createBot({ tg: fakeTg(sent), metrics });
    await withPatched('rename', (orig) => async (a, b) => { if (b === file) throw Object.assign(new Error('подставной отказ'), { code: 'EIO' }); return orig.call(fs, a, b); }, async () => {
      await bot.handleUpdate({ message: { chat, text: '/delete' } });
    });
    assert.equal(sent.at(-1), 'Сессия удалена, а удаление статистики по тебе подтвердить не получилось. Попробуй /delete ещё раз чуть позже.');
    assert.equal(bot.sessions.size, 0);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['m.jsonl'], 'временный файл не остаётся');
    assert.equal(await fs.readFile(file, 'utf8'), before, 'файл не обрезан');
    // Повторный /delete без отказа — честное «удалено», строк человека нет, чужие на месте.
    await bot.handleUpdate({ message: { chat, text: '/delete' } });
    assert.equal(sent.at(-1), 'Готово: сессия и статистика по тебе удалены.');
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
    await withPatched('appendFile', (orig) => async (...args) => { await hold; return orig.call(fs, ...args); }, async () => {
      pending = metrics.log(2, 'start'); // очередь занята зависшей записью другого человека
      await new Promise((r) => setTimeout(r, 10));
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
