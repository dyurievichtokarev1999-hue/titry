// Контакты помощи проверяются один раз при старте (решение владельца по PR 11, 11.11 11:05).
// Невалидный или отсутствующий config/help.json — бот и монтажная не стартуют (код 3), обработчики не регистрируются,
// в журнал — только этап и код. Запуск — на копии server/engine/config во временной папке (свой help.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareHelp, helpMessage, TELEGRAM_TEXT_LIMIT, INSUFFICIENT_TEXT, INSUFFICIENT_INVITE_TEXT, INSUFFICIENT_WITH_HELP_LIMIT, loadHelp } from '../server/safety.js';
import { prepareBot } from '../server/bot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOOD = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'help.json'), 'utf8'));
const BAD = {
  'нет файла': null,
  'не JSON': '{ это не json',
  'нет проверенных контактов': { region: 'RU', emergency: { label: 'Экстренные', phone: '112', verified: false }, contacts: [] },
  'проверенный контакт без номера': { region: 'RU', emergency: { label: 'Экстренные', phone: '', verified: true }, contacts: [] },
  'пустая подпись контакта': { region: 'RU', emergency: { label: ' ', phone: '112', verified: true }, contacts: [] },
  'verified строкой "false"': { region: 'RU', emergency: { label: 'Экстренные', phone: '112', verified: 'false' }, contacts: [] },
  'номер из пробелов': { region: 'RU', emergency: { label: 'Экстренные', phone: '   ', verified: true }, contacts: [] },
  'часы не строкой': { region: 'RU', emergency: { label: 'Экстренные', phone: '112', hours: { a: 1 }, verified: true }, contacts: [] },
  'номер без цифр': { region: 'RU', emergency: { label: 'Экстренные', phone: 'звоните', verified: true }, contacts: [] },
  'перевод строки в подписи': { region: 'RU', emergency: { label: 'Экстренные\nслужбы', phone: '112', verified: true }, contacts: [] },
  'номер с буквами': { region: 'RU', emergency: { label: 'Экстренные', phone: '+7 (800) xyz', verified: true }, contacts: [] },
  'номер из двух цифр': { region: 'RU', emergency: { label: 'Экстренные', phone: '12', verified: true }, contacts: [] },
  'U+2028 в подписи': { region: 'RU', emergency: { label: 'Экстренные\u2028службы', phone: '112', verified: true }, contacts: [] },
  'U+2029 в номере': { region: 'RU', emergency: { label: 'Экстренные', phone: '11\u20292', verified: true }, contacts: [] },
  // Решение владельца кода 13.11 15:00 по PR 11: без контактов «Россия» (регион RU) сервис не стартует.
  'регион не Россия': { region: 'KZ', emergency: { label: 'Экстренные', phone: '112', verified: true }, contacts: [] },
  'нет кода региона': { emergency: { label: 'Экстренные', phone: '112', verified: true }, contacts: [] },
  'реплика с блоком concern длиннее 3500': { region: 'RU', emergency: { label: 'Ж'.repeat(3400), phone: '112', verified: true }, contacts: [] },
  'блок помощи длиннее одного сообщения': { region: 'RU', emergency: { label: 'Ж'.repeat(TELEGRAM_TEXT_LIMIT), phone: '112', verified: true }, contacts: [] },
};

async function helpFile(dir, value) {
  const f = path.join(dir, 'help.json');
  if (value !== null) await fs.writeFile(f, typeof value === 'string' ? value : JSON.stringify(value));
  return f;
}

test('prepareHelp: невалидный или отсутствующий help.json — ошибка help_config; рабочий файл проходит', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-help-'));
  try {
    for (const [name, value] of Object.entries(BAD)) {
      const d = await fs.mkdtemp(path.join(dir, 'c-'));
      const f = await helpFile(d, value);
      assert.throws(() => prepareHelp(f), { code: 'help_config' }, name);
    }
    const ok = prepareHelp(await helpFile(await fs.mkdtemp(path.join(dir, 'ok-')), GOOD));
    assert.ok(ok.contacts.length > 0);
    for (const level of ['concern', 'urgent']) assert.ok(helpMessage(level, ok).trim().length > 0, level);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('prepareBot: плохой help.json — отказ на этапе help.load до очистки и хранилища', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-help-'));
  try {
    let cleaned = 0, loaded = 0;
    const ledger = { load: async () => { loaded++; } };
    await assert.rejects(prepareBot({ helpFile: await helpFile(dir, BAD['нет проверенных контактов']), cleanup: async () => { cleaned++; }, ledger, env: { METRICS_SALT: 'test-salt-fictional-0001', ANTHROPIC_API_KEY: 'test-dummy' } }), { stage: 'help.load', code: 'help_config' });
    assert.equal(cleaned, 0); assert.equal(loaded, 0);
    prepareHelp(); // вернуть проверенные контакты репозитория для остальных тестов процесса
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// Копия кода с собственным config/help.json: настоящий вход server/bot.js и server/app.js.
async function tree(helpValue) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-help-entry-'));
  for (const d of ['server', 'engine']) await fs.cp(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  await fs.mkdir(path.join(dir, 'config'));
  await fs.copyFile(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  await fs.symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  if (helpValue !== null) await fs.writeFile(path.join(dir, 'config', 'help.json'), typeof helpValue === 'string' ? helpValue : JSON.stringify(helpValue));
  return dir;
}

function run(dir, entry, env, preload) {
  return new Promise((resolve) => {
    const args = preload ? ['--import', preload, path.join(dir, entry)] : [path.join(dir, entry)];
    const p = spawn(process.execPath, args, { env: { ...process.env, METRICS_SALT: 'test-salt-fictional-0001', TITRY_BLOCKED_HMAC_KEY: 'test-only-key-not-a-secret', TITRY_BLOCKED_KEY_VERSION: 'v-help-test', ...env }, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), 20000);
    p.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

for (const name of Object.keys(BAD)) {
  test(`запуск бота: help.json «${name}» → код 3, Telegram не опрашивается, в журнале только этап и код`, { timeout: 30000 }, async () => {
    const dir = await tree(BAD[name]);
    try {
      const flag = path.join(dir, 'telegram.flag');
      const preload = path.join(dir, 'preload.mjs');
      await fs.writeFile(preload, `import fs from 'node:fs';
globalThis.fetch = async () => { fs.writeFileSync(${JSON.stringify(flag)}, '1'); process.exit(0); };`);
      const rt = path.join(dir, 'runtime'); await fs.mkdir(rt, { mode: 0o700 }); // изоляция, даже если проверка сломается
      const r = await run(dir, 'server/bot.js', { TELEGRAM_BOT_TOKEN: 'test-only', TITRY_RUNTIME_DIR: rt }, preload);
      assert.equal(r.code, 3, r.err);
      assert.match(r.err, /"stage":"help\.load","code":"help_config"/);
      assert.ok(!r.err.includes(dir), 'путей в журнале нет');
      await assert.rejects(fs.stat(flag), { code: 'ENOENT' }, 'к Telegram не обращались: обработчики не зарегистрированы');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  test(`запуск монтажной: help.json «${name}» → код 3, порт не открыт`, { timeout: 30000 }, async () => {
    const dir = await tree(BAD[name]);
    try {
      const r = await run(dir, 'server/app.js', { PORT: '0' });
      assert.equal(r.code, 3, r.err);
      assert.match(r.err, /"stage":"help\.load","code":"help_config"/);
      assert.doesNotMatch(r.out, /Монтажная: http/, 'listen не вызывался');
      assert.ok(!r.err.includes(dir));
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
}

test('контроль: с рабочим help.json тот же запуск бота проходит проверку помощи и доходит до Telegram', { timeout: 30000 }, async () => {
  const dir = await tree(GOOD);
  try {
    const flag = path.join(dir, 'telegram.flag');
    const preload = path.join(dir, 'preload.mjs');
    await fs.writeFile(preload, `import fs from 'node:fs';
globalThis.fetch = async () => { fs.writeFileSync(${JSON.stringify(flag)}, '1'); process.exit(0); };`);
    const rt = path.join(dir, 'runtime'); await fs.mkdir(rt, { mode: 0o700 });
    const r = await run(dir, 'server/bot.js', { TELEGRAM_BOT_TOKEN: 'test-only', TITRY_RUNTIME_DIR: rt }, preload);
    assert.doesNotMatch(r.err, /help\.load/);
    assert.equal(r.code, 0, r.err);
    await fs.stat(flag);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('контроль: с рабочим help.json тот же запуск монтажной проходит проверку помощи и слушает порт', { timeout: 30000 }, async () => {
  const dir = await tree(GOOD);
  try {
    const p = spawn(process.execPath, [path.join(dir, 'server/app.js')], { env: { ...process.env, PORT: '0', TITRY_BLOCKED_HMAC_KEY: 'test-only-key-not-a-secret', TITRY_BLOCKED_KEY_VERSION: 'v-help-test' }, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stderr.on('data', (d) => { err += d; });
    const started = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 20000);
      p.stdout.on('data', (d) => { out += d; if (/Монтажная: http/.test(out)) { clearTimeout(timer); resolve(true); } });
      p.on('exit', () => { clearTimeout(timer); resolve(false); });
    });
    p.kill();
    assert.ok(started, err);
    assert.doesNotMatch(err, /help\.load/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('prepareHelp: неудачная повторная проверка не оставляет прежние контакты; рабочий файл восстанавливает', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-help-'));
  try {
    prepareHelp();
    const f = await helpFile(dir, BAD['нет проверенных контактов']);
    assert.throws(() => prepareHelp(f), { code: 'help_config' });
    // Ленивое обращение после неудачи перечитывает рабочий файл репозитория один раз.
    assert.match(helpMessage('concern'), /112/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('ограничитель 3500 проверяется при старте: вариант «длиннее 3500» укладывается в 4096 по отдельности, но не проходит вместе с репликой', () => {
  const help = { region: 'RU', contacts: [{ label: 'Ж'.repeat(3400), phone: '112' }] };
  for (const level of ['concern', 'urgent']) assert.ok(helpMessage(level, help).length <= TELEGRAM_TEXT_LIMIT, level);
  assert.ok(INSUFFICIENT_TEXT.length + 2 + helpMessage('concern', help).length > INSUFFICIENT_WITH_HELP_LIMIT);
  assert.equal(INSUFFICIENT_WITH_HELP_LIMIT, 3500);
  prepareHelp();
  assert.ok(INSUFFICIENT_TEXT.length + 2 + helpMessage('concern').length <= INSUFFICIENT_WITH_HELP_LIMIT, 'рабочий файл проходит');
});

// Слияние с PR 14 (вариант 1): в боте за репликой идёт приглашение — предел 3500 считается вместе с ним.
test('ограничитель 3500 учитывает приглашение: «реплика + блок» укладываются, а с приглашением — нет → проверка при старте падает', async () => {
  const base = INSUFFICIENT_TEXT.length + 2;
  const invite = INSUFFICIENT_INVITE_TEXT.length + 2;
  const empty = helpMessage('concern', { region: 'RU', contacts: [{ label: '', phone: '112' }] }).length;
  // Блок помощи такой длины, что без приглашения ровно 3500, а с приглашением — больше.
  const help = { region: 'RU', contacts: [{ label: 'Ж'.repeat(INSUFFICIENT_WITH_HELP_LIMIT - base - empty), phone: '112' }] };
  assert.equal(base + helpMessage('concern', help).length, INSUFFICIENT_WITH_HELP_LIMIT);
  assert.ok(base + invite + helpMessage('concern', help).length > INSUFFICIENT_WITH_HELP_LIMIT);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-help-inv-'));
  const f = path.join(dir, 'help.json');
  try {
    await fs.writeFile(f, JSON.stringify({ region: 'RU', emergency: { label: help.contacts[0].label, phone: '112', verified: true } }));
    assert.equal(loadHelp(f).contacts.length, 1);
    assert.throws(() => prepareHelp(f), { code: 'help_config' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); prepareHelp(); }
});
