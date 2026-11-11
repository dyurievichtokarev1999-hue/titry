// Параллельные решения по одному рассказу в одной области (сверка 5cffcd11, разбор afaf073):
// «безопасно» не выдаётся, пока не решены все открытые к этому моменту решения того же рассказа
// (отдельные проверки с входа в verify и черновики через holdDraft); ожидание ограничено по времени.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGate } from '../server/gate.js';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));
const S = 'вымышленный рассказ';

test('две одновременные проверки «безопасно» обе получают ok и не ждут друг друга бесконечно', async () => {
  const gate = makeGate({ check: async () => false });
  const [a, b] = await Promise.all([gate.verify('x', S, null, S), gate.verify('x', S, null, S)]);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
});

test('сосед ещё проверяет: «безопасно» ждёт его; сосед сказал «опасно» → обе safety', async () => {
  const d = deferred(); let n = 0;
  const gate = makeGate({ check: () => (++n === 1 ? d.promise : false) });
  const first = gate.verify('x', S, null, S);
  await tick();
  let secondDone = false;
  const second = gate.verify('x', S, null, S).then((r) => { secondDone = true; return r; });
  await tick(); await tick();
  assert.equal(secondDone, false, 'вторая ждёт решения первой');
  d.resolve(true);
  assert.equal((await first).kind, 'safety');
  assert.equal((await second).kind, 'safety');
});

test('сосед завис: ожидание ограничено — unavailable check_pending, а не ok', async () => {
  const d = deferred(); let n = 0;
  const gate = makeGate({ check: () => (++n === 1 ? d.promise : false), neighborWaitMs: 30 });
  const first = gate.verify('x', S, null, S);
  await tick();
  const second = await gate.verify('x', S, null, S);
  assert.deepEqual(second, { unavailable: true, code: 'check_pending' });
  d.resolve(true);
  assert.equal((await first).kind, 'safety');
  assert.equal(gate.status('x', S).kind, 'safety');
});

test('другой рассказ и другая область не ждут', async () => {
  const d = deferred(); let n = 0;
  const gate = makeGate({ check: () => (++n === 1 ? d.promise : false), neighborWaitMs: 60_000 });
  const first = gate.verify('x', S, null, S);
  await tick();
  assert.equal((await gate.verify('x', 'другой рассказ', null, 'другой')).ok, true);
  assert.equal((await gate.verify('y', S, null, S)).ok, true);
  d.resolve(false);
  assert.equal((await first).ok, true);
  // После завершения всех решений новая проверка не ждёт (набор решений пуст).
  assert.equal((await gate.verify('x', S, null, S)).ok, true);
});

test('черновик того же рассказа ещё пишется: «безопасно» его ждёт; генератор вернул остановку → safety', async () => {
  const gate = makeGate({ check: async () => false });
  const d = deferred();
  const held = gate.holdDraft('x', S, d.promise);
  let done = false;
  const v = gate.verify('x', S, null, S, { includeDrafts: true }).then((r) => { done = true; return r; });
  await tick(); await tick();
  assert.equal(done, false);
  d.resolve({ episode: null, risk: { level: 'urgent' }, provider: 'claude' });
  assert.equal((await held).episode, null);
  assert.equal((await v).kind, 'safety');
});

test('черновик с эпизодом, нехваткой или недоступностью остановку не ставит', async () => {
  for (const r of [{ episode: {}, risk: { level: 'none' } }, { insufficient: true, episode: null, risk: { level: 'concern' } }, { unavailable: true, episode: null }]) {
    const gate = makeGate({ check: async () => false });
    const v = gate.verify('x', S, null, S, { includeDrafts: true });
    await gate.holdDraft('x', S, Promise.resolve(r));
    assert.equal((await v).ok, true, JSON.stringify(r));
    assert.equal(gate.status('x', S).kind, null);
  }
});

test('сбой черновика закрывает решение: соседняя проверка не висит', async () => {
  const gate = makeGate({ check: async () => false, neighborWaitMs: 60_000 });
  const d = deferred();
  const held = gate.holdDraft('x', S, d.promise).catch(() => 'упал');
  const v = gate.verify('x', S, null, S, { includeDrafts: true });
  d.resolve(Promise.reject(new Error('сбой')));
  assert.equal(await held, 'упал');
  assert.equal((await v).ok, true);
});

test('рендер (verify без includeDrafts) черновик соседа не ждёт — прежнее поведение', async () => {
  const gate = makeGate({ check: async () => false });
  const d = deferred();
  gate.holdDraft('x', S, d.promise);
  assert.equal((await gate.verify('x', S, null, S)).ok, true);
  d.resolve({ episode: {}, risk: { level: 'none' } });
});
