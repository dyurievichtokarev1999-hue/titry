// И1/И2 (критик реализации, план архитектора; поручение владельца 16:00) и хранение запретов бота.
// Рассказы и голосовые — вымышленные/синтетические; ключ — тестовый.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { transcribeOgg, cleanupVoiceOrphans } from '../server/stt.js';
import { createBot } from '../server/bot.js';
import { makeLedger } from '../server/ledger.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));

test('И1: голосовое — в TITRY_RUNTIME_DIR, каталог задачи 0700, файлы 0600, удаляются после распознавания', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-rt-'));
  const saved = { k: process.env.YANDEX_API_KEY, f: process.env.YANDEX_FOLDER_ID };
  process.env.YANDEX_API_KEY = 'test-only'; process.env.YANDEX_FOLDER_ID = 'test-only';
  try {
    const rt = path.join(base, 'runtime');
    const seen = [];
    const text = await transcribeOgg(Buffer.from('OggS-синтетика'), {
      runtimeDir: rt, duration: 3,
      recognize: async () => {
        const jobs = await fs.readdir(rt);
        assert.equal(jobs.length, 1); assert.match(jobs[0], /^titry-voice-[A-Za-z0-9]{6}$/);
        const job = path.join(rt, jobs[0]);
        seen.push((await fs.stat(rt)).mode & 0o777, (await fs.stat(job)).mode & 0o777, (await fs.stat(path.join(job, 'voice.ogg'))).mode & 0o777);
        return 'распознано';
      },
    });
    assert.equal(text, 'распознано');
    assert.deepEqual(seen, [0o700, 0o700, 0o600]);
    assert.deepEqual(await fs.readdir(rt), [], 'после распознавания остатков нет');
  } finally {
    process.env.YANDEX_API_KEY = saved.k ?? ''; process.env.YANDEX_FOLDER_ID = saved.f ?? '';
    if (saved.k === undefined) delete process.env.YANDEX_API_KEY;
    if (saved.f === undefined) delete process.env.YANDEX_FOLDER_ID;
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('И1: очистка при старте удаляет только каталоги собственных задач', async () => {
  const rt = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-rt-'));
  try {
    await fs.mkdir(path.join(rt, 'titry-voice-Ab12Cd'));
    await fs.writeFile(path.join(rt, 'titry-voice-Ab12Cd', 'part-000.ogg'), 'x');
    await fs.mkdir(path.join(rt, 'titry-voice-слишком-длинное'));
    await fs.writeFile(path.join(rt, 'titry-voice-Zz99Yy'), 'файл с похожим именем');
    await fs.mkdir(path.join(rt, 'чужой'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-outside-'));
    await fs.symlink(outside, path.join(rt, 'titry-voice-Ln00Kk'));
    assert.equal(await cleanupVoiceOrphans(rt), 1);
    assert.deepEqual((await fs.readdir(rt)).sort(), ['titry-voice-Ln00Kk', 'titry-voice-Zz99Yy', 'titry-voice-слишком-длинное', 'чужой'].sort());
    await fs.stat(outside); // цель ссылки не тронута
    await fs.rm(outside, { recursive: true, force: true });
    assert.equal(await cleanupVoiceOrphans(path.join(rt, 'нет-такого')), 0);
  } finally { await fs.rm(rt, { recursive: true, force: true }); }
});

test('И2: заголовок эпизода не попадает в командную строку ffmpeg', { timeout: 120000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-argv-'));
  try {
    const argvFile = path.join(dir, 'argv.txt');
    const fake = path.join(dir, 'ffmpeg');
    await fs.writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\ncat > /dev/null\nexit 1\n`, { mode: 0o755 });
    const MARK = 'Заголовок-МАРКЕР-И2';
    const ep = { ...structuredClone(ex.episode), title: MARK };
    const script = `
      import fs from 'node:fs/promises';
      const { renderEpisode, closeRenderer } = await import(${JSON.stringify(new URL('../server/render.js', import.meta.url).href)});
      const ep = JSON.parse(process.env.EP);
      try { await renderEpisode(ep, { story: process.env.STORY, outPath: process.env.OUT, preset: 'preview', duration: 16 }); console.log('ok'); }
      catch (e) { console.log('code=' + e.code); }
      await closeRenderer();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, FFMPEG: fake, EP: JSON.stringify(ep), STORY: ex.story, OUT: path.join(dir, 'o.mp4') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    await new Promise((r) => child.on('exit', r));
    if (/code=browser/.test(out)) { t.skip('Chromium недоступен в этой среде — not-run'); return; }
    const argv = await fs.readFile(argvFile, 'utf8');
    assert.ok(argv.includes('libx264'), 'это настоящий вызов кодирования');
    assert.ok(!argv.includes(MARK), 'заголовка нет в argv');
    assert.ok(!/title=/.test(argv), 'нет -metadata title');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('бот: safety переживает перезапуск и /delete (хранилище, область — участник)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-botledger-'));
  const opened = []; // все хранилища теста: до удаления каталога дождаться их записей (ENOTEMPTY, QA 17:32)
  const file = path.join(dir, 'state', 'blocked-v1.json');
  const chat = { id: 77101, type: 'private' };
  const metrics = { hash: () => 'qa', log: async () => {}, forget: async () => {} };
  const good = async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] });
  async function boot(check) {
    const ledger = makeLedger({ file, key: 'test-only-key-not-a-secret', keyVersion: 'v1' });
    await ledger.load();
    opened.push(ledger);
    const sent = []; const c = { render: 0, video: 0, check: 0 };
    const bot = createBot({
      tg: { send: async (x, t) => { sent.push(t); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => { c.video++; } },
      metrics, draft: good, ledger,
      safetyCheck: async () => { c.check++; return check(c.check); },
      render: async (e, o) => { c.render++; return { seconds: 1, duration: 24, outPath: o.outPath }; },
    });
    const say = (text, who = chat) => bot.handleUpdate({ message: { chat: who, text } });
    const playAll = async (who = chat) => { for (let n = 0; n <= 3; n++) await bot.handleUpdate({ callback_query: { id: 'q', data: `play:${n}`, message: { chat: who } } }); };
    return { ledger, sent, c, say, playAll };
  }
  try {
    const a = await boot(() => true);
    await a.say(ex.story); await a.playAll();
    await a.ledger.flush();
    const raw = await fs.readFile(file, 'utf8');
    assert.ok(!raw.includes(String(chat.id)) && !raw.includes(ex.story.slice(0, 15)), 'на диске нет ID чата и текста');
    const b = await boot(() => false); // перезапуск; модель теперь «разрешает»
    await b.say('/delete');
    assert.equal(b.sent.at(-1), 'Сессия и статистика по тебе удалены.\nПолное удаление не подтверждено.', 'запись из хранилища после перезапуска');
    await b.say(ex.story); await b.playAll();
    assert.equal(b.c.check, 0); assert.equal(b.c.render, 0); assert.equal(b.c.video, 0);
    // другой участник не затронут
    const other = { id: 77102, type: 'private' };
    await b.say(ex.story, other); await b.playAll(other);
    assert.equal(b.c.render, 1);
  } finally { await Promise.all(opened.map((l) => l.flush())); await fs.rm(dir, { recursive: true, force: true }); }
});

test('бот: technical переживает перезапуск и /delete; опасный черновик после /delete всё равно записывает запрет', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-botledger2-'));
  const opened = [];
  const file = path.join(dir, 'state', 'blocked-v1.json');
  const chat = { id: 77201, type: 'private' };
  const metrics = { hash: () => 'qa', log: async () => {}, forget: async () => {} };
  const good = async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] });
  const fail = () => { throw Object.assign(new Error('x'), { code: 'incomplete_response' }); };
  async function boot({ check, draft = good }) {
    const ledger = makeLedger({ file, key: 'test-only-key-not-a-secret', keyVersion: 'v1' });
    await ledger.load();
    opened.push(ledger);
    const sent = []; const c = { render: 0, video: 0, check: 0 };
    const bot = createBot({
      tg: { send: async (x, t) => { sent.push(t); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => { c.video++; } },
      metrics, draft, ledger,
      safetyCheck: async () => { c.check++; return check(c.check); },
      render: async (e, o) => { c.render++; return { seconds: 1, duration: 24, outPath: o.outPath }; },
    });
    const say = (text, who = chat) => bot.handleUpdate({ message: { chat: who, text } });
    const playAll = async (who = chat) => { for (let n = 0; n <= 3; n++) await bot.handleUpdate({ callback_query: { id: 'q', data: `play:${n}`, message: { chat: who } } }); };
    return { ledger, sent, c, say, playAll };
  }
  try {
    const a = await boot({ check: fail });
    await a.say(ex.story); await a.playAll(); await a.playAll(); // две неполные проверки подряд
    assert.match(a.sent.join('\n'), /дважды не смог/);
    await a.ledger.flush();
    const b = await boot({ check: () => false });
    await b.say('/delete');
    await b.say(ex.story); await b.playAll();
    assert.match(b.sent.join('\n'), /дважды не смог завершить проверку рассказа/);
    assert.equal(b.c.check, 0); assert.equal(b.c.render, 0); assert.equal(b.c.video, 0);

    // Гонка: опасный черновик возвращается после /delete.
    const other = { id: 77202, type: 'private' };
    const STORY2 = `${ex.story} Вечером пила чай.`;
    let release; const held = new Promise((r) => { release = r; });
    let started; const inDraft = new Promise((r) => { started = r; });
    let calls = 0;
    const c = await boot({ check: () => false, draft: async () => { calls++; if (calls === 1) { started(); await held; return { episode: null, risk: { level: 'urgent', byModel: true, matches: [] }, provider: 'claude' }; } return good(); } });
    const pending = c.say(STORY2, other);
    await inDraft; // черновик действительно в работе
    await c.say('/delete', other);
    release(); await pending;
    await c.say(STORY2, other); await c.playAll(other);
    assert.equal(c.c.render, 0, 'запрет записан, хотя сессия удалена'); assert.equal(c.c.video, 0);
  } finally { await Promise.all(opened.map((l) => l.flush())); await fs.rm(dir, { recursive: true, force: true }); }
});

test('И1: чужой путь или ссылка вместо каталога задач — отказ, без записи', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-rt-'));
  const saved = { k: process.env.YANDEX_API_KEY, f: process.env.YANDEX_FOLDER_ID };
  process.env.YANDEX_API_KEY = 'test-only'; process.env.YANDEX_FOLDER_ID = 'test-only';
  try {
    const target = path.join(base, 'target'); await fs.mkdir(target);
    const link = path.join(base, 'runtime'); await fs.symlink(target, link);
    await assert.rejects(transcribeOgg(Buffer.from('x'), { runtimeDir: link, duration: 1, recognize: async () => 'нет' }), { code: 'EACCES' });
    assert.deepEqual(await fs.readdir(target), []);
  } finally {
    if (saved.k === undefined) delete process.env.YANDEX_API_KEY; else process.env.YANDEX_API_KEY = saved.k;
    if (saved.f === undefined) delete process.env.YANDEX_FOLDER_ID; else process.env.YANDEX_FOLDER_ID = saved.f;
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('B09.6: ошибка стартовой очистки — бот не начинает опрос Telegram, код выхода ненулевой', { timeout: 30000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-entry-'));
  try {
    // Сбой очистки, не зависящий от прав (тесты могут идти от root): путь runtime — обычный файл (ENOTDIR).
    const rt = path.join(dir, 'runtime');
    await fs.writeFile(rt, 'не каталог');
    const flag = path.join(dir, 'getUpdates.flag');
    const preload = path.join(dir, 'preload.mjs');
    await fs.writeFile(preload, `import fs from 'node:fs';
globalThis.fetch = async (url) => {
  const m = String(url).split('/').pop();
  if (m === 'getUpdates') { fs.writeFileSync(${JSON.stringify(flag)}, '1'); process.exit(0); }
  return new Response(JSON.stringify({ ok: true, result: m === 'getMe' ? { username: 'test_bot' } : true }));
};`);
    const run = (env) => new Promise((resolve) => {
      const p = spawn(process.execPath, ['--import', preload, new URL('../server/bot.js', import.meta.url).pathname], {
        env: { ...process.env, TELEGRAM_BOT_TOKEN: 'test-only', TITRY_RUNTIME_DIR: rt, TITRY_BLOCKED_HMAC_KEY: 'test-only-key-not-a-secret', TITRY_BLOCKED_KEY_VERSION: 'v-entry-test', ...env },
        cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (code) => resolve({ code, err }));
    });
    const { code, err } = await run({});
    assert.notEqual(code, 0, 'код выхода ненулевой');
    assert.match(err, /"stage":"voice\.cleanup","code":"ENOTDIR"/, 'отказ именно на стартовой очистке');
    assert.ok(!err.includes(dir), 'путей в журнале нет');
    await assert.rejects(fs.stat(flag), { code: 'ENOENT' }, 'getUpdates не вызывался');
    // Нет ключа хранилища — тоже отказ запуска (решение владельца 17:10). Очистка здесь успешна.
    await fs.rm(rt); await fs.mkdir(rt, { mode: 0o700 });
    const r2 = await run({ TITRY_BLOCKED_HMAC_KEY: '' });
    assert.notEqual(r2.code, 0);
    assert.match(r2.err, /"stage":"ledger\.load","code":"ledger"/, 'отказ именно на хранилище');
    await assert.rejects(fs.stat(flag), { code: 'ENOENT' });
    // Контроль: успешная подготовка доходит до опроса (хранилище — во временном ROOT нельзя, поэтому
    // проверяется prepareBot в соседнем тесте; здесь — только отказы).
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('B09.6: prepareBot — ошибка очистки или хранилища отклоняется; успешная подготовка возвращает хранилище', async () => {
  const { prepareBot } = await import('../server/bot.js');
  const okLedger = { load: async () => {} };
  await assert.rejects(prepareBot({ cleanup: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }, ledger: okLedger }), { stage: 'voice.cleanup', code: 'EACCES' });
  await assert.rejects(prepareBot({ cleanup: async () => 0, ledger: { load: async () => { throw new Error('x'); } } }), { stage: 'ledger.load', code: 'ledger' });
  assert.equal(await prepareBot({ cleanup: async () => 0, ledger: okLedger }), okLedger);
});
