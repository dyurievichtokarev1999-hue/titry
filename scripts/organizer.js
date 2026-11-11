#!/usr/bin/env node
// Команды организатора (особая зона). Сейчас одна:
//
//   node scripts/organizer.js lift-technical --area studio|chat:<id> --story-file <локальный файл>
//
// Снимает техническую паузу (запись kind='technical', reason check_incomplete_twice) одного рассказа в одной
// области из хранилища запретов data/state/blocked-v1.json. Остановку по безопасности (safety) не снимает никогда.
// Снятие не разрешает выдачу: следующее действие в монтажной или боте проходит полную отдельную проверку.
//
// Работает только при остановленных монтажной и боте (отметки data/state/run/, server/service-lock.js).
// Рассказ читается только из локального файла (простой текст или файл .json с полем "story", как examples/*.json);
// никуда не пишется и не выводится. Отпечаток считает server/ledger.js — тем же HMAC, что у сервиса.
// Вывод: в stdout — одна строка «lift_technical: <код>»; при отказе в stderr — фиксированная подсказка
// без отпечатков, области, текста и путей.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLedger, KEY_ENV, KEY_VERSION_ENV } from '../server/ledger.js';
import { acquireLock, acquireOrganizerMutex, releaseOnExit, ORGANIZER_ROLE, SERVICE_ROLES } from '../server/service-lock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const EXIT = { ok: 0, not_found: 1, safety_kept: 2, service_running: 3, ledger_error: 4, story_file_error: 5, write_unconfirmed: 6, lock_error: 7, too_early: 8, organizer_running: 9, usage: 64 };

const HINT = {
  not_found: 'Технической паузы для этого рассказа в этой области нет. Хранилище не изменено.',
  safety_kept: 'Для этого рассказа сохранена остановка по безопасности. Она не снимается никакой командой; хранилище не изменено.',
  service_running: 'Монтажная или бот запущены. Остановите их и повторите команду. Хранилище не изменено.',
  ledger_error: `Хранилище запретов недоступно: неверный ${KEY_ENV} или ${KEY_VERSION_ENV}, повреждённый файл или остаток незавершённой записи. Хранилище не изменено. Файлы хранилища не удаляйте, обратитесь к владельцу кода.`,
  write_unconfirmed: 'Запись хранилища не подтверждена: состояние неизвестно. Не запускайте монтажную и бота, сохраните копию каталога хранилища и обратитесь к владельцу кода.',
  lock_error: 'Не удалось поставить отметку команды (права на каталог хранилища). Хранилище не изменено.',
  story_file_error: 'Не удалось прочитать рассказ: нужен локальный файл с текстом или файл .json с полем "story".',
  too_early: 'Техническую паузу можно снять не раньше чем через 15 минут после её начала. Хранилище не изменено.',
  organizer_running: 'Уже работает другая команда организатора. Дождитесь её завершения и повторите. Хранилище не изменено.',
  usage: 'Использование: node scripts/organizer.js lift-technical --area studio|chat:<id> --story-file <файл>',
};

const AREA = /^(studio|chat:-?\d{1,20})$/;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'lift-technical') return null;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i], v = rest[i + 1];
    if (!['--area', '--story-file'].includes(k) || typeof v !== 'string' || k.slice(2) in opts) return null;
    opts[k.slice(2)] = v;
  }
  if (!AREA.test(opts.area || '') || !opts['story-file']) return null;
  return { area: opts.area, storyFile: opts['story-file'] };
}

async function readStory(file) {
  const text = await fs.readFile(file, 'utf8');
  let story = text;
  if (path.extname(file).toLowerCase() === '.json') {
    const doc = JSON.parse(text);
    if (!doc || typeof doc.story !== 'string') throw new Error('story');
    story = doc.story;
  }
  if (!story.trim()) throw new Error('story');
  return story;
}

/**
 * Снять техническую паузу. Возвращает код события (ключ EXIT). Ничего не печатает.
 * root — корень приложения (каталог с data/); env — переменные окружения (ключ хранилища).
 */
export async function liftTechnical({ area, story, root = ROOT, env = process.env, wallNow = Date.now }) {
  const stateDir = path.join(root, 'data', 'state');
  // ИР10-2: сначала общий замок команд организатора (две команды одновременно не работают), затем отметка
  // против запущенных сервисов.
  let releaseMutex;
  try { releaseMutex = acquireOrganizerMutex(stateDir); } catch (e) {
    return e?.code === 'busy_organizer' ? 'organizer_running' : 'lock_error';
  }
  releaseOnExit(releaseMutex);
  let release;
  try { release = acquireLock(stateDir, ORGANIZER_ROLE, SERVICE_ROLES); } catch (e) {
    releaseMutex();
    return e?.code === 'busy' ? 'service_running' : 'lock_error';
  }
  // Снять отметку и при аварийном выходе или сигнале (обработчик exit срабатывает и при process.exit).
  releaseOnExit(release);
  try {
    // Остаток незавершённой записи (blocked-v1.json.tmp-*) восстанавливает сервис при запуске. Команда его не
    // трогает: ledger.load() переписал бы основной файл, а команда обещает «не изменено» при любом отказе.
    let names;
    try { names = await fs.readdir(stateDir); } catch (e) { if (e?.code !== 'ENOENT') return 'ledger_error'; names = []; }
    if (names.some((n) => n.startsWith('blocked-v1.json.tmp-'))) return 'ledger_error';
    const ledger = makeLedger({ file: path.join(stateDir, 'blocked-v1.json'), key: env[KEY_ENV], keyVersion: env[KEY_VERSION_ENV] || 'v1' });
    try { await ledger.load(); } catch { return 'ledger_error'; }
    const found = ledger.lookup(area, story);
    if (found.failed) return 'ledger_error';
    if (found.kind === 'safety') return 'safety_kept';
    if (found.kind !== 'technical') return 'not_found';
    // ИР10-1: не раньше retry_not_before_at (15 минут — нижняя граница ручного повтора, не TTL). Неразборчивое
    // время — тоже «ещё рано»: лучше отказать, чем снять паузу досрочно. Хранилище при этом не меняется.
    const notBefore = Date.parse(found.retryNotBeforeAt);
    if (!Number.isFinite(notBefore) || wallNow() < notBefore) return 'too_early';
    // Сбой записи после начала изменения — состояние файла не подтверждено (не «не изменено»).
    try { await ledger.clearTechnical(area, story); } catch { return 'write_unconfirmed'; }
    if (!(await ledger.flush())) return 'write_unconfirmed';
    return 'ok';
  } finally { release(); releaseMutex(); }
}

export async function main(argv = process.argv.slice(2), { out = console.log, err = console.error, root = ROOT, env = process.env } = {}) {
  const finish = (code) => { out(`lift_technical: ${code}`); if (HINT[code]) err(HINT[code]); return EXIT[code]; };
  const args = parseArgs(argv);
  if (!args) return finish('usage');
  let story;
  try { story = await readStory(args.storyFile); } catch { return finish('story_file_error'); }
  let code;
  try { code = await liftTechnical({ area: args.area, story, root, env }); } catch { code = 'ledger_error'; }
  return finish(code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Необработанные ошибки — без сообщения и стека (в них мог бы оказаться путь или фрагмент рассказа).
  process.on('uncaughtException', () => { console.log('lift_technical: ledger_error'); process.exit(EXIT.ledger_error); });
  main().then((c) => { process.exitCode = c; }, () => { console.log('lift_technical: ledger_error'); process.exitCode = EXIT.ledger_error; });
}
