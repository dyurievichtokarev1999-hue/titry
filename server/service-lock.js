// Отметка «сервис запущен» (особая зона рядом с хранилищем запретов). Нужна, чтобы команда организатора
// (scripts/organizer.js) меняла data/state/blocked-v1.json только при остановленных монтажной и боте:
// иначе запущенный процесс держит хранилище в памяти и при следующей записи вернул бы снятую запись.
//
// Устройство: каталог data/state/run/, в нём файл на каждый процесс — <роль>.<pid>.pid (роли studio, bot,
// organizer). Протокол «сначала отметься, потом смотри на других»: каждая сторона атомарно создаёт свой файл (wx),
// затем проверяет файлы противоположной стороны. Если две стороны стартуют одновременно, хотя бы одна
// увидит другую и откажет. Файл умершего процесса (kill -9, сбой питания) распознаётся по pid и не мешает.
// Несколько экземпляров одной роли друг другу не мешают (поведение сервиса не меняется).
// В файл пишется только pid; ни ключей, ни рассказов, ни путей.
import fs from 'node:fs';
import path from 'node:path';

export const SERVICE_ROLES = ['studio', 'bot'];
export const ORGANIZER_ROLE = 'organizer';

const lockError = (code) => Object.assign(new Error('Отметка запуска недоступна.'), { code });

/** Жив ли процесс: EPERM — процесс есть, но чужой (считаем живым: закрытый отказ). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

const runDir = (stateDir) => path.join(stateDir, 'run');
const NAME = /^([a-z]+)\.(\d+)\.pid$/;

/** pid из файла; NaN — файл нечитаем или испорчен (считается живым — закрытый отказ); null — файла уже нет. */
function readPid(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return null; return NaN; }
  return /^\d+\n?$/.test(text) ? Number.parseInt(text, 10) : NaN;
}

/**
 * Есть ли живой процесс любой из ролей. Нечитаемый каталог или файл — «жив»: лучше отказать, чем снять паузу
 * под работающим сервисом. Файлы умерших процессов не учитываются (и не удаляются: это не наша отметка).
 */
export function anyAlive(stateDir, roles) {
  let names;
  try { names = fs.readdirSync(runDir(stateDir)); } catch (e) { if (e?.code === 'ENOENT') return false; return true; }
  for (const n of names) {
    const m = NAME.exec(n);
    if (!m || !roles.includes(m[1])) continue;
    const pid = readPid(path.join(runDir(stateDir), n));
    if (pid === null) continue;
    if (Number.isNaN(pid) || pid !== Number.parseInt(m[2], 10) || pidAlive(pid)) return true;
  }
  return false;
}

/**
 * Поставить отметку роли. rivals — роли, при живой отметке которых запуск запрещён.
 * Бросает ошибку с code: 'busy' (есть живой процесс-соперник) или кодом файловой системы.
 * Возвращает release() — снимает свою отметку.
 */
export function acquireLock(stateDir, role, rivals, { pid = process.pid } = {}) {
  fs.mkdirSync(runDir(stateDir), { recursive: true, mode: 0o700 });
  const file = path.join(runDir(stateDir), `${role}.${pid}.pid`);
  // Файл с нашим же pid может остаться только от умершего процесса, получившего тот же номер: перезаписываем.
  fs.rmSync(file, { force: true });
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeSync(fd, `${pid}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    try { fs.rmSync(file, { force: true }); } catch { /* устаревшую отметку распознает проверка pid */ }
  };
  if (anyAlive(stateDir, rivals)) { release(); throw lockError('busy'); }
  return release;
}

/**
 * Отметка запуска сервиса (монтажная или бот). Снимается при выходе процесса, в том числе по SIGINT/SIGTERM.
 * Пока работает команда организатора, сервис не стартует.
 */
export function holdServiceLock(stateDir, role) {
  const release = acquireLock(stateDir, role, [ORGANIZER_ROLE]);
  process.once('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    // Обработчик по умолчанию завершает процесс без события exit — тогда отметка осталась бы до проверки pid.
    if (process.listenerCount(sig) === 0) process.once(sig, () => process.exit(128 + (sig === 'SIGINT' ? 2 : 15)));
  }
  return release;
}
