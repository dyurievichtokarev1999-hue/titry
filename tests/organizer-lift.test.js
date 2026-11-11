// Команда организатора lift-technical (scripts/organizer.js): снимает только technical, только при
// остановленном сервисе, без утечки отпечатков, области, текста и путей. Рассказ — вымышленный пример.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { makeLedger } from '../server/ledger.js';
import { makeGate } from '../server/gate.js';
import { acquireLock } from '../server/service-lock.js';

const repo = new URL('..', import.meta.url).pathname;
const KEY = 'test-only-key-not-a-secret';
const VER = 'v-organizer-test';
const env = { TITRY_BLOCKED_HMAC_KEY: KEY, TITRY_BLOCKED_KEY_VERSION: VER };
const STORY = JSON.parse(await fs.readFile(path.join(repo, 'examples', 'day-quiet.json'), 'utf8')).story;
const OTHER = 'Вымышленный день: утром дождь, днём библиотека, вечером чай.';
const RETRY_AT = '2026-11-11T10:15:00.000Z';

// Копия приложения во временном корне: server/, scripts/, engine/ копируются (иначе Node взял бы data/ репозитория).
async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-organizer-'));
  for (const d of ['server', 'engine', 'scripts']) await fs.cp(path.join(repo, d), path.join(root, d), { recursive: true });
  for (const d of ['studio', 'config', 'brand', 'examples', 'assets', 'node_modules']) {
    await fs.symlink(path.join(repo, d), path.join(root, d)).catch(() => {});
  }
  await fs.copyFile(path.join(repo, 'package.json'), path.join(root, 'package.json'));
  await fs.mkdir(path.join(root, 'data', 'state'), { recursive: true });
  const storyFile = path.join(root, 'story.json');
  await fs.copyFile(path.join(repo, 'examples', 'day-quiet.json'), storyFile);
  return { root, storyFile, ledgerFile: path.join(root, 'data', 'state', 'blocked-v1.json') };
}

const ledgerAt = (file, key = KEY) => makeLedger({ file, key, keyVersion: VER });

async function seed(file, records) {
  const l = ledgerAt(file);
  await l.load();
  for (const r of records) {
    await l.put(r.kind === 'technical'
      ? { scope: r.scope, story: r.story, kind: 'technical', reason: 'check_incomplete_twice', retryNotBeforeAt: RETRY_AT }
      : { scope: r.scope, story: r.story, kind: 'safety', reason: 'safety' });
  }
  assert.equal(await l.flush(), true);
}

function run(root, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(root, 'scripts', 'organizer.js'), ...args], {
      env: { ...process.env, ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), 20000);
    p.on('error', reject);
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}
const lift = (r, area = 'studio', extraEnv) => run(r.root, ['lift-technical', '--area', area, '--story-file', r.storyFile], extraEnv);

test('lift-technical: снимает technical этой области и рассказа; другие записи и safety остаются', async () => {
  const r = await makeRoot();
  try {
    await seed(r.ledgerFile, [
      { kind: 'technical', scope: 'studio', story: STORY },
      { kind: 'technical', scope: 'chat:42', story: STORY },
      { kind: 'safety', scope: 'studio', story: OTHER },
    ]);
    const res = await lift(r);
    assert.equal(res.code, 0, res.err);
    assert.equal(res.out, 'lift_technical: ok\n');
    const l = ledgerAt(r.ledgerFile); await l.load();
    assert.equal(l.lookup('studio', STORY).kind, null, 'technical снят');
    assert.equal(l.lookup('chat:42', STORY).kind, 'technical', 'чужая область не затронута');
    assert.equal(l.lookup('studio', OTHER).kind, 'safety', 'safety не затронут');
    // Область бота: chat:<id>, тот же способ отпечатка, что у бота.
    const res2 = await lift(r, 'chat:42');
    assert.equal(res2.code, 0, res2.err);
    const l2 = ledgerAt(r.ledgerFile); await l2.load();
    assert.equal(l2.lookup('chat:42', STORY).kind, null);
    // Повтор — нечего снимать: not_found, файл не меняется.
    const before = await fs.readFile(r.ledgerFile);
    const res3 = await lift(r);
    assert.equal(res3.code, 1);
    assert.equal(res3.out, 'lift_technical: not_found\n');
    assert.deepEqual(await fs.readFile(r.ledgerFile), before);
    assert.deepEqual((await fs.readdir(path.join(r.root, 'data', 'state', 'run'))), [], 'отметка организатора снята');
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test('lift-technical: запись safety — отказ с понятным текстом, файл не меняется', async () => {
  const r = await makeRoot();
  try {
    await seed(r.ledgerFile, [{ kind: 'technical', scope: 'studio', story: STORY }, { kind: 'safety', scope: 'studio', story: STORY }]);
    const before = await fs.readFile(r.ledgerFile);
    const res = await lift(r);
    assert.equal(res.code, 2);
    assert.equal(res.out, 'lift_technical: safety_kept\n');
    assert.match(res.err, /остановка по безопасности/);
    assert.match(res.err, /не снимается никакой командой/);
    assert.deepEqual(await fs.readFile(r.ledgerFile), before);
    const l = ledgerAt(r.ledgerFile); await l.load();
    assert.equal(l.lookup('studio', STORY).kind, 'safety');
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test('lift-technical: сервис запущен (отметка живого процесса) — отказ, файл не меняется; отметка умершего не мешает', async () => {
  const r = await makeRoot();
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    await seed(r.ledgerFile, [{ kind: 'technical', scope: 'studio', story: STORY }]);
    const before = await fs.readFile(r.ledgerFile);
    const stateDir = path.join(r.root, 'data', 'state');
    for (const role of ['bot', 'studio']) {
      const release = acquireLock(stateDir, role, [], { pid: sleeper.pid });
      const res = await lift(r);
      assert.equal(res.code, 3, role);
      assert.equal(res.out, 'lift_technical: service_running\n');
      assert.match(res.err, /Остановите их/);
      assert.deepEqual(await fs.readFile(r.ledgerFile), before, 'файл не изменён');
      release();
    }
    // pid переиспользован другим процессом (время старта не совпадает) — отметка устарела.
    await fs.writeFile(path.join(stateDir, 'run', `bot.${sleeper.pid}.pid`), `${sleeper.pid} 1\n`);
    // Отметка процесса, которого уже нет (kill -9), не считается запущенным сервисом.
    await fs.writeFile(path.join(stateDir, 'run', 'studio.999999999.pid'), '999999999\n');
    const res = await lift(r);
    assert.equal(res.code, 0, res.err);
    assert.deepEqual(await fs.readdir(path.join(stateDir, 'run')), [], 'устаревшие отметки убраны');
  } finally { sleeper.kill('SIGKILL'); await fs.rm(r.root, { recursive: true, force: true }); }
});

async function freePort() {
  return new Promise((res) => { const sv = http.createServer().listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); }); });
}

function startStudio(root, port) {
  const child = spawn(process.execPath, [path.join(root, 'server', 'app.js')], {
    env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    let buf = '', errText = '';
    child.stdout.on('data', (d) => { buf += d; if (/Монтажная: http/.test(buf)) resolve(); });
    child.stderr.on('data', (d) => { errText += d; });
    child.on('exit', (code) => reject(Object.assign(new Error(`монтажная завершилась с кодом ${code}`), { code, errText, buf })));
  });
  return { child, ready };
}

test('lift-technical: настоящая монтажная запущена — отказ; после остановки (SIGTERM) снятие проходит', { timeout: 60000 }, async () => {
  const r = await makeRoot();
  let child;
  try {
    await seed(r.ledgerFile, [{ kind: 'technical', scope: 'studio', story: STORY }]);
    const before = await fs.readFile(r.ledgerFile);
    const s = startStudio(r.root, await freePort());
    child = s.child;
    await s.ready;
    const res = await lift(r);
    assert.equal(res.code, 3);
    assert.equal(res.out, 'lift_technical: service_running\n');
    assert.deepEqual(await fs.readFile(r.ledgerFile), before);
    child.removeAllListeners('exit');
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    assert.equal(child.signalCode, 'SIGTERM', 'процесс завершён самим сигналом, а не кодом выхода');
    assert.deepEqual(await fs.readdir(path.join(r.root, 'data', 'state', 'run')), [], 'отметка снята при выходе');
    // То же для SIGINT (Ctrl+C).
    const s2 = startStudio(r.root, await freePort());
    child = s2.child;
    await s2.ready;
    assert.equal((await fs.readdir(path.join(r.root, 'data', 'state', 'run'))).length, 1);
    child.removeAllListeners('exit');
    const exited2 = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGINT');
    await exited2;
    assert.deepEqual(await fs.readdir(path.join(r.root, 'data', 'state', 'run')), [], 'отметка снята по SIGINT');
    const res2 = await lift(r);
    assert.equal(res2.code, 0, res2.err);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.removeAllListeners('exit'); child.kill('SIGKILL'); }
    await fs.rm(r.root, { recursive: true, force: true });
  }
});

test('монтажная и бот не запускаются, пока работает команда организатора (код 3, без listen)', { timeout: 60000 }, async () => {
  const r = await makeRoot();
  try {
    const release = acquireLock(path.join(r.root, 'data', 'state'), 'organizer', [], { pid: process.pid });
    try {
      const s = startStudio(r.root, await freePort());
      const e = await s.ready.then(() => null, (x) => x);
      assert.ok(e, 'монтажная не должна начать слушать');
      assert.equal(e.code, 3);
      assert.doesNotMatch(e.buf, /Монтажная: http/);
      assert.match(e.errText, /"stage":"service\.lock","code":"busy"/);
      assert.ok(!e.errText.includes(r.root), 'путей в журнале нет');
      // Бот: отметка ставится до приёма задач и до обращения к Telegram (запросов в сеть нет: отказ раньше).
      const bot = await new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(r.root, 'server', 'bot.js')], {
          env: { ...process.env, ...env, TELEGRAM_BOT_TOKEN: '0:test-not-a-token', TITRY_RUNTIME_DIR: path.join(r.root, 'runtime') }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        const t = setTimeout(() => p.kill('SIGKILL'), 20000);
        p.on('exit', (code) => { clearTimeout(t); resolve({ code, err }); });
      });
      assert.equal(bot.code, 3);
      assert.match(bot.err, /"stage":"service\.lock","code":"busy"/);
    } finally { release(); }
    assert.equal(await fs.stat(path.join(r.root, 'data', 'state', 'blocked-v1.json')).then(() => true, () => false), false, 'хранилище не тронуто');
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test('lift-technical: неверный или короткий ключ, другая версия — закрытый отказ, файл не меняется', async () => {
  const r = await makeRoot();
  try {
    await seed(r.ledgerFile, [{ kind: 'technical', scope: 'studio', story: STORY }]);
    const before = await fs.readFile(r.ledgerFile);
    for (const extra of [
      { TITRY_BLOCKED_HMAC_KEY: 'another-test-key-not-a-secret' },
      { TITRY_BLOCKED_HMAC_KEY: 'short' },
      { TITRY_BLOCKED_HMAC_KEY: '' },
      { TITRY_BLOCKED_KEY_VERSION: 'v-other' },
    ]) {
      const res = await lift(r, 'studio', extra);
      assert.equal(res.code, 4, JSON.stringify(Object.keys(extra)));
      assert.equal(res.out, 'lift_technical: ledger_error\n');
      assert.deepEqual(await fs.readFile(r.ledgerFile), before);
    }
    const l = ledgerAt(r.ledgerFile); await l.load();
    assert.equal(l.lookup('studio', STORY).kind, 'technical', 'пауза осталась');
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test('lift-technical: повреждённый файл или недописанный tmp — закрытый отказ, файлы не меняются', async () => {
  const r = await makeRoot();
  try {
    await seed(r.ledgerFile, [{ kind: 'technical', scope: 'studio', story: STORY }]);
    const good = await fs.readFile(r.ledgerFile, 'utf8');
    const cases = [
      good.slice(0, good.length - 5), // обрезан
      'не json',
      // запись удалена без ключа: подпись документа не сходится
      JSON.stringify({ ...JSON.parse(good), records: [] }),
    ];
    for (const bad of cases) {
      await fs.writeFile(r.ledgerFile, bad);
      const res = await lift(r);
      assert.equal(res.code, 4);
      assert.equal(res.out, 'lift_technical: ledger_error\n');
      assert.equal(await fs.readFile(r.ledgerFile, 'utf8'), bad);
    }
    // Полный tmp (сбой между записью tmp и rename): команда не восстанавливает его сама — это делает сервис.
    await fs.writeFile(r.ledgerFile, good);
    const full = path.join(r.root, 'data', 'state', 'blocked-v1.json.tmp-2-full');
    await fs.writeFile(full, good);
    const resFull = await lift(r);
    assert.equal(resFull.code, 4);
    assert.equal(resFull.out, 'lift_technical: ledger_error\n');
    assert.equal(await fs.readFile(r.ledgerFile, 'utf8'), good);
    assert.equal(await fs.readFile(full, 'utf8'), good, 'tmp не тронут');
    await fs.rm(full);
    const tmp = path.join(r.root, 'data', 'state', 'blocked-v1.json.tmp-1-abcd');
    await fs.writeFile(tmp, '{"schema_version":1,');
    const res = await lift(r);
    assert.equal(res.code, 4);
    assert.equal(await fs.readFile(r.ledgerFile, 'utf8'), good);
    assert.equal(await fs.readFile(tmp, 'utf8'), '{"schema_version":1,');
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test('после снятия выдача не разрешена: следующее действие проходит полную отдельную проверку', async () => {
  const r = await makeRoot();
  try {
    await seed(r.ledgerFile, [{ kind: 'technical', scope: 'studio', story: STORY }]);
    const ep = { title: 'Тихий день', genre: 'камерная драма', rows: [] };
    // До снятия: проверка не запускается, выдачи нет.
    {
      const l = ledgerAt(r.ledgerFile); await l.load();
      let calls = 0;
      const gate = makeGate({ ledger: l, check: async () => { calls++; return false; } });
      const v = await gate.verify('studio', STORY, ep, STORY);
      assert.equal(v.kind, 'technical');
      assert.equal(calls, 0);
    }
    assert.equal((await lift(r)).code, 0);
    // После снятия (как после перезапуска сервиса): каждое действие — полная проверка, её исход решает.
    let cur;
    const fresh = async (check) => { cur = ledgerAt(r.ledgerFile); await cur.load(); return makeGate({ ledger: cur, check }); };
    let calls = 0;
    let g = await fresh(async () => { calls++; throw Object.assign(new Error('x'), { code: 'timeout' }); });
    const v1 = await g.verify('studio', STORY, ep, STORY);
    assert.equal(calls, 1, 'проверка запущена');
    assert.equal(v1.ok, undefined, 'неполная проверка выдачи не даёт');
    assert.equal(v1.unavailable, true);
    calls = 0;
    g = await fresh(async () => { calls++; return false; });
    const v3 = await g.verify('studio', STORY, ep, STORY);
    assert.equal(calls, 1);
    assert.equal(v3.ok, true, 'выдача — только после полной успешной проверки');
    // Опасность при проверке после снятия — safety, и она сохраняется в хранилище.
    g = await fresh(async () => true);
    assert.deepEqual(await g.verify('studio', STORY, ep, STORY), { kind: 'safety' });
    assert.equal(await cur.flush(), true);
    const l = ledgerAt(r.ledgerFile); await l.load();
    assert.equal(l.lookup('studio', STORY).kind, 'safety');
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test('lift-technical: неверные аргументы и нечитаемый рассказ — отказ без изменений', async () => {
  const r = await makeRoot();
  try {
    await seed(r.ledgerFile, [{ kind: 'technical', scope: 'studio', story: STORY }]);
    const before = await fs.readFile(r.ledgerFile);
    for (const args of [[], ['lift-technical'], ['lift-technical', '--area', 'other', '--story-file', r.storyFile],
      ['lift-technical', '--area', 'chat:abc', '--story-file', r.storyFile], ['lift-safety', '--area', 'studio', '--story-file', r.storyFile]]) {
      const res = await run(r.root, args);
      assert.equal(res.code, 64, args.join(' '));
      assert.equal(res.out, 'lift_technical: usage\n');
    }
    const res = await run(r.root, ['lift-technical', '--area', 'studio', '--story-file', path.join(r.root, 'нет-такого.txt')]);
    assert.equal(res.code, 5);
    assert.equal(res.out, 'lift_technical: story_file_error\n');
    assert.deepEqual(await fs.readFile(r.ledgerFile), before);
    // Простой текстовый файл тоже подходит.
    const txt = path.join(r.root, 'story.txt');
    await fs.writeFile(txt, STORY);
    const ok = await run(r.root, ['lift-technical', '--area', 'studio', '--story-file', txt]);
    assert.equal(ok.code, 0, ok.err);
    // Текст, начинающийся с «{», в файле не .json — это текст, а не JSON.
    await fs.writeFile(txt, '{скобка} вымышленный рассказ');
    assert.equal((await run(r.root, ['lift-technical', '--area', 'studio', '--story-file', txt])).code, 1);
  } finally { await fs.rm(r.root, { recursive: true, force: true }); }
});

test('в выводе команды нет отпечатков, области, текста рассказа и путей (все исходы)', { timeout: 60000 }, async () => {
  const r = await makeRoot();
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const seen = [];
  const go = async (area = 'studio', extra) => { const res = await lift(r, area, extra); seen.push(res); return res; };
  try {
    await seed(r.ledgerFile, [
      { kind: 'technical', scope: 'studio', story: STORY },
      { kind: 'safety', scope: 'chat:42', story: STORY },
    ]);
    const stateDir = path.join(r.root, 'data', 'state');
    const release = acquireLock(stateDir, 'bot', [], { pid: sleeper.pid });
    assert.equal((await go()).code, 3);
    release();
    assert.equal((await go('studio', { TITRY_BLOCKED_HMAC_KEY: 'another-test-key-not-a-secret' })).code, 4);
    assert.equal((await go('chat:42')).code, 2);
    assert.equal((await go()).code, 0);
    assert.equal((await go()).code, 1);
    seen.push(await run(r.root, ['lift-technical']));
    seen.push(await run(r.root, ['lift-technical', '--area', 'studio', '--story-file', path.join(r.root, 'нет.txt')]));
    const words = STORY.split(/\s+/).filter((w) => w.length >= 6).slice(0, 8);
    for (const { out, err } of seen) {
      const all = out + err;
      assert.doesNotMatch(all, /[0-9a-f]{16,}/, 'нет отпечатков');
      assert.doesNotMatch(all, /chat:\d|studio\b(?!\|)/, 'нет области');
      assert.ok(!all.includes(r.root) && !all.includes(os.tmpdir()) && !all.includes('data/'), 'нет путей');
      for (const w of words) assert.ok(!all.includes(w), 'нет текста рассказа');
      assert.match(out, /^lift_technical: (ok|not_found|safety_kept|service_running|ledger_error|story_file_error|usage)\n$/);
    }
  } finally { sleeper.kill('SIGKILL'); await fs.rm(r.root, { recursive: true, force: true }); }
});
