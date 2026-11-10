// Хранилище запретов (persistent blocked) — особая зона. План архитектора v1.1, разделы 2–6.
// На диск пишутся только производные HMAC-ключи и служебные поля: ни рассказа, ни строк, ни ID чата,
// ни ответа модели. Ключ HMAC — отдельный секрет (переменная окружения TITRY_BLOCKED_HMAC_KEY),
// версия ключа/нормализации — TITRY_BLOCKED_KEY_VERSION. Значения ключа нет в репозитории и журналах.
//
// Закрытый отказ: повреждённый или неподдерживаемый файл, неверный ключ/версия, ошибка чтения,
// недописанный tmp, сбой записи — ledger переходит в failed, и шлюз не выдаёт ролики до восстановления.
// Пустой набор запретов вместо повреждённого файла не подставляется никогда.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normStory } from './gate.js';

export const SCHEMA_VERSION = 1;
export const KEY_ENV = 'TITRY_BLOCKED_HMAC_KEY';
export const KEY_VERSION_ENV = 'TITRY_BLOCKED_KEY_VERSION';
const KINDS = new Set(['safety', 'technical']);
const REASONS = new Set(['safety', 'check_incomplete_twice']);
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const ledgerError = () => Object.assign(new Error('Хранилище запретов недоступно.'), { code: 'ledger' });

/**
 * file — путь к blocked-v1.json; key — секрет HMAC (Buffer/строка); keyVersion — версия ключа и нормализации.
 * ttlMs — срок хранения записи. Производственный срок не выбран (карта обработки), поэтому по умолчанию
 * null: запись без срока. Короткий ttlMs допускается только как параметр теста.
 */
export function makeLedger({ file, key, keyVersion, ttlMs = null, wallNow = () => Date.now(), fsImpl = fs } = {}) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let records = [];
  let state = 'closed'; // closed → ready | failed
  let chain = Promise.resolve();

  const hmac = (domain, value) => crypto.createHmac('sha256', key).update(`${domain}\0${keyVersion}\0${value}`).digest('hex');
  const keyCheck = () => hmac('keycheck', 'titry-blocked');
  // Подпись всего набора записей: удаление записи из файла без ключа не проходит загрузку.
  const docMac = (recs) => hmac('document', JSON.stringify(recs));
  const scopeDigest = (scope) => hmac('scope', String(scope));
  const storyDigest = (story) => hmac('story', normStory(story));

  function validRecord(r) {
    return r && typeof r === 'object' && !Array.isArray(r)
      && r.schema_version === SCHEMA_VERSION && r.key_version === keyVersion
      && HEX64.test(r.scope_digest) && HEX64.test(r.story_digest)
      && (r.episode_digest === null || HEX64.test(r.episode_digest))
      && KINDS.has(r.kind) && REASONS.has(r.reason)
      && ISO.test(r.created_at)
      && (r.kind === 'technical' ? ISO.test(r.retry_not_before_at) : r.retry_not_before_at === null)
      && (r.expires_at === null || ISO.test(r.expires_at));
  }

  function parse(text) {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || doc.schema_version !== SCHEMA_VERSION) throw ledgerError();
    if (doc.key_version !== keyVersion || doc.key_check !== keyCheck()) throw ledgerError();
    if (!Array.isArray(doc.records) || !doc.records.every(validRecord)) throw ledgerError();
    if (doc.doc_mac !== docMac(doc.records)) throw ledgerError();
    return doc.records;
  }

  const live = (r, now) => r.expires_at === null || Date.parse(r.expires_at) > now;
  const same = (a, b) => a.scope_digest === b.scope_digest && a.story_digest === b.story_digest && a.kind === b.kind;

  /** Загрузка до приёма задач. Недописанный tmp после аварии — восстановление объединением (только строже). */
  async function load() {
    // Ключ — не короче 16 символов (пустой или случайно короткий ключ — закрытый отказ).
    if (!key || String(key).length < 16 || !keyVersion) { state = 'failed'; throw ledgerError(); }
    try {
      await fsImpl.mkdir(dir, { recursive: true, mode: 0o700 });
      // Права выставляются и для уже существующего каталога и файла, не только при создании.
      await fsImpl.chmod(dir, 0o700);
      try { await fsImpl.chmod(file, 0o600); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
      let main = [];
      try { main = parse(await fsImpl.readFile(file, 'utf8')); }
      catch (e) { if (e?.code !== 'ENOENT') throw ledgerError(); }
      const tmps = (await fsImpl.readdir(dir)).filter((n) => n.startsWith(`${base}.tmp-`));
      for (const n of tmps) {
        // tmp содержит полный документ или ничего полезного: недописанный — закрытый отказ (могла пропасть остановка).
        const extra = parse(await fsImpl.readFile(path.join(dir, n), 'utf8'));
        for (const r of extra) if (!main.some((m) => same(m, r))) main.push(r);
      }
      records = main.filter((r) => live(r, wallNow()));
      state = 'ready';
      if (tmps.length) {
        await write();
        for (const n of tmps) await fsImpl.rm(path.join(dir, n), { force: true });
      }
    } catch {
      state = 'failed';
      throw ledgerError();
    }
  }

  async function write() {
    // Запись, которую потом нельзя загрузить, закрыла бы хранилище навсегда: проверяем до записи.
    if (!records.every(validRecord)) throw ledgerError();
    const doc = { schema_version: SCHEMA_VERSION, key_version: keyVersion, key_check: keyCheck(), records, doc_mac: docMac(records) };
    const tmp = path.join(dir, `${base}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    const fh = await fsImpl.open(tmp, 'wx', 0o600);
    try { await fh.writeFile(JSON.stringify(doc)); await fh.sync(); } finally { await fh.close(); }
    await fsImpl.rename(tmp, file);
    const d = await fsImpl.open(dir, 'r');
    try { await d.sync(); } finally { await d.close(); }
  }

  // Изменения сериализованы одним процессом; сбой записи — failed, без «сохранено».
  function mutate(fn) {
    const run = chain.then(async () => {
      if (state !== 'ready') throw ledgerError();
      records = fn(records.filter((r) => live(r, wallNow())));
      // Память остаётся строже (новая остановка уже действует); выдача закрыта до восстановления.
      try { await write(); } catch { state = 'failed'; throw ledgerError(); }
    });
    chain = run.catch(() => {});
    return run;
  }

  function put({ scope, story, episodeDigest = null, kind, reason, retryNotBeforeAt = null }) {
    const now = wallNow();
    const rec = {
      schema_version: SCHEMA_VERSION, key_version: keyVersion,
      scope_digest: scopeDigest(scope), story_digest: storyDigest(story),
      episode_digest: episodeDigest ? hmac('episode', episodeDigest) : null,
      kind, reason, created_at: new Date(now).toISOString(),
      retry_not_before_at: kind === 'technical' ? retryNotBeforeAt : null,
      expires_at: ttlMs === null ? null : new Date(now + ttlMs).toISOString(),
    };
    if (!validRecord(rec)) return Promise.reject(ledgerError()); // неверный вызов — не портить файл
    return mutate((rs) => {
      const rest = rs.filter((r) => !same(r, rec));
      // safety сильнее: при safety technical той же пары не нужен; technical не пишется поверх safety.
      if (kind === 'safety') return [...rest.filter((r) => !(r.scope_digest === rec.scope_digest && r.story_digest === rec.story_digest && r.kind === 'technical')), rec];
      if (rs.some((r) => r.kind === 'safety' && r.scope_digest === rec.scope_digest && r.story_digest === rec.story_digest)) return rs;
      return [...rest, rec];
    });
  }

  /** Снять technical (только после полной успешной проверки по действию организатора). safety не трогается. */
  function clearTechnical(scope, story) {
    const sd = scopeDigest(scope), st = storyDigest(story);
    return mutate((rs) => rs.filter((r) => !(r.kind === 'technical' && r.scope_digest === sd && r.story_digest === st)));
  }

  function lookup(scope, story) {
    if (state !== 'ready') return { failed: true };
    const sd = scopeDigest(scope), st = storyDigest(story), now = wallNow();
    const mine = records.filter((r) => r.scope_digest === sd && r.story_digest === st && live(r, now));
    if (mine.some((r) => r.kind === 'safety')) return { kind: 'safety' };
    const t = mine.find((r) => r.kind === 'technical');
    return t ? { kind: 'technical', retryNotBeforeAt: t.retry_not_before_at } : { kind: null };
  }

  /** Дождаться подтверждения всех начатых записей. false — непрерывность не подтверждена. */
  async function flush() { await chain; return state === 'ready'; }

  return { load, put, clearTechnical, lookup, flush, healthy: () => state === 'ready', get size() { return records.length; } };
}
