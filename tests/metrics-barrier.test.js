// Регрессия ИР-06 (критик реализации GPT, 9.11.2026): завершённый /delete — барьер для уже принятой записи метрик.
// Основано на воспроизводимом тесте критика. Рассказы вымышленные; настоящих ключей и данных участников нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBot, makeMetrics } from '../server/bot.js';

const example = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const chat = { id: 914205, type: 'private' };
const message = (text = example.story) => ({ message: { chat, text } });
const click = (data) => ({ callback_query: { id: 'ir-synthetic', data, message: { chat } } });
const rows = async (file) => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));

test('ИР-06 контроль: завершённая запись удаляется forget', async () => {
  const dir = await tmp('titry-ir-control-');
  try {
    const file = path.join(dir, 'metrics.jsonl');
    const m = makeMetrics(file, 'ir-synthetic-salt');
    await m.log(chat.id, 'render', { seconds: 1 });
    await m.forget(chat.id);
    assert.equal(await fs.readFile(file, 'utf8'), '');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('ИР-06: запись render, начатая до /delete, не возвращается в файл', { timeout: 6000 }, async () => {
  const dir = await tmp('titry-ir-inflight-');
  const file = path.join(dir, 'metrics.jsonl');
  const entered = deferred(), release = deferred();
  const originalMkdir = fs.mkdir;
  let hold = false, active;
  try {
    const metrics = makeMetrics(file, 'ir-synthetic-salt');
    const sent = [];
    const tg = { send: async (id, text, extra) => sent.push({ text, extra }), action: async () => {}, answer: async () => {}, sendVideo: async () => {} };
    const bot = createBot({ safetyCheck: async () => false, tg, metrics,
      draft: async () => ({ episode: structuredClone(example.episode), risk: { level: 'none' }, provider: 'ir-fake', dropped: [] }),
      render: async (episode, options) => ({ outPath: options.outPath, seconds: 1, duration: 24 }) });
    await bot.handleUpdate(message());
    const play = sent.findLast((x) => x.extra?.reply_markup?.inline_keyboard)?.extra.reply_markup.inline_keyboard[0][0].callback_data;
    assert.ok(play);
    fs.mkdir = async function (p, options) {
      if (hold && p === dir) { hold = false; entered.resolve(); await release.promise; }
      return originalMkdir.call(fs, p, options);
    };
    hold = true;
    active = bot.handleUpdate(click(play));
    await entered.promise; // запись допущена и остановлена на mkdir
    await bot.handleUpdate(message('/delete'));
    assert.equal(bot.sessions.size, 0);
    assert.equal(await fs.readFile(file, 'utf8').catch(() => ''), '');
    release.resolve();
    await active;
    const own = (await rows(file)).filter((x) => x.user === metrics.hash(chat.id));
    assert.equal(own.length, 0, 'завершённый /delete не даёт старой записи вернуться');
  } finally {
    release.resolve();
    if (active) await active;
    fs.mkdir = originalMkdir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ИР-06: forget не теряет строки другого человека и не мешает новой сессии', async () => {
  const dir = await tmp('titry-ir-other-');
  try {
    const file = path.join(dir, 'metrics.jsonl');
    const m = makeMetrics(file, 'ir-synthetic-salt');
    await m.log(1, 'start');
    // Запись другого человека и forget первого стартуют одновременно: обе должны сохранить смысл.
    await Promise.all([m.log(2, 'start'), m.forget(1), m.log(2, 'render')]);
    let r = await rows(file);
    assert.deepEqual(r.map((x) => x.user === m.hash(2)), [true, true]);
    // Новая сессия того же человека после удаления пишет только свои новые события.
    await m.log(1, 'start');
    r = await rows(file);
    assert.equal(r.filter((x) => x.user === m.hash(1)).length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
