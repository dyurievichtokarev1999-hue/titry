// ИР-03 (критик реализации): обезличенный журнал ошибок. В журнал попадают только этап, код, время и версия —
// без сообщения, стека, текста рассказа, строк, путей и идентификаторов. Сообщения и стеки исключений
// могут содержать фрагменты рассказа (ошибки API, проверки, распознавания), поэтому их не пишем вовсе.
import fs from 'node:fs';

let version = 'unknown';
try { version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown'; } catch { /* остаётся unknown */ }

// Код — только из явного списка известных значений (критик реализации, 10.11). Исходное значение
// e.code / e.status / e.name никогда не пишется: даже короткая строка может прийти из внешнего клиента.
// Неизвестное → 'error'.
// Списки — Map «значение → то же значение из списка»: возвращается строка из списка, а не из исключения.
const listed = (values) => new Map(values.map((v) => [v, v]));
const KNOWN_CODES = listed([
  // свои коды приложения
  'safety', 'timeout', 'browser', 'tmp_cleanup_pending', 'empty', 'stt_off', 'too_long', 'refusal',
  'max_tokens', 'bad_json', 'bad_response', 'incomplete_response', 'ffmpeg', 'fonts', 'no_key', 'check_incomplete_twice',
  'ledger', 'busy',
  // файловая система и сеть Node
  'ENOENT', 'ENOSPC', 'EACCES', 'EPERM', 'EIO', 'EEXIST', 'EMFILE', 'ENOTDIR', 'EISDIR', 'EBUSY', 'EROFS',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE',
]);
const KNOWN_STATUSES = listed(['400', '401', '403', '404', '408', '409', '413', '422', '429', '500', '502', '503', '504', '529']);
const KNOWN_NAMES = listed(['TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AbortError', 'TimeoutError',
  'APIConnectionError', 'APIConnectionTimeoutError', 'APIUserAbortError']);

// Каждое поле читается один раз (геттер не может подменить значение между проверкой и возвратом);
// чтение, бросающее исключение, и значения не строкового/числового типа дают 'error'.
function field(e, key) {
  try {
    const v = e?.[key];
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  } catch { /* недоступное поле — как отсутствующее */ }
  return undefined;
}

export function safeCode(e) {
  return KNOWN_CODES.get(field(e, 'code')) ?? KNOWN_STATUSES.get(field(e, 'status')) ?? KNOWN_NAMES.get(field(e, 'name')) ?? 'error';
}

export function logError(stage, e, sink = console.error) {
  sink(JSON.stringify({ at: new Date().toISOString(), level: 'error', stage, code: safeCode(e), version }));
}
