// Хранилище запретов, подключённое к монтажной: приёмка B01–B04 плана архитектора v1.1 на настоящем createApp.
// «Перезапуск» — новый createApp с новым шлюзом и заново загруженным хранилищем из того же файла.
// Часы, проверка и рендер подставные; ключ тестовый; рассказ вымышленный (examples/day-quiet.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { makeLedger } from '../server/ledger.js';
import { RETRY_AFTER_MS } from '../server/gate.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const ep = () => structuredClone(ex.episode);
const STORY = ex.story;
const KEY = 'test-only-key-not-a-secret';
const OTHER = `${STORY} Вечером пила чай.`; // другой рассказ, источники строк эпизода в нём есть
const fail = () => { throw Object.assign(new Error('x'), { code: 'incomplete_response' }); };

async function boot(dir, { check, clock, key = KEY, fsImpl } = {}) {
  const ledger = makeLedger({ file: path.join(dir, 'state', 'blocked-v1.json'), key, keyVersion: 'v1', wallNow: () => clock.wall, ...(fsImpl ? { fsImpl } : {}) });
  try { await ledger.load(); } catch { /* закрытый отказ проверяется ниже */ }
  const counters = { render: 0, check: 0 };
  const server = createApp({
    dataDir: dir, ledger,
    safetyCheck: async (t) => { counters.check++; return check(t, counters.check); },
    monoNow: () => clock.mono, wallNow: () => clock.wall,
    render: async (e, o) => { counters.render++; return { seconds: 1, outPath: o.outPath }; },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return {
    counters, ledger,
    render: (story = STORY, episode = ep()) => post('/api/render', { story, episode }),
    recheck: (story = STORY, episode = ep()) => post('/api/recheck', { story, episode }),
    draft: (story = STORY) => post('/api/draft', { story }),
    close: async () => { server.closeAllConnections(); server.close(); },
  };
}

const withDir = async (fn) => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-ls-')); try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); } };
const clockAt = () => ({ mono: 1_000, wall: Date.parse('2026-11-10T12:00:00Z') });

test('B01: safety → «аварийный» перезапуск → тот же рассказ и варианты регистра/ё/пробелов — stop, render 0', async () => {
  await withDir(async (dir) => {
    const clock = clockAt();
    const a = await boot(dir, { check: () => true, clock });
    assert.equal((await a.render()).body.kind, 'safety');
    await a.ledger.flush(); await a.close();
    const b = await boot(dir, { check: () => false, clock: { mono: 0, wall: clock.wall } });
    for (const v of [STORY, STORY.toUpperCase(), ` ${STORY.replace(/\s+/g, '  ')} `, STORY.replace(/е/g, 'ё')]) {
      const r = await b.render(v);
      assert.equal(r.status, 422); assert.equal(r.body.kind, 'safety');
    }
    assert.equal((await b.draft()).body.kind, 'safety');
    assert.equal(b.counters.check, 0); assert.equal(b.counters.render, 0);
    await b.close();
  });
});

test('B02: technical → перезапуск → повтор раньше 15 мин запрещён, после 15 мин без действия всё ещё запрещён, действие — полная проверка', async () => {
  await withDir(async (dir) => {
    const clock = clockAt();
    const a = await boot(dir, { check: fail, clock });
    await a.render(); assert.equal((await a.render()).body.kind, 'technical');
    await a.ledger.flush(); await a.close();
    // Перезапуск через 14 минут: монотонные часы нового процесса начинаются заново.
    const c2 = { mono: 0, wall: clock.wall + 14 * 60_000 };
    let mode = 'fail';
    const b = await boot(dir, { check: () => (mode === 'fail' ? fail() : false), clock: c2 });
    assert.equal((await b.render()).body.kind, 'technical');
    const early = await b.recheck();
    assert.equal(early.body.early, true);
    assert.ok(Date.parse(early.body.retryNotBeforeAt) >= c2.wall + RETRY_AFTER_MS, 'отсчёт после перезапуска — не раньше загрузки + 15 мин');
    c2.mono += RETRY_AFTER_MS - 1; c2.wall += RETRY_AFTER_MS - 1;
    assert.equal((await b.recheck()).body.early, true);
    c2.mono += 1; c2.wall += 1;
    assert.equal((await b.render()).body.kind, 'technical', 'срок сам ничего не снимает');
    assert.equal(b.counters.check, 0);
    mode = 'ok';
    assert.equal((await b.recheck()).status, 200);
    await b.close();
    // Снятие записано: следующий перезапуск паузы не видит.
    const c = await boot(dir, { check: () => false, clock: c2 });
    assert.equal((await c.render()).status, 200);
    assert.equal(c.counters.render, 1);
    await c.close();
  });
});

test('B03: поздний false, правка эпизода и плёнки не снимают safety после перезапуска', async () => {
  await withDir(async (dir) => {
    const clock = clockAt();
    const a = await boot(dir, { check: () => true, clock });
    await a.render(); await a.ledger.flush(); await a.close();
    const b = await boot(dir, { check: () => false, clock });
    const e = ep(); e.mood = 'warm'; e.music = 'warm'; e.title = 'Другое название';
    assert.equal((await b.render(STORY, e)).body.kind, 'safety');
    assert.equal(b.counters.check, 0); assert.equal(b.counters.render, 0);
    await b.close();
  });
});

test('B04: неверный ключ, повреждённый файл, сбой записи — нет выдачи (503 ledger), нет ложного успеха', async () => {
  await withDir(async (dir) => {
    const clock = clockAt();
    const a = await boot(dir, { check: () => true, clock });
    await a.render(); await a.ledger.flush(); await a.close();
    const wrong = await boot(dir, { check: () => false, clock, key: 'другой-тестовый' });
    for (const s of [STORY, OTHER]) {
      const r = await wrong.render(s);
      assert.equal(r.status, 503); assert.equal(r.body.code, 'ledger');
    }
    assert.equal(wrong.counters.render, 0); assert.equal(wrong.counters.check, 0);
    await wrong.close();
    await fs.writeFile(path.join(dir, 'state', 'blocked-v1.json'), '{"oops":');
    const broken = await boot(dir, { check: () => false, clock });
    assert.equal((await broken.render()).body.code, 'ledger');
    assert.equal((await broken.draft()).body.code, 'ledger');
    assert.equal(broken.counters.render, 0);
    await broken.close();
  });
  await withDir(async (dir) => {
    const failing = { ...fs, rename: async () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } };
    const b = await boot(dir, { check: () => true, clock: clockAt(), fsImpl: failing });
    assert.equal((await b.render()).body.kind, 'safety', 'остановка в памяти действует сразу');
    await b.ledger.flush();
    const other = await b.render(OTHER);
    assert.equal(other.status, 503); assert.equal(other.body.code, 'ledger', 'без подтверждённой записи выдачи нет');
    assert.equal(b.counters.render, 0);
    await b.close();
  });
});
