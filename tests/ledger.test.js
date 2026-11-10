// Хранилище запретов (план архитектора v1.1, разд. 2–6; приёмка B01/B04/B05 в части модуля).
// Ключи — тестовые, вымышленные; рассказ — вымышленный (examples/day-quiet.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeLedger } from '../server/ledger.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const STORY = ex.story;
const KEY = 'test-only-key-not-a-secret';

async function tmpDir() { return fs.mkdtemp(path.join(os.tmpdir(), 'titry-ledger-')); }
const open = (dir, extra = {}) => makeLedger({ file: path.join(dir, 'state', 'blocked-v1.json'), key: KEY, keyVersion: 'k1', ...extra });

test('B01: safety переживает перезапуск; регистр/ё/пробелы — тот же запрет; другая область не затронута', async () => {
  const dir = await tmpDir();
  try {
    const a = open(dir); await a.load();
    await a.put({ scope: 'studio', story: STORY, kind: 'safety', reason: 'safety' });
    const b = open(dir); await b.load();
    assert.equal(b.lookup('studio', STORY).kind, 'safety');
    assert.equal(b.lookup('studio', `  ${STORY.toUpperCase().replace(/Е/g, 'Ё')}  `).kind, 'safety');
    assert.equal(b.lookup('other', STORY).kind, null);
    assert.equal(b.lookup('studio', STORY + ' Другое.').kind, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('B05: на диске нет рассказа, области и ключа; права 0700/0600; остатков tmp нет', async () => {
  const dir = await tmpDir();
  try {
    const l = open(dir); await l.load();
    await l.put({ scope: 'chat-123456', story: STORY, episodeDigest: 'a'.repeat(64), kind: 'technical', reason: 'check_incomplete_twice', retryNotBeforeAt: '2026-11-10T12:15:00.000Z' });
    const file = path.join(dir, 'state', 'blocked-v1.json');
    const raw = await fs.readFile(file, 'utf8');
    for (const s of [STORY.slice(0, 12), 'chat-123456', '123456', KEY, 'a'.repeat(64)]) assert.ok(!raw.includes(s), `нет ${s.slice(0, 8)}…`);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.deepEqual(await fs.readdir(path.dirname(file)), ['blocked-v1.json']);
    const doc = JSON.parse(raw);
    assert.deepEqual(Object.keys(doc.records[0]).sort(), ['created_at', 'episode_digest', 'expires_at', 'key_version', 'kind', 'reason', 'retry_not_before_at', 'schema_version', 'scope_digest', 'story_digest']);
    assert.equal(doc.records[0].expires_at, null, 'производственный TTL не выбран — без срока');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('B04: повреждённый файл, неверный ключ, неверная версия, нет ключа — закрытый отказ, не пустой набор', async () => {
  const dir = await tmpDir();
  try {
    const l = open(dir); await l.load();
    await l.put({ scope: 'studio', story: STORY, kind: 'safety', reason: 'safety' });
    for (const [name, extra] of [['ключ', { key: 'другой' }], ['версия', { keyVersion: 'k2' }], ['нет ключа', { key: '' }]]) {
      const x = open(dir, extra);
      await assert.rejects(x.load(), { code: 'ledger' }, name);
      assert.equal(x.healthy(), false, name);
      assert.equal(x.lookup('studio', STORY).failed, true, name);
    }
    const file = path.join(dir, 'state', 'blocked-v1.json');
    for (const bad of ['{', '[]', '{"schema_version":2}', JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), records: [{ kind: 'safety' }] })]) {
      await fs.writeFile(file, bad);
      const x = open(dir);
      await assert.rejects(x.load(), { code: 'ledger' }, bad.slice(0, 20));
      assert.equal(x.lookup('studio', STORY).failed, true);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('B04: недописанный tmp после аварии — закрытый отказ; целый tmp — восстановление объединением', async () => {
  const dir = await tmpDir();
  try {
    const l = open(dir); await l.load();
    await l.put({ scope: 'studio', story: 'первый вымышленный рассказ', kind: 'safety', reason: 'safety' });
    const sdir = path.join(dir, 'state');
    const good = await fs.readFile(path.join(sdir, 'blocked-v1.json'), 'utf8');
    // Целый tmp с дополнительной записью (rename не успел): запись восстанавливается.
    const l2 = open(dir); await l2.load();
    await l2.put({ scope: 'studio', story: STORY, kind: 'safety', reason: 'safety' });
    const withTwo = await fs.readFile(path.join(sdir, 'blocked-v1.json'), 'utf8');
    await fs.writeFile(path.join(sdir, 'blocked-v1.json'), good);
    await fs.writeFile(path.join(sdir, 'blocked-v1.json.tmp-1-aaaa'), withTwo, { mode: 0o600 });
    const r = open(dir); await r.load();
    assert.equal(r.lookup('studio', STORY).kind, 'safety');
    assert.equal(r.lookup('studio', 'первый вымышленный рассказ').kind, 'safety');
    assert.deepEqual(await fs.readdir(sdir), ['blocked-v1.json'], 'tmp убран после подтверждённой записи');
    // Недописанный tmp.
    await fs.writeFile(path.join(sdir, 'blocked-v1.json.tmp-2-bbbb'), withTwo.slice(0, 40));
    const t = open(dir);
    await assert.rejects(t.load(), { code: 'ledger' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('B04: сбой записи/rename — failed, ложного «сохранено» нет; память строже', async () => {
  const dir = await tmpDir();
  try {
    const failing = { ...fs, rename: async () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } };
    const l = open(dir, { fsImpl: failing }); await l.load();
    await assert.rejects(l.put({ scope: 'studio', story: STORY, kind: 'safety', reason: 'safety' }), { code: 'ledger' });
    assert.equal(l.healthy(), false);
    assert.equal(await l.flush(), false);
    assert.equal(l.lookup('studio', STORY).failed, true, 'выдача закрыта до восстановления');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('technical не пишется поверх safety; safety вытесняет technical; clearTechnical не трогает safety', async () => {
  const dir = await tmpDir();
  try {
    const l = open(dir); await l.load();
    const t = { kind: 'technical', reason: 'check_incomplete_twice', retryNotBeforeAt: '2026-11-10T12:15:00.000Z' };
    await l.put({ scope: 's', story: STORY, ...t });
    assert.equal(l.lookup('s', STORY).kind, 'technical');
    assert.equal(l.lookup('s', STORY).retryNotBeforeAt, '2026-11-10T12:15:00.000Z');
    await l.put({ scope: 's', story: STORY, kind: 'safety', reason: 'safety' });
    await l.put({ scope: 's', story: STORY, ...t });
    await l.clearTechnical('s', STORY);
    const r = open(dir); await r.load();
    assert.equal(r.lookup('s', STORY).kind, 'safety');
    assert.equal(r.size, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('TTL — только тестовый параметр: истёкшая запись не загружается, но это не разрешение (решает шлюз полной проверкой)', async () => {
  const dir = await tmpDir();
  try {
    let now = Date.parse('2026-11-10T12:00:00Z');
    const l = open(dir, { ttlMs: 1000, wallNow: () => now }); await l.load();
    await l.put({ scope: 's', story: STORY, kind: 'safety', reason: 'safety' });
    now += 999;
    assert.equal(l.lookup('s', STORY).kind, 'safety');
    now += 1;
    assert.equal(l.lookup('s', STORY).kind, null);
    const r = open(dir, { ttlMs: 1000, wallNow: () => now }); await r.load();
    assert.equal(r.size, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
