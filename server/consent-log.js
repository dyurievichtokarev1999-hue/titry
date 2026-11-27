// Хранилище отметок о согласии (особая зона, сливает Дмитрий). Решение Дмитрия 24.11, А7: отдельное хранилище —
// код участника, версия текста, кнопка, время; текстов рассказов нет. Срок хранения — после ответа юриста
// (комплект v2.7, Д-14); до него записи не удаляются, /delete их не стирает (комплект: «отметку о согласии и отзыве»).
// Код участника — тот же HMAC номера чата, что в метриках (METRICS_SALT): номера Telegram в файле нет.
// Формат — строка JSON на событие: { at, participant, step, answer, version }.
import fs from 'node:fs/promises';
import path from 'node:path';

/** Шаги и ответы, которые попадают в хранилище: кнопки экранов 6Г, 6Б, 6В и команда /delete. */
const STEPS = new Set(['age', 'pd', 'abroad', 'delete']);
const ANSWERS = new Set(['yes', 'no', 'withdraw']);

/** Проба при старте: каталог и файл создаются, в файл можно писать, права файла — 0600 (и для уже существующего). */
export async function probeConsentLog(file) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.appendFile(file, '', { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/** Запись дольше этого — зависла (диск, сеть). После этого новые подтверждения («да») не добавляются — отклоняются сразу.
 *  Отказы и отзывы по-прежнему ждут в очереди в памяти процесса и запишутся после освобождения; при перезапуске
 *  во время зависания они теряются. Очередь растёт от действий участников закрытого теста и /delete (его может прислать и чат вне списка). Признак зависания —
 *  код consent_log_stuck в журнале ошибок. */
export const CONSENT_STUCK_MS = 30 * 1000;

export function makeConsentLog(file, { hash, now = () => new Date(), stuckMs = CONSENT_STUCK_MS, clock = () => performance.now() }) {
  if (typeof hash !== 'function') throw new Error('consent-log: нужна функция кода участника');
  let ops = Promise.resolve();
  let busySince = 0; // время начала текущей записи; 0 — записи нет
  // Действует ли согласие 6Б участника по журналу: после последнего отзыва 6Б, 6Г («Нет» на возрасте) или /delete есть
  // «да» на 6Б. Отзыв 6В — служебный, за поздней «да» на передачу — согласие 6Б не снимает. Вызывается внутри очереди.
  const activeNow = async (who) => {
    busySince = clock(); // зависшее чтение — тоже зависание: новые «да» отклоняются сразу
    const text = await fs.readFile(file, 'utf8').catch((e) => { if (e.code === 'ENOENT') return ''; throw e; }).finally(() => { busySince = 0; });
    let on = false;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.participant !== who) continue;
      if (r.answer === 'withdraw' && r.step !== 'abroad') on = false;
      else if (r.step === 'pd' && r.answer === 'yes') on = true;
    }
    return on;
  };
  const append = async (line) => {
    busySince = clock();
    try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.appendFile(file, line, { mode: 0o600 });
    } finally { busySince = 0; }
  };
  const lineOf = (chatId, step, answer, version) => `${JSON.stringify({ at: now().toISOString(), participant: hash(chatId), step, answer, version: String(version || '') })}\n`;
  const queue = (fn) => { const run = ops.then(fn); ops = run.catch(() => {}); return run; };
  return {
    active: (chatId) => queue(() => activeNow(hash(chatId))),
    /** Отзыв, если согласие 6Б по журналу действует: проверка и запись — одним звеном очереди (два /delete подряд —
     *  одна строка). Нужен после перезапуска, когда память процесса пуста. true — отзыв записан. */
    withdrawIfActive(chatId, { step, version }) {
      if (!STEPS.has(step)) return Promise.reject(Object.assign(new Error('consent-log: неизвестная отметка'), { code: 'consent_bad_mark' }));
      return queue(async () => {
        if (!(await activeNow(hash(chatId)))) return false;
        await append(lineOf(chatId, step, 'withdraw', version));
        return true;
      });
    },
    /** Записать отметку. Промис отклоняется при сбое записи: вызывающий решает, засчитывать ли шаг. */
    record(chatId, { step, answer, version }) {
      if (!STEPS.has(step) || !ANSWERS.has(answer)) return Promise.reject(Object.assign(new Error('consent-log: неизвестная отметка'), { code: 'consent_bad_mark' }));
      // Очередь не обгоняет зависшую запись: порядок строк (да → отзыв) важнее. Пока она висит, новые «да» отклоняются
      // сразу — шаг не засчитывается, бот отвечает «не получилось сохранить». Отказ и отзыв встают в очередь, как раньше:
      // они запишутся после освобождения (человека это не задерживает — бот их не ждёт), отзыв не теряется.
      if (answer === 'yes' && busySince && clock() - busySince > stuckMs) return Promise.reject(Object.assign(new Error('consent-log: запись зависла'), { code: 'consent_log_stuck' }));
      const line = lineOf(chatId, step, answer, version); // время — нажатия, а не записи
      return queue(() => append(line));
    },
  };
}
