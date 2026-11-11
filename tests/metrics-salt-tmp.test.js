// Соль метрик обязательна; стартовая очистка data/tmp бота (решение Claude 11.11, опись копий метрик).
// Соли, ключи и рассказы — тестовые, вымышленные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeMetrics, prepareBot, purgeBotTmp } from '../server/bot.js';

const okLedger = { load: async () => {} };
const SALT = 'test-only-salt-not-a-secret';
const withDir = async (fn) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-mst-')); try { await fn(d); } finally { await fs.rm(d, { recursive: true, force: true }); } };

test('makeMetrics без соли — отказ; запасной публичной соли нет; режим разработки — только явным флагом', async () => {
  const prev = { s: process.env.METRICS_SALT, d: process.env.TITRY_DEV_METRICS };
  try {
    delete process.env.METRICS_SALT; delete process.env.TITRY_DEV_METRICS;
    assert.throws(() => makeMetrics('/nonexistent/m.jsonl'), { code: 'metrics_salt' });
    process.env.TITRY_DEV_METRICS = '1';
    const a = makeMetrics('/nonexistent/m.jsonl'); const b = makeMetrics('/nonexistent/m.jsonl');
    assert.notEqual(a.hash(1), b.hash(1), 'в режиме разработки соль случайная на процесс, не общая');
    assert.notEqual(a.hash(1), makeMetrics('/x', 'titry-dev-salt').hash(1));
  } finally {
    if (prev.s === undefined) delete process.env.METRICS_SALT; else process.env.METRICS_SALT = prev.s;
    if (prev.d === undefined) delete process.env.TITRY_DEV_METRICS; else process.env.TITRY_DEV_METRICS = prev.d;
  }
});

test('prepareBot: нет соли или короче 16 знаков — отказ до очистки и хранилища; с солью — порядок прежний', async () => {
  let touched = 0;
  const spy = async () => { touched++; return 0; };
  for (const env of [{}, { METRICS_SALT: '' }, { METRICS_SALT: 'short-salt' }]) {
    await assert.rejects(prepareBot({ env, cleanupTmp: spy, cleanup: spy, ledger: { load: spy } }), { stage: 'metrics.salt', code: 'metrics_salt' });
  }
  assert.equal(touched, 0);
  assert.equal(await prepareBot({ env: { METRICS_SALT: SALT }, cleanupTmp: async () => 0, cleanup: async () => 0, ledger: okLedger }), okLedger);
});

test('purgeBotTmp: удаляет *.mp4 и ссылки *.mp4 (цели целы), не трогает прочее и подкаталоги; нет каталога — 0', async () => {
  await withDir(async (d) => {
    const tmp = path.join(d, 'tmp'); await fs.mkdir(tmp);
    const foreign = path.join(d, 'foreign'); await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign, 'keep.mp4'), 'чужое');
    await fs.writeFile(path.join(tmp, 'abcdef0123456789-1.mp4'), 'x');
    await fs.writeFile(path.join(tmp, 'b.mp4'), 'x');
    await fs.symlink(path.join(foreign, 'keep.mp4'), path.join(tmp, 'link.mp4'));
    await fs.writeFile(path.join(tmp, 'note.txt'), 'x');
    await fs.mkdir(path.join(tmp, 'sub.mp4'));
    assert.equal(await purgeBotTmp(tmp), 3);
    assert.deepEqual((await fs.readdir(tmp)).sort(), ['note.txt', 'sub.mp4']);
    assert.equal(await fs.readFile(path.join(foreign, 'keep.mp4'), 'utf8'), 'чужое');
    assert.equal(await purgeBotTmp(path.join(d, 'нет')), 0);
  });
});

test('purgeBotTmp: data/tmp — ссылка или файл — ошибка, ничего не удалено; prepareBot останавливает запуск', async () => {
  await withDir(async (d) => {
    const foreign = path.join(d, 'foreign'); await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign, 'keep.mp4'), 'чужое');
    const link = path.join(d, 'tmp-link'); await fs.symlink(foreign, link);
    await assert.rejects(purgeBotTmp(link), { code: 'EACCES' });
    assert.deepEqual(await fs.readdir(foreign), ['keep.mp4']);
    const file = path.join(d, 'tmp-file'); await fs.writeFile(file, 'x');
    await assert.rejects(purgeBotTmp(file), { code: 'ENOTDIR' });
    let ledgerLoaded = false;
    await assert.rejects(prepareBot({ env: { METRICS_SALT: SALT }, cleanupTmp: () => purgeBotTmp(link), cleanup: async () => 0, ledger: { load: async () => { ledgerLoaded = true; } } }), { stage: 'tmp.cleanup' });
    assert.equal(ledgerLoaded, false, 'задачи не принимаются: дальше очистки запуск не идёт');
  });
});

test('prepareBot: в журнал очистки — только этап и число, без путей и имён файлов', async () => {
  const lines = [];
  await prepareBot({ env: { METRICS_SALT: SALT }, cleanupTmp: async () => 2, cleanup: async () => 0, ledger: okLedger, log: (l) => lines.push(l) });
  const rows = lines.map((l) => JSON.parse(l));
  assert.deepEqual(rows.map(({ stage, removed, level }) => ({ stage, removed, level })), [{ stage: 'tmp.cleanup', removed: 2, level: 'info' }]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'level', 'removed', 'stage']);
});

test('бот без METRICS_SALT: процесс завершается с кодом 3 до обращения к Telegram', { timeout: 30000 }, async () => {
  const { spawn } = await import('node:child_process');
  const env = { ...process.env, TELEGRAM_BOT_TOKEN: '0:test-not-a-token', TITRY_BLOCKED_HMAC_KEY: 'test-only-key-not-a-secret', HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9' };
  delete env.METRICS_SALT; delete env.TITRY_DEV_METRICS;
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL('../server/bot.js', import.meta.url).pathname], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (x) => { out += x; }); p.stderr.on('data', (x) => { err += x; });
    const t = setTimeout(() => p.kill('SIGKILL'), 20000);
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
  assert.equal(r.code, 3);
  assert.match(r.err, /"stage":"metrics\.salt","code":"metrics_salt"/);
  assert.doesNotMatch(r.out, /запущен/);
});

test('замечания разбора: граница 15/16 знаков, соль из пробелов, порядок очисток, похожие имена не удаляются', async () => {
  const ok = async (salt) => prepareBot({ env: { METRICS_SALT: salt }, cleanupTmp: async () => 0, cleanup: async () => 0, ledger: okLedger, log: () => {} });
  await assert.rejects(ok('a'.repeat(15)), { code: 'metrics_salt' });
  await assert.rejects(ok(' '.repeat(20)), { code: 'metrics_salt' });
  assert.equal(await ok('a'.repeat(16)), okLedger);
  let tmpTouched = false;
  await assert.rejects(prepareBot({ env: { METRICS_SALT: SALT }, cleanup: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }, cleanupTmp: async () => { tmpTouched = true; return 0; }, ledger: okLedger }), { stage: 'voice.cleanup' });
  assert.equal(tmpTouched, false, 'при сбое очистки голосовых data/tmp не трогается');
  await withDir(async (d) => {
    for (const n of ['a.MP4', 'b.mp4.part', 'c.mp4x', 'keep.txt']) await fs.writeFile(path.join(d, n), 'x');
    assert.equal(await purgeBotTmp(d), 0);
    assert.equal((await fs.readdir(d)).length, 4);
  });
  const prev = { s: process.env.METRICS_SALT, d: process.env.TITRY_DEV_METRICS };
  try {
    process.env.TITRY_DEV_METRICS = '1';
    assert.equal(makeMetrics('/x', SALT).hash(7), makeMetrics('/y', SALT).hash(7), 'явная соль флагом разработки не подменяется');
  } finally {
    if (prev.d === undefined) delete process.env.TITRY_DEV_METRICS; else process.env.TITRY_DEV_METRICS = prev.d;
  }
});
