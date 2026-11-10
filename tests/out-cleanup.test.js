// Ролики удаляются после отправки (правило базы), страховка — автоочистка через 2 часа.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, purgeOut, OUT_MAX_AGE_MS } from '../server/app.js';

test('автоочистка удаляет только файлы старше 2 часов', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-out-'));
  await fs.writeFile(path.join(dir, 'old.mp4'), 'x');
  await fs.writeFile(path.join(dir, 'new.mp4'), 'x');
  const old = new Date(Date.now() - OUT_MAX_AGE_MS - 1000);
  await fs.utimes(path.join(dir, 'old.mp4'), old, old);
  assert.equal(await purgeOut(dir), 1);
  assert.deepEqual(await fs.readdir(dir), ['new.mp4']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('кнопка «Отправлено» удаляет видео и постер; чужие пути отклоняются', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-out-app-'));
  const server = createApp({ render: async () => ({}), dataDir, safetyCheck: async () => false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await new Promise((r) => setTimeout(r, 50)); // стартовая очистка
  const out = path.join(dataDir, 'out');
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, '2026-11-07-p01-abc123.mp4'), 'x');
  await fs.writeFile(path.join(out, '2026-11-07-p01-abc123.jpg'), 'x');
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/out/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ video: '/out/../../package.json' })).status, 400);
    assert.equal((await post({ video: '/out/2026-11-07-p01-abc123.mp4' })).status, 200);
    assert.deepEqual(await fs.readdir(out), []);
  } finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('B09.6 монтажная: строгая стартовая очистка — ошибка не скрывается; нет каталога — не ошибка', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-out-strict-'));
  try {
    const notDir = path.join(base, 'file');
    await fs.writeFile(notDir, 'x');
    await assert.rejects(purgeOut(notDir, 0, Date.now(), { strict: true }), { code: 'ENOTDIR' });
    assert.equal(await purgeOut(notDir, 0), 0, 'фоновая очистка остаётся тихой');
    assert.equal(await purgeOut(path.join(base, 'нет'), 0, Date.now(), { strict: true }), 0);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('B09.6 монтажная: ошибка стартовой очистки — запуск остановлен до приёма задач, код ≠ 0, путей в журнале нет', { timeout: 30000 }, async () => {
  // Копия монтажной во временном корне, где data/out — файл (ENOTDIR), а хранилище запретов исправно.
  const { spawn } = await import('node:child_process');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-studio-entry-'));
  try {
    const repo = new URL('..', import.meta.url).pathname;
    // server/ и engine/ — копии (по ссылке Node взял бы настоящий корень репозитория и его data/);
    // остальное — ссылки только для чтения.
    for (const d of ['server', 'engine']) await fs.cp(path.join(repo, d), path.join(root, d), { recursive: true });
    for (const d of ['studio', 'config', 'brand', 'examples', 'assets', 'node_modules']) {
      await fs.symlink(path.join(repo, d), path.join(root, d)).catch(() => {});
    }
    await fs.copyFile(path.join(repo, 'package.json'), path.join(root, 'package.json'));
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'data', 'out'), 'не каталог');
    const run = () => new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(root, 'server', 'app.js')], {
        env: { ...process.env, PORT: '0', TITRY_BLOCKED_HMAC_KEY: 'test-only-key-not-a-secret', TITRY_BLOCKED_KEY_VERSION: 'v-entry-test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => p.kill('SIGKILL'), 15000);
      p.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    });
    const r = await run();
    assert.equal(r.code, 3);
    assert.doesNotMatch(r.out, /Монтажная: http/, 'сервер не начал слушать');
    assert.match(r.err, /"stage":"out\.cleanup","code":"ENOTDIR"/);
    assert.ok(!r.err.includes(root), 'путей в журнале нет');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
