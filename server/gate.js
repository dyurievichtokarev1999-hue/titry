// Шлюз выдачи: отдельная проверка безопасности и состояния остановки (особая зона).
// Контракт владельца 10.11 12:05 п. 3 и 13:05 п. 1; матрица QA 13:29 (S/U/T/V/L).
//
// Три состояния рассказа в одной области (монтажная — общая область, бот — сессия участника):
//  - safety    — подтверждённая опасность любого слоя. Ничем не снимается.
//  - technical — вторая подряд неполная отдельная проверка одной проверяемой версии
//                (reason check_incomplete_twice). Не вывод о содержании: без помощи и без urgent.
//                Снимается только полной успешной проверкой, запущенной явным действием организатора
//                не раньше retryNotBefore. Само истечение времени ничего не снимает.
//  - нет состояния — выдача возможна только после полной проверки этой версии (end_turn + строгий false).
//
// Первый неполный ответ — unavailable (503) без записи в blocked; счётчик в памяти процесса.
// Время паузы считается по монотонным часам; UTC-момент хранится для отображения и будущего журнала.
import crypto from 'node:crypto';
import { safeCode } from './errlog.js';

export const RETRY_AFTER_MS = 15 * 60 * 1000;

/** Действующая нормализация запрета (как storyKey): строка, нижний регистр, ё→е, сжатые пробелы. */
export function normStory(story) {
  return String(story ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}
export const storyDigest = (story) => crypto.createHash('sha256').update(`story\0${normStory(story)}`).digest('hex');

/**
 * Проверяемая версия: рассказ (как прислан) + явно перечисленные поля эпизода. Порядок строк сохраняется.
 * Плёнка, музыка, род и дата в версию не входят: они не меняют текст; safety по рассказу они не снимают (V02).
 */
export function versionDigest(story, ep) {
  const e = ep && typeof ep === 'object' ? ep : {};
  const rows = Array.isArray(e.rows) ? e.rows.map((r) => [String(r?.role ?? ''), String(r?.value ?? ''), String(r?.source ?? '')]) : [];
  const post = e.post && typeof e.post === 'object' ? [String(e.post.text ?? ''), String(e.post.source ?? '')] : ['', ''];
  const canon = JSON.stringify(['v1', String(story ?? ''), String(e.title ?? ''), String(e.genre ?? ''), rows, post]);
  return crypto.createHash('sha256').update(`episode\0${canon}`).digest('hex');
}

const monotonic = () => performance.now();

/**
 * check(text) — отдельная проверка: true — опасно, false — полное разрешение;
 * исключение с кодом — неполная проверка. hasKey() — есть ли доступ к модели.
 */
export function makeGate({ check, hasKey = () => true, monoNow = monotonic, wallNow = () => Date.now(), retryMs = RETRY_AFTER_MS } = {}) {
  const scopes = new Map();
  const area = (scope) => {
    let a = scopes.get(scope);
    if (!a) { a = { safety: new Set(), technical: new Map(), failures: new Map() }; scopes.set(scope, a); }
    return a;
  };

  function status(scope, story) {
    const a = area(scope);
    const sd = storyDigest(story);
    if (a.safety.has(sd)) return { kind: 'safety' };
    const t = a.technical.get(sd);
    if (t) return { kind: 'technical', reason: 'check_incomplete_twice', retryNotBeforeAt: t.retryNotBeforeAt, retryAllowed: monoNow() >= t.retryNotBefore };
    return { kind: null };
  }

  function markSafety(scope, story) {
    const a = area(scope);
    const sd = storyDigest(story);
    a.safety.add(sd);
    a.technical.delete(sd); // safety сильнее; technical больше не нужен
  }

  function setTechnical(a, sd) {
    const t = { retryNotBefore: monoNow() + retryMs, retryNotBeforeAt: new Date(wallNow() + retryMs).toISOString(), epoch: Symbol('technical'), retrying: false };
    a.technical.set(sd, t);
    return t;
  }

  // Одна полная отдельная проверка версии. Возвращает { ok } | { kind: 'safety' } | { unavailable, code } |
  // { kind: 'technical', code: 'check_incomplete_twice' }.
  async function runCheck(scope, story, ep, text) {
    const a = area(scope);
    const sd = storyDigest(story);
    const vd = versionDigest(story, ep);
    if (!hasKey()) return { unavailable: true, code: 'no_key' };
    let flagged, err;
    try { flagged = await check(text); } catch (e) { err = e; }
    // После ожидания: остановка могла прийти из параллельного запроса — она сильнее любого ответа.
    if (a.safety.has(sd)) return { kind: 'safety' };
    if (!err && flagged === true) { markSafety(scope, story); return { kind: 'safety' }; }
    if (!err && flagged === false) { a.failures.delete(vd); return { ok: true }; }
    // Неполная проверка: исключение или ответ не строго булев.
    const n = (a.failures.get(vd) || 0) + 1;
    if (n >= 2) {
      a.failures.delete(vd);
      const t = setTechnical(a, sd);
      return { kind: 'technical', code: 'check_incomplete_twice', retryNotBeforeAt: t.retryNotBeforeAt };
    }
    a.failures.set(vd, n);
    return { unavailable: true, code: err ? safeCode(err) : 'bad_response' };
  }

  /** Проверка перед выдачей: состояние → отдельная проверка версии. technical без действия организатора не проверяется. */
  async function verify(scope, story, ep, text) {
    const st = status(scope, story);
    if (st.kind) return st.kind === 'safety' ? { kind: 'safety' } : { kind: 'technical', code: 'check_incomplete_twice', retryNotBeforeAt: st.retryNotBeforeAt };
    const r = await runCheck(scope, story, ep, text);
    // Пока шла проверка, другой запрос мог поставить technical — тогда это разрешение не действует.
    if (r.ok) {
      const after = status(scope, story);
      if (after.kind === 'safety') return { kind: 'safety' };
      if (after.kind === 'technical') return { kind: 'technical', code: 'check_incomplete_twice', retryNotBeforeAt: after.retryNotBeforeAt };
    }
    return r;
  }

  /**
   * Явное действие организатора «повторить проверку». Только для technical, не раньше retryNotBefore,
   * не более одного одновременно. Полная проверка заново; false снимает technical именно этой эпохи.
   */
  async function organizerRetry(scope, story, ep, text) {
    const a = area(scope);
    const sd = storyDigest(story);
    if (a.safety.has(sd)) return { kind: 'safety' };
    const t = a.technical.get(sd);
    if (!t) return { notPaused: true };
    if (monoNow() < t.retryNotBefore) return { early: true, retryNotBeforeAt: t.retryNotBeforeAt };
    if (t.retrying) return { inProgress: true };
    t.retrying = true;
    try {
      const vd = versionDigest(story, ep);
      a.failures.set(vd, 1); // повтор после паузы: неполный ответ сразу возвращает technical
      const r = await runCheck(scope, story, ep, text);
      if (r.ok) {
        if (a.technical.get(sd) === t) a.technical.delete(sd);
        else return status(scope, story).kind === 'safety' ? { kind: 'safety' } : { kind: 'technical', code: 'check_incomplete_twice' };
        return { ok: true };
      }
      return r;
    } finally { t.retrying = false; }
  }

  return { status, markSafety, verify, organizerRetry, versionDigest, storyDigest };
}
