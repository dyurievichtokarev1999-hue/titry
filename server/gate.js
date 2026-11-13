// Шлюз выдачи: одна модельная проверка перед рендером и состояние остановки (особая зона).
// Решение владельца кода (Claude) 13.11 15:00:
//  - модельная проверка одна: перед рендером, на всём, что попадает в ролик; локальный фильтр (server/safety.js)
//    работает всегда и держит минимум, модель ловит неявное сверх минимума;
//  - «неизвестно» (таймаут или ошибка модели): один повтор через несколько секунд; дальше решает вызывающий
//    по локальному уровню (чисто — ролик делается; есть concern — ролика нет, «не получилось» и контакты);
//  - нет ключа API: режим «только локальный фильтр», проверка не вызывается и «не завершилась» не говорит.
//
// Состояние рассказа в области (монтажная — общая область 'studio', бот — участник 'chat:<id>'):
//  - safety — подтверждённая опасность любого слоя. Ничем не снимается, хранится в хранилище запретов;
//  - нет состояния — выдача после проверки.
// Техническая пауза второй проверки (technical, повтор организатора) и объединение проверок одного рассказа убраны.
import crypto from 'node:crypto';
import { safeCode } from './errlog.js';

/** Пауза перед единственным повтором модельной проверки при «неизвестно». */
export const RETRY_DELAY_MS = 3000;

/** Действующая нормализация запрета (как storyKey): строка, нижний регистр, ё→е, сжатые пробелы. */
export function normStory(story) {
  return String(story ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}
// Ключ рассказа в памяти процесса. Живёт только в памяти, не пишется в журнал, метрики и тексты ошибок.
// Переживающие перезапуск записи хранилища считаются отдельно (server/ledger.js, свой HMAC).
export const storyDigest = (story) => crypto.createHash('sha256').update(`story\0${normStory(story)}`).digest('hex');

/**
 * Проверяемая версия: рассказ (как прислан) + явно перечисленные поля эпизода. Порядок строк сохраняется.
 * Плёнка, музыка, род и дата в версию не входят: они не меняют текст. Хранилище пишет её как hmac('episode', …).
 */
export function versionDigest(story, ep) {
  const e = ep && typeof ep === 'object' ? ep : {};
  const rows = Array.isArray(e.rows) ? e.rows.map((r) => [String(r?.role ?? ''), String(r?.value ?? ''), String(r?.source ?? '')]) : [];
  const post = e.post && typeof e.post === 'object' ? [String(e.post.text ?? ''), String(e.post.source ?? '')] : ['', ''];
  const canon = JSON.stringify(['v1', String(story ?? ''), String(e.title ?? ''), String(e.genre ?? ''), rows, post]);
  return crypto.createHash('sha256').update(`episode\0${canon}`).digest('hex');
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * check(text) — модельная проверка: true — опасно, false — безопасно; исключение с кодом — «неизвестно».
 * hasKey() — есть ли доступ к модели. ledger — хранилище запретов (server/ledger.js), необязательно.
 * Остановка ставится в памяти сразу, затем подтверждается запись на диск; пока запись не подтверждена
 * или хранилище неисправно, выдачи нет (код ledger).
 */
export function makeGate({ check, hasKey = () => true, ledger = null, retryDelayMs = RETRY_DELAY_MS, sleep = wait } = {}) {
  const durable = (scope) => ledger && typeof scope === 'string';
  const persist = (p) => { p.catch(() => { /* хранилище само переходит в failed; выдача закрыта */ }); return p; };
  const scopes = new Map();
  const area = (scope) => {
    let a = scopes.get(scope);
    if (!a) { a = { safety: new Set() }; scopes.set(scope, a); }
    return a;
  };

  /** { kind: 'safety' } | { kind: 'unavailable', code: 'ledger' } | { kind: null }. */
  function status(scope, story) {
    const a = area(scope);
    const sd = storyDigest(story);
    if (a.safety.has(sd)) return { kind: 'safety' };
    if (durable(scope)) {
      const l = ledger.lookup(scope, story);
      if (l.failed) return { kind: 'unavailable', code: 'ledger' };
      // Записи technical прежних версий больше ничего не запрещают: паузы второй проверки нет.
      if (l.kind === 'safety') { a.safety.add(sd); return { kind: 'safety' }; }
    }
    return { kind: null };
  }

  function markSafety(scope, story) {
    area(scope).safety.add(storyDigest(story));
    if (durable(scope)) persist(ledger.put({ scope, story, kind: 'safety', reason: 'safety' }));
  }

  const ledgerOk = async (scope) => !durable(scope) || ledger.flush();

  // Один вызов модели и не больше одного повтора: true | false | { unknown: code }.
  async function ask(text) {
    let code;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(retryDelayMs);
      try {
        const flagged = await check(text);
        if (flagged === true || flagged === false) return flagged;
        code = 'bad_response';
      } catch (e) { code = safeCode(e); }
    }
    return { unknown: code };
  }

  /**
   * Проверка перед выдачей. Возвращает:
   *  { ok: true } — безопасно; { ok: true, localOnly: true } — ключа нет, решает только локальный фильтр;
   *  { kind: 'safety', byModel } — опасно (запрет записан); { unknown: true, code } — модель не ответила и после
   *  повтора; { unavailable: true, code: 'ledger' } — хранилище запретов недоступно (выдачи нет).
   * text — всё, что попадёт в ролик; story — ключ запрета.
   */
  async function verify(scope, story, ep, text) {
    const st = status(scope, story);
    if (st.kind === 'safety') return { kind: 'safety', byModel: false };
    if (st.kind) return { unavailable: true, code: st.code };
    if (!hasKey()) return { ok: true, localOnly: true };
    if (!(await ledgerOk(scope))) return { unavailable: true, code: 'ledger' };
    const res = await ask(text);
    // Остановка, пришедшая из параллельного запроса за время проверки, сильнее любого ответа.
    if (area(scope).safety.has(storyDigest(story))) return { kind: 'safety', byModel: false };
    if (res === true) { markSafety(scope, story); return { kind: 'safety', byModel: true }; }
    if (res !== false) return { unknown: true, code: res.unknown };
    if (!(await ledgerOk(scope))) return status(scope, story).kind === 'safety' ? { kind: 'safety', byModel: false } : { unavailable: true, code: 'ledger' };
    const after = status(scope, story);
    if (after.kind === 'safety') return { kind: 'safety', byModel: false };
    if (after.kind) return { unavailable: true, code: after.code };
    return { ok: true };
  }

  /**
   * Какие запреты сохранены в области: Set из 'safety' / 'technical' (technical — только старые записи хранилища);
   * пустой — нет записей; null — хранилище недоступно, состояние неизвестно.
   */
  function recordsFor(scope) {
    const a = scopes.get(scope);
    const kinds = new Set();
    if (a && a.safety.size) kinds.add('safety');
    if (durable(scope)) {
      const l = ledger.scopeKinds(scope);
      if (l === null) return null;
      for (const k of l) kinds.add(k);
    }
    return kinds;
  }

  return { status, markSafety, verify, recordsFor, versionDigest, storyDigest };
}

/** Есть ли доступ к модели по переменным окружения (как hasClaudeCredentials в server/draft.js). */
export const keyInEnv = (env = process.env) => Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);

/**
 * Режим проверки при старте бота и монтажной (условие 4). Нет ключа API:
 *  - при TITRY_RELEASE_REAL_DATA=1 — исключение с кодом no_key (вызывающий не стартует);
 *  - иначе одна строка-предупреждение в журнал и режим «только локальный фильтр».
 * В строке — только этап и код, без текстов.
 */
export function modelModeAtStart({ env = process.env, log = console.error } = {}) {
  if (keyInEnv(env)) return 'model';
  if (env.TITRY_RELEASE_REAL_DATA === '1') throw Object.assign(new Error('startup'), { code: 'no_key', stage: 'model.key' });
  log(JSON.stringify({ at: new Date().toISOString(), level: 'warn', stage: 'model.key', code: 'no_key', mode: 'local_only' }));
  return 'local_only';
}
