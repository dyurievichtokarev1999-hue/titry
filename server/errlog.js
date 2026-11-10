// ИР-03 (критик реализации): обезличенный журнал ошибок. В журнал попадают только этап, код, время и версия —
// без сообщения, стека, текста рассказа, строк, путей и идентификаторов. Сообщения и стеки исключений
// могут содержать фрагменты рассказа (ошибки API, проверки, распознавания), поэтому их не пишем вовсе.
import fs from 'node:fs';

let version = 'unknown';
try { version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown'; } catch { /* остаётся unknown */ }

// Код — только из явного списка известных значений (критик реализации, 10.11). Исходное значение
// e.code / e.status / e.name никогда не пишется: даже короткая строка может прийти из внешнего клиента.
// Неизвестное → 'error'.
const KNOWN_CODES = new Set([
  // свои коды приложения
  'safety', 'timeout', 'browser', 'tmp_cleanup_pending', 'empty', 'stt_off', 'too_long', 'refusal',
  // файловая система и сеть Node
  'ENOENT', 'ENOSPC', 'EACCES', 'EPERM', 'EIO', 'EEXIST', 'EMFILE', 'ENOTDIR', 'EISDIR', 'EBUSY', 'EROFS',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE',
]);
const KNOWN_STATUSES = new Set([400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504, 529]);
const KNOWN_NAMES = new Set(['TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AbortError', 'TimeoutError']);

export function safeCode(e) {
  if (typeof e?.code === 'string' && KNOWN_CODES.has(e.code)) return e.code;
  const status = Number(e?.status);
  if (Number.isInteger(status) && KNOWN_STATUSES.has(status)) return String(status);
  if (typeof e?.name === 'string' && KNOWN_NAMES.has(e.name)) return e.name;
  return 'error';
}

export function logError(stage, e, sink = console.error) {
  sink(JSON.stringify({ at: new Date().toISOString(), level: 'error', stage, code: safeCode(e), version }));
}
