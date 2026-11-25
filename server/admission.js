// Допуск участников и пределы обращений к модели для закрытого теста G0 (особая зона, сливает Дмитрий).
// Решение Дмитрия 24.11, Б6, п. 2; план Критика реализации 20.11 (пункт 2), принят Claude 20.11.
// Список допущенных и пороги — только из окружения: в репозитории значений нет (примеры в .env.example вымышленные).
//  - TITRY_CLOSED_TEST=1 — закрытый режим: обрабатываются только чаты из TITRY_ALLOWED_CHATS (номера через запятую);
//    обязательны TITRY_STORIES_PER_DAY и TITRY_MODEL_CONCURRENCY. Пустая или неверная конфигурация — отказ старта.
//  - TITRY_STORIES_PER_DAY — рассказов (черновиков) на участника за скользящие 24 часа;
//  - TITRY_MODEL_CONCURRENCY — одновременных обращений к модели на процесс (черновик, проверки, повторы);
//    TITRY_MODEL_WAIT_MS — сколько ждать свободного места (по умолчанию 30 с).
// Предел общий только внутри одного процесса бота: в G0 — один процесс (чек-лист G0 v4, Б-3).

const DAY_MS = 24 * 60 * 60 * 1000;
const bad = (what) => Object.assign(new Error(`admission: ${what}`), { code: 'admission_config' });
const positive = (v, name) => {
  if (!/^\d+$/.test(String(v ?? '').trim()) || Number(v) < 1) throw bad(`${name} — целое число не меньше 1`);
  return Number(v);
};

/** Конфигурация из окружения. null — открытый режим без пределов. В журнал ошибок — только код, без списка. */
export function admissionFromEnv(env = process.env) {
  const closed = env.TITRY_CLOSED_TEST === '1';
  const set = (name) => env[name] !== undefined && String(env[name]).trim() !== '';
  if (!closed) {
    if (set('TITRY_ALLOWED_CHATS')) throw bad('TITRY_ALLOWED_CHATS задан без TITRY_CLOSED_TEST=1');
    if (!set('TITRY_STORIES_PER_DAY') && !set('TITRY_MODEL_CONCURRENCY')) return null;
  }
  let allowed = null;
  if (closed) {
    const ids = String(env.TITRY_ALLOWED_CHATS || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!ids.length || ids.some((x) => !/^-?\d{1,20}$/.test(x))) throw bad('TITRY_ALLOWED_CHATS — номера чатов через запятую');
    allowed = new Set(ids);
  }
  const perDay = closed || set('TITRY_STORIES_PER_DAY') ? positive(env.TITRY_STORIES_PER_DAY, 'TITRY_STORIES_PER_DAY') : Infinity;
  const concurrency = closed || set('TITRY_MODEL_CONCURRENCY') ? positive(env.TITRY_MODEL_CONCURRENCY, 'TITRY_MODEL_CONCURRENCY') : Infinity;
  const waitMs = set('TITRY_MODEL_WAIT_MS') ? positive(env.TITRY_MODEL_WAIT_MS, 'TITRY_MODEL_WAIT_MS') : 30000;
  return { allowed, perDay, concurrency, waitMs };
}

/** Допуск, предел на участника и общий предел обращений к модели по конфигурации admissionFromEnv. */
export function makeAdmission({ allowed = null, perDay = Infinity, concurrency = Infinity, waitMs = 30000 } = {}, { now = () => Date.now() } = {}) {
  const taken = new Map(); // номер чата → времена принятых рассказов за окно (только числа)
  let active = 0;
  const waiting = [];
  const release = () => {
    const next = waiting.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); } else active--;
  };
  return {
    allowed: (chatId) => !allowed || allowed.has(String(chatId)),
    /** Учесть рассказ участника; false — предел за 24 часа исчерпан (рассказ не учитывается). */
    take(chatId) {
      if (perDay === Infinity) return true;
      const t = now();
      const list = (taken.get(chatId) || []).filter((x) => t - x < DAY_MS);
      if (list.length >= perDay) { taken.set(chatId, list); return false; }
      list.push(t);
      taken.set(chatId, list);
      return true;
    },
    /** Вернуть последний учтённый рассказ: черновик не начат из-за занятых мест (model_busy) — предел не расходуется. */
    untake(chatId) { const list = taken.get(chatId); if (list && list.length) list.pop(); },
    /** Выполнить обращение к модели в пределах общего числа мест; место освобождается при любом исходе. */
    async run(fn) {
      if (concurrency !== Infinity) {
        if (active < concurrency) active++;
        else {
          await new Promise((resolve, reject) => {
            const w = { resolve };
            w.timer = setTimeout(() => {
              waiting.splice(waiting.indexOf(w), 1);
              reject(Object.assign(new Error('admission: нет свободного места'), { code: 'model_busy' }));
            }, waitMs);
            waiting.push(w);
          });
        }
      }
      try { return await fn(); } finally { if (concurrency !== Infinity) release(); }
    },
    sweep() { const t = now(); for (const [k, v] of taken) if (!v.some((x) => t - x < DAY_MS)) taken.delete(k); },
  };
}
