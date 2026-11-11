// Отметка «сервис запущен» (особая зона рядом с хранилищем запретов). Нужна, чтобы команда организатора
// (scripts/organizer.js) меняла data/state/blocked-v1.json только при остановленных монтажной и боте:
// иначе запущенный процесс держит хранилище в памяти и при следующей записи вернул бы снятую запись,
// а запись safety, сделанная сервисом между загрузкой и записью команды, могла бы пропасть с диска.
//
// Устройство: каталог data/state/run/, в нём файл на каждый процесс — <роль>.<pid>.pid (роли studio, bot,
// organizer). Протокол «сначала отметься, потом смотри на других»: каждая сторона атомарно создаёт свой файл (wx),
// затем проверяет файлы противоположной стороны. Если две стороны стартуют одновременно, хотя бы одна
// увидит другую и откажет. Несколько экземпляров одной роли друг другу не мешают (поведение сервиса не меняется).
//
// Живость: pid и время старта процесса (поле 22 /proc/<pid>/stat). Отметка процесса, которого уже нет
// (kill -9, сбой питания, перезагрузка с переиспользованием pid), не мешает и удаляется при проверке.
// Ограничение: проверка видит процессы только в своём пространстве pid — команду запускают на той же машине
// и в том же контейнере, что сервис (README).
// В файл пишутся только pid и время старта; ни ключей, ни рассказов, ни путей.
import fs from 'node:fs';
import path from 'node:path';

export const SERVICE_ROLES = ['studio', 'bot'];
export const ORGANIZER_ROLE = 'organizer';

const lockError = (code) => Object.assign(new Error('Отметка запуска недоступна.'), { code });

/** Время старта процесса (тики с загрузки) или null, если /proc недоступен (не Linux). */
export function startTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Имя процесса в скобках может содержать пробелы: поля считаются после последней «)».
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const v = fields[19]; // поле 22 от начала строки
    return /^\d+$/.test(v) ? v : null;
  } catch { return null; }
}

/** Жив ли процесс: EPERM — процесс есть, но чужой (считаем живым: закрытый отказ). */
export function pidAlive(pid, start = null) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { if (e?.code !== 'EPERM') return false; }
  // pid занят другим процессом (переиспользован) — прежний владелец отметки умер.
  if (start !== null) { const now = startTime(pid); if (now !== null && now !== start) return false; }
  return true;
}

const runDir = (stateDir) => path.join(stateDir, 'run');
const NAME = /^([a-z]+)\.(\d+)\.pid$/;

/** { pid, start } из файла; NaN — файл нечитаем или испорчен (считается живым — закрытый отказ); null — файла уже нет. */
function readMark(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return null; return NaN; }
  const m = /^(\d+)(?: (\d+))?\n?$/.exec(text);
  return m ? { pid: Number.parseInt(m[1], 10), start: m[2] ?? null } : NaN;
}

/**
 * Есть ли живой процесс любой из ролей. Нечитаемый каталог или файл — «жив»: лучше отказать, чем снять паузу
 * под работающим сервисом. Отметки умерших процессов удаляются.
 */
export function anyAlive(stateDir, roles) {
  let names;
  try { names = fs.readdirSync(runDir(stateDir)); } catch (e) { if (e?.code === 'ENOENT') return false; return true; }
  for (const n of names) {
    const m = NAME.exec(n);
    if (!m || !roles.includes(m[1])) continue;
    const file = path.join(runDir(stateDir), n);
    const mark = readMark(file);
    if (mark === null) continue;
    if (Number.isNaN(mark) || mark.pid !== Number.parseInt(m[2], 10)) return true;
    if (pidAlive(mark.pid, mark.start)) return true;
    try { fs.rmSync(file, { force: true }); } catch { /* не помешает: при следующей проверке снова распознается */ }
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
  const start = startTime(pid);
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeSync(fd, start === null ? `${pid}\n` : `${pid} ${start}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    try { fs.rmSync(file, { force: true }); } catch { /* устаревшую отметку распознает проверка pid */ }
  };
  if (anyAlive(stateDir, rivals)) { release(); throw lockError('busy'); }
  return release;
}

/** Снять отметку при выходе и при сигналах завершения; после снятия сигнал повторяется с действием по умолчанию. */
export function releaseOnExit(release) {
  process.once('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    if (process.listenerCount(sig) > 0) continue; // чужой обработчик решает сам и завершит через exit
    const onSig = () => { release(); process.removeListener(sig, onSig); process.kill(process.pid, sig); };
    process.on(sig, onSig);
  }
}

/**
 * Отметка запуска сервиса (монтажная или бот). Снимается при выходе процесса, в том числе по SIGINT/SIGTERM/SIGHUP.
 * Пока работает команда организатора, сервис не стартует.
 */
export function holdServiceLock(stateDir, role) {
  const release = acquireLock(stateDir, role, [ORGANIZER_ROLE]);
  releaseOnExit(release);
  return release;
}

/**
 * ИР10-2: взаимоисключение команд организатора между собой. Один общий файл-замок run/organizer.mutex,
 * создаётся атомарно (wx). Если он есть и его владелец жив — отказ (code 'busy_organizer'). Отметка умершего
 * владельца (pid и время старта не совпадают с живым процессом) удаляется, попытка повторяется один раз.
 * Возвращает release().
 */
export function acquireOrganizerMutex(stateDir, { pid = process.pid } = {}) {
  fs.mkdirSync(runDir(stateDir), { recursive: true, mode: 0o700 });
  const file = path.join(runDir(stateDir), 'organizer.mutex');
  const start = startTime(pid);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      const mark = readMark(file);
      if (mark === null) continue; // владелец только что снял замок
      if (Number.isNaN(mark) || pidAlive(mark.pid, mark.start)) throw lockError('busy_organizer');
      try { fs.rmSync(file, { force: true }); } catch { throw lockError('busy_organizer'); }
      continue;
    }
    try { fs.writeSync(fd, start === null ? `${pid}\n` : `${pid} ${start}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      // Снимаем только свой замок (после аварии и повторного захвата другим процессом файл уже чужой).
      const mark = readMark(file);
      if (mark && !Number.isNaN(mark) && mark.pid === pid) { try { fs.rmSync(file, { force: true }); } catch { /* распознается по pid */ } }
    };
  }
  throw lockError('busy_organizer');
}
