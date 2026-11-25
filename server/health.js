// Проверка состояния бота (особая зона). Решение Дмитрия 24.11, Б6 п. 5; план Критика реализации 20.11 (пункт 5),
// ответ Claude 20.11: до выбора инфраструктуры — только интерфейс проверки и различение состояний, без внешних
// отправок. Внешний наблюдатель (после решения по хосту) читает файл снимка и сам решает, кого и когда оповещать.
// В снимке только время, состояния и счётчик подряд идущих сбоев опроса: ни номеров чатов, ни текстов, ни ключей.
import fs from 'node:fs/promises';
import path from 'node:path';

export const POLL_STALE_MS = 2 * 60 * 1000; // опрос Telegram дольше этого без успеха — «обновления не поступают»

export function makeHealth({ now = () => Date.now(), staleMs = POLL_STALE_MS } = {}) {
  let lastOk = null;
  let failures = 0; // сбоев опроса подряд
  return {
    pollOk() { lastOk = now(); failures = 0; },
    pollFailed() { failures++; },
    /**
     * Снимок: process — процесс жив (снимок вообще пишется); updates — опрос Telegram успешен недавно (fresh),
     * давно (stale) или ещё ни разу (starting); state — хранилище запретов доступно (ok) или нет (failed).
     */
    snapshot({ stateHealthy }) {
      const t = now();
      const updates = lastOk === null ? 'starting' : t - lastOk <= staleMs ? 'fresh' : 'stale';
      return { at: new Date(t).toISOString(), process: 'alive', updates, state: stateHealthy ? 'ok' : 'failed', poll_failures: failures };
    },
  };
}

/** Записать снимок атомарно (временный файл и переименование), права 0600. */
export async function writeHealth(file, snap) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(snap)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}
