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

/** Запись дольше этого — зависла (диск, сеть): новые отметки отклоняются сразу, а не копятся за ней. */
export const CONSENT_STUCK_MS = 30 * 1000;

export function makeConsentLog(file, { hash, now = () => new Date(), stuckMs = CONSENT_STUCK_MS, clock = Date.now }) {
  if (typeof hash !== 'function') throw new Error('consent-log: нужна функция кода участника');
  let ops = Promise.resolve();
  let busySince = 0; // время начала текущей записи; 0 — записи нет
  return {
    /** Записать отметку. Промис отклоняется при сбое записи: вызывающий решает, засчитывать ли шаг. */
    record(chatId, { step, answer, version }) {
      if (!STEPS.has(step) || !ANSWERS.has(answer)) return Promise.reject(Object.assign(new Error('consent-log: неизвестная отметка'), { code: 'consent_bad_mark' }));
      // Очередь не обгоняет зависшую запись: порядок строк (да → отзыв) важнее. Пока она висит, отметки не принимаются —
      // «Да» не засчитывается, бот отвечает «не получилось сохранить»; отказ и /delete не задерживаются (сбой в журнал ошибок).
      if (busySince && clock() - busySince > stuckMs) return Promise.reject(Object.assign(new Error('consent-log: запись зависла'), { code: 'consent_log_stuck' }));
      const line = `${JSON.stringify({ at: now().toISOString(), participant: hash(chatId), step, answer, version: String(version || '') })}\n`;
      const run = ops.then(async () => {
        busySince = clock();
        try {
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await fs.appendFile(file, line, { mode: 0o600 });
        } finally { busySince = 0; }
      });
      ops = run.catch(() => {});
      return run;
    },
  };
}
