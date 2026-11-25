// Проверка состояния бота (Б6 п. 5; план Критика реализации 20.11, п. 5): различение «процесс жив», «обновления
// поступают», «состояние доступно»; в снимке нет номеров чатов, текстов и ключей; внешних отправок нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeHealth, writeHealth, POLL_STALE_MS } from '../server/health.js';

test('состояния: до первого опроса — starting; успешный опрос — fresh; давно без успеха — stale; сбои подряд считаются и сбрасываются', () => {
  let t = 1_000_000;
  const h = makeHealth({ now: () => t });
  assert.equal(h.snapshot({ stateHealthy: true }).updates, 'starting');
  h.pollOk();
  assert.equal(h.snapshot({ stateHealthy: true }).updates, 'fresh');
  h.pollFailed(); h.pollFailed();
  t += POLL_STALE_MS + 1;
  const s = h.snapshot({ stateHealthy: false });
  assert.deepEqual([s.updates, s.state, s.poll_failures, s.process], ['stale', 'failed', 2, 'alive']);
  h.pollOk();
  assert.deepEqual([h.snapshot({ stateHealthy: true }).updates, h.snapshot({ stateHealthy: true }).poll_failures], ['fresh', 0]);
});

test('файл снимка: только время, состояния и счётчик; права 0600; запись атомарная (без остатков tmp)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-health-'));
  const file = path.join(dir, 'data', 'health.json');
  const h = makeHealth({ now: () => Date.parse('2026-11-25T05:00:00Z') });
  h.pollOk();
  await writeHealth(file, h.snapshot({ stateHealthy: true }));
  const snap = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(snap).sort(), ['at', 'poll_failures', 'process', 'state', 'updates']);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['health.json']);
});
