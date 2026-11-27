// План Критика реализации 20.11, п. 5: отличить первый запуск от пропажи файла запретов после записи.
// Пропал файл — закрытый отказ (ledger_missing), а не молчаливый старт с пустым хранилищем. Только вымышленные данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { processLedger } from '../server/ledger.js';
import { prepareBot } from '../server/bot.js';

const KEY = 'test-key-fictional-000001';
const dirOf = async () => fs.mkdtemp(path.join(os.tmpdir(), 'titry-ledger-missing-'));

test('первый запуск без файла — работает; после записи файл пропал — отказ ledger_missing; метка пустая', async () => {
  const dir = await dirOf();
  const a = processLedger('bot', dir, { key: KEY });
  await a.load(); // первый запуск
  assert.equal(a.healthy(), true);
  await a.load(); // и повторный без записей — тоже первый запуск по сути
  await a.put({ scope: 'chat-fictional', story: 'вымышленный рассказ для проверки', kind: 'safety', reason: 'safety' });
  assert.equal(await fs.readFile(path.join(dir, 'blocked-v1.json.init'), 'utf8'), '', 'метка без данных');
  await fs.rm(path.join(dir, 'blocked-v1.json'));
  const b = processLedger('bot', dir, { key: KEY });
  await assert.rejects(b.load(), { code: 'ledger_missing' });
  assert.equal(b.healthy(), false, 'выдача закрыта');
});

test('старт бота: файл запретов пропал после записи — отказ ledger_missing до приёма сообщений', async () => {
  const dir = await dirOf();
  const l = processLedger('bot', dir, { key: KEY });
  await l.load();
  await l.put({ scope: 'chat-fictional', story: 'вымышленный рассказ для проверки', kind: 'safety', reason: 'safety' });
  await fs.rm(path.join(dir, 'blocked-v1.json'));
  const env = { METRICS_SALT: 'test-salt-fictional-0001', ANTHROPIC_API_KEY: 'dummy-not-a-key' };
  await assert.rejects(prepareBot({ env, log: () => {}, checkRender: async () => {}, cleanup: async () => {}, cleanupTmp: async () => 0, ledger: processLedger('bot', dir, { key: KEY }) }),
    { code: 'ledger_missing', stage: 'ledger.load' });
});

test('файл был до этой версии (без метки): загрузка ставит метку — дальше пропажа файла заметна', async () => {
  const dir = await dirOf();
  const a = processLedger('bot', dir, { key: KEY });
  await a.load();
  await a.put({ scope: 'chat-fictional', story: 'вымышленный рассказ для проверки', kind: 'safety', reason: 'safety' });
  await fs.rm(path.join(dir, 'blocked-v1.json.init')); // как на развёрнутом боте до обновления
  await processLedger('bot', dir, { key: KEY }).load();
  await fs.rm(path.join(dir, 'blocked-v1.json'));
  await assert.rejects(processLedger('bot', dir, { key: KEY }).load(), { code: 'ledger_missing' });
});

test('монтажная: файл бота пропал после записи — отказ ledger_missing, а не старт без остановок бота', async () => {
  const dir = await dirOf();
  const bot = processLedger('bot', dir, { key: KEY });
  await bot.load();
  await bot.put({ scope: 'studio', story: 'вымышленный рассказ для проверки', kind: 'safety', reason: 'safety' });
  await fs.rm(path.join(dir, 'blocked-v1.json'));
  await assert.rejects(processLedger('studio', dir, { key: KEY }).load(), { code: 'ledger_missing' });
});

test('метка есть, файла нет, но остался целый tmp — восстановление, а не отказ', async () => {
  const dir = await dirOf();
  const a = processLedger('bot', dir, { key: KEY });
  await a.load();
  await a.put({ scope: 'chat-fictional', story: 'вымышленный рассказ для проверки', kind: 'safety', reason: 'safety' });
  await fs.rename(path.join(dir, 'blocked-v1.json'), path.join(dir, 'blocked-v1.json.tmp-1-abcd')); // авария до rename
  const b = processLedger('bot', dir, { key: KEY });
  await b.load();
  assert.equal(b.lookup('chat-fictional', 'вымышленный рассказ для проверки').kind, 'safety', 'остановка восстановлена');
});
