// gate.probe — разовая проверка короткого текста в боте (PR 15). Только вымышленные слова.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGate } from '../server/gate.js';

const S = 'chat:1';
const fail = () => { throw Object.assign(new Error('сбой'), { code: 'incomplete_response' }); };
function fakeLedger() {
  const puts = []; let ok = true;
  return {
    puts, setOk: (v) => { ok = v; },
    lookup: () => (ok ? { kind: null } : { failed: true }),
    put: async (r) => { puts.push(r.kind); },
    flush: async () => ok,
    clearTechnical: async () => {}, scopeKinds: () => [],
  };
}

test('probe: сбои не двигают счётчик и не ставят техническую паузу (ни в памяти, ни в хранилище)', async () => {
  const ledger = fakeLedger();
  const g = makeGate({ check: fail, ledger });
  for (let i = 0; i < 4; i++) assert.deepEqual(await g.probe(S, 'Привет', 'Привет'), { unavailable: true, code: 'incomplete_response' });
  assert.equal(g.status(S, 'Привет').kind, null);
  assert.deepEqual(ledger.puts, []);
});

test('probe: опасно → обычная остановка (в памяти и в хранилище); дальше — остановка без проверки', async () => {
  const ledger = fakeLedger(); let n = 0;
  const g = makeGate({ check: () => { n++; return true; }, ledger });
  assert.deepEqual(await g.probe(S, 'Слово', 'Слово'), { kind: 'safety', byModel: true });
  assert.equal(g.status(S, 'Слово').kind, 'safety');
  assert.deepEqual(ledger.puts, ['safety']);
  assert.deepEqual(await g.probe(S, 'Слово', 'Слово'), { kind: 'safety', byModel: false });
  assert.equal(n, 1);
});

test('probe: остановка, пришедшая во время проверки, сильнее ответа «безопасно» и сбоя', async () => {
  for (const answer of [() => false, fail]) {
    let g;
    g = makeGate({ check: async (t) => { g.markSafety(S, t); return answer(); } });
    assert.equal((await g.probe(S, 'Слово', 'Слово')).kind, 'safety');
  }
});

test('probe: хранилище недоступно до или после проверки — не «безопасно»', async () => {
  const before = fakeLedger(); before.setOk(false);
  const g1 = makeGate({ check: () => false, ledger: before });
  assert.equal((await g1.probe(S, 'Привет', 'Привет')).ok, undefined);
  const after = fakeLedger();
  const g2 = makeGate({ check: () => { after.setOk(false); return false; }, ledger: after });
  assert.deepEqual(await g2.probe(S, 'Привет', 'Привет'), { unavailable: true, code: 'ledger' });
});

test('probe: нет ключа — unavailable, проверка не вызывается; ответ не true/false — не «безопасно»', async () => {
  let n = 0;
  const g = makeGate({ check: () => { n++; return false; }, hasKey: () => false });
  assert.deepEqual(await g.probe(S, 'Привет', 'Привет'), { unavailable: true, code: 'no_key' });
  assert.equal(n, 0);
  const g2 = makeGate({ check: () => 'да' });
  assert.deepEqual(await g2.probe(S, 'Привет', 'Привет'), { unavailable: true, code: 'bad_response' });
  const g3 = makeGate({ check: () => false });
  assert.deepEqual(await g3.probe(S, 'Привет', 'Привет'), { ok: true });
});
