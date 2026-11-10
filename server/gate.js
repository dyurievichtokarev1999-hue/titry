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
// ledger — хранилище запретов (server/ledger.js), необязательно. Сохраняются области-строки:
// монтажная 'studio', бот — участник 'chat:<id>' (на диск — только HMAC области).
// Сначала остановка ставится в памяти и выдача запрещается, затем подтверждается запись на диск;
// пока запись не подтверждена или хранилище неисправно, выдачи нет (503, код ledger).
export function makeGate({ check, hasKey = () => true, monoNow = monotonic, wallNow = () => Date.now(), retryMs = RETRY_AFTER_MS, ledger = null } = {}) {
  const durable = (scope) => ledger && typeof scope === 'string';
  const persist = (p) => { p.catch(() => { /* хранилище само переходит в failed; выдача закрыта */ }); return p; };
  const scopes = new Map();
  const area = (scope) => {
    let a = scopes.get(scope);
    // failures: storyDigest → { vd, n } — подряд идущие неполные ответы одной версии; epoch — номер «эпохи» рассказа:
    // меняется при новой паузе и при ручном повторе; ответы, начатые в прежней эпохе, не учитываются в счётчике.
    if (!a) { a = { safety: new Set(), technical: new Map(), failures: new Map(), epochs: new Map() }; scopes.set(scope, a); }
    return a;
  };

  function status(scope, story) {
    const a = area(scope);
    const sd = storyDigest(story);
    if (a.safety.has(sd)) return { kind: 'safety' };
    if (durable(scope)) {
      const l = ledger.lookup(scope, story);
      if (l.failed) return { kind: 'unavailable', code: 'ledger' };
      if (l.kind === 'safety') { a.safety.add(sd); a.technical.delete(sd); return { kind: 'safety' }; }
      if (l.kind === 'technical' && !a.technical.has(sd)) {
        // После перезапуска монотонное время прежнего процесса недоступно: отсчёт заново, полные 15 минут
        // от загрузки (никогда не раньше сохранённого UTC-момента). Перезапуск не даёт раннего повтора.
        const at = Math.max(Date.parse(l.retryNotBeforeAt) || 0, wallNow() + retryMs);
        bumpEpoch(a, sd);
        a.technical.set(sd, { retryNotBefore: monoNow() + retryMs, retryNotBeforeAt: new Date(at).toISOString(), epoch: Symbol('technical'), retrying: false });
      }
    }
    const t = a.technical.get(sd);
    if (t) return { kind: 'technical', reason: 'check_incomplete_twice', retryNotBeforeAt: t.retryNotBeforeAt, retryAllowed: monoNow() >= t.retryNotBefore };
    return { kind: null };
  }

  function markSafety(scope, story) {
    const a = area(scope);
    const sd = storyDigest(story);
    a.safety.add(sd);
    a.technical.delete(sd); // safety сильнее; technical больше не нужен
    if (durable(scope)) persist(ledger.put({ scope, story, kind: 'safety', reason: 'safety' }));
  }

  const epochOf = (a, sd) => a.epochs.get(sd) || 0;
  const bumpEpoch = (a, sd) => { a.epochs.set(sd, epochOf(a, sd) + 1); a.failures.delete(sd); };

  function setTechnical(scope, story, a, sd, vd) {
    bumpEpoch(a, sd);
    const t = { retryNotBefore: monoNow() + retryMs, retryNotBeforeAt: new Date(wallNow() + retryMs).toISOString(), epoch: Symbol('technical'), retrying: false };
    a.technical.set(sd, t);
    if (durable(scope)) persist(ledger.put({ scope, story, episodeDigest: vd, kind: 'technical', reason: 'check_incomplete_twice', retryNotBeforeAt: t.retryNotBeforeAt }));
    return t;
  }
  const ledgerOk = async (scope) => !durable(scope) || ledger.flush();

  // Одна полная отдельная проверка версии. Возвращает { ok } | { kind: 'safety' } | { unavailable, code } |
  // { kind: 'technical', code: 'check_incomplete_twice' }.
  async function runCheck(scope, story, ep, text) {
    const a = area(scope);
    const sd = storyDigest(story);
    const vd = versionDigest(story, ep);
    if (!hasKey()) return { unavailable: true, code: 'no_key' };
    const epoch = epochOf(a, sd);
    let flagged, err;
    try { flagged = await check(text); } catch (e) { err = e; }
    // После ожидания: остановка могла прийти из параллельного запроса — она сильнее любого ответа.
    if (a.safety.has(sd)) return { kind: 'safety' };
    if (!err && flagged === true) { markSafety(scope, story); return { kind: 'safety' }; }
    const stale = epochOf(a, sd) !== epoch; // ответ начат до новой паузы или до ручного повтора
    if (!err && flagged === false) { if (!stale) a.failures.delete(sd); return { ok: true, stale }; }
    const code = err ? safeCode(err) : 'bad_response';
    if (stale) return { unavailable: true, code }; // поздний сбой прежней попытки счётчик не двигает
    // Неполная проверка: «подряд» — для одной версии; сбой другой версии начинает счёт заново.
    const prev = a.failures.get(sd);
    const n = prev && prev.vd === vd ? prev.n + 1 : 1;
    if (n >= 2) {
      const t = setTechnical(scope, story, a, sd, vd);
      return { kind: 'technical', code: 'check_incomplete_twice', retryNotBeforeAt: t.retryNotBeforeAt };
    }
    a.failures.set(sd, { vd, n });
    return { unavailable: true, code };
  }

  /** Проверка перед выдачей: состояние → отдельная проверка версии. technical без действия организатора не проверяется. */
  async function verify(scope, story, ep, text) {
    const fromStatus = (st) => (st.kind === 'safety' ? { kind: 'safety' } : st.kind === 'unavailable' ? { unavailable: true, code: st.code }
      : { kind: 'technical', code: 'check_incomplete_twice', retryNotBeforeAt: st.retryNotBeforeAt });
    const st = status(scope, story);
    if (st.kind) return fromStatus(st);
    if (!(await ledgerOk(scope))) return { unavailable: true, code: 'ledger' };
    const r = await runCheck(scope, story, ep, text);
    // Пока шла проверка, другой запрос мог поставить technical — тогда это разрешение не действует.
    // Разрешение выдаётся только при подтверждённой записи всех начатых остановок.
    if (r.ok) {
      if (!(await ledgerOk(scope))) return status(scope, story).kind === 'safety' ? { kind: 'safety' } : { unavailable: true, code: 'ledger' };
      const after = status(scope, story);
      if (after.kind === 'unavailable') return fromStatus(after);
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
    const st = status(scope, story); // подтягивает запись хранилища после перезапуска
    if (st.kind === 'safety') return { kind: 'safety' };
    if (st.kind === 'unavailable') return { unavailable: true, code: st.code };
    const t = a.technical.get(sd);
    if (!t) return { notPaused: true };
    if (monoNow() < t.retryNotBefore) return { early: true, retryNotBeforeAt: t.retryNotBeforeAt };
    if (t.retrying) return { inProgress: true };
    t.retrying = true;
    try {
      bumpEpoch(a, sd); // ответы прежних попыток больше не влияют на счёт
      a.failures.set(sd, { vd: versionDigest(story, ep), n: 1 }); // повтор после паузы: неполный ответ сразу возвращает technical
      const r = await runCheck(scope, story, ep, text);
      if (r.ok) {
        if (a.technical.get(sd) !== t) return status(scope, story).kind === 'safety' ? { kind: 'safety' } : { kind: 'technical', code: 'check_incomplete_twice' };
        if (durable(scope)) {
          // Снятие — только с подтверждённой записью; иначе пауза остаётся.
          try { await ledger.clearTechnical(scope, story); } catch { return { unavailable: true, code: 'ledger' }; }
          if (a.technical.get(sd) !== t) return status(scope, story).kind === 'safety' ? { kind: 'safety' } : { kind: 'technical', code: 'check_incomplete_twice' };
        }
        a.technical.delete(sd);
        return { ok: true };
      }
      return r;
    } finally { t.retrying = false; }
  }

  /** Есть ли в области сохранённые запреты: 'none' | 'kept' | 'unknown' (хранилище недоступно). */
  function recordsFor(scope) {
    const a = scopes.get(scope);
    const inMemory = !!a && (a.safety.size > 0 || a.technical.size > 0);
    if (durable(scope)) {
      const l = ledger.scopeHasRecords(scope);
      if (l === null) return 'unknown';
      return l || inMemory ? 'kept' : 'none';
    }
    return inMemory ? 'kept' : 'none';
  }

  return { status, markSafety, verify, organizerRetry, recordsFor, versionDigest, storyDigest };
}
