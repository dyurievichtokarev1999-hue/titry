// Аудит 17.11, п. 2: бот и монтажная с одним файлом запретов затирали остановки друг друга (каждый процесс держит
// записи в памяти и переписывает файл целиком). Ключ тестовый, рассказы вымышленные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeLedger, processLedger, LEDGER_FILES } from '../server/ledger.js';

const opts = { key: 'test-only-key-not-a-secret', keyVersion: 'v1' };
const A = 'Вымышленный рассказ А для бота.';
const B = 'Вымышленный рассказ Б для монтажной.';

test('остановка бота (A) и монтажной (B), записанные из двух запущенных процессов, переживают перезапуск обоих', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-2p-'));
  try {
    const bot = processLedger('bot', dir, opts); await bot.load();
    const studio = processLedger('studio', dir, opts); await studio.load();
    await bot.put({ scope: 'chat-scope', story: A, kind: 'safety', reason: 'safety' });
    await studio.put({ scope: 'studio', story: B, kind: 'safety', reason: 'safety' });
    const bot2 = processLedger('bot', dir, opts); await bot2.load();
    const studio2 = processLedger('studio', dir, opts); await studio2.load();
    assert.equal(bot2.lookup('chat-scope', A).kind, 'safety', 'A после перезапуска');
    assert.equal(studio2.lookup('studio', B).kind, 'safety', 'B после перезапуска');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('остановка монтажной в прежнем общем файле не пропадает после перехода на отдельный файл', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-2p-'));
  try {
    const old = makeLedger({ file: path.join(dir, LEDGER_FILES.bot), ...opts }); await old.load();
    await old.put({ scope: 'studio', story: B, kind: 'safety', reason: 'safety' });
    const studio = processLedger('studio', dir, opts); await studio.load();
    assert.equal(studio.lookup('studio', B).kind, 'safety');
    // Повреждённый файл бота — закрытый отказ и для монтажной, не пустой набор.
    await fs.writeFile(path.join(dir, LEDGER_FILES.bot), '{');
    await assert.rejects(processLedger('studio', dir, opts).load(), { code: 'ledger' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
