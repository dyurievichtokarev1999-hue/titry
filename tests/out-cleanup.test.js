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
