/**
 * Per-source outcome of a federated query.
 *
 * Federation tolerates a failing museum (the others still answer), but a source
 * that errors must not read as "no results": every search and facets result
 * carries one {@link SourceStatus} per source queried, so a client can tell a
 * museum with nothing to show from a museum that is down.
 */

/** The status vocabulary for a queried source. Hosts may extend it with their own states. */
export const SOURCE_STATUSES = ['ok', 'error', 'timeout'] as const;
export type SourceStatusKind = (typeof SOURCE_STATUSES)[number];

export interface SourceStatus {
  /** Museum code, e.g. `getty`. */
  museum: string;
  status: SourceStatusKind;
  /**
   * Why the source failed, sanitised: no URLs beyond their origin, no keys,
   * tokens or headers, no local paths, no stack trace, single line,
   * length-capped. Present only
   * when `status` is not `ok`.
   */
  error?: string;
  /**
   * Wall-clock milliseconds the source's search took. Absent when the answer
   * came from the query cache: a cache entry is keyed by the exact set of
   * sources queried and written only when every one of them answered, so a
   * cached query reports each source as `ok` without a timing.
   */
  ms?: number;
}

const MAX_ERROR_LENGTH = 300;

/** Names and codes Node's fetch / undici / AbortSignal.timeout use for a timeout. */
const TIMEOUT_NAMES = new Set(['TimeoutError', 'AbortError']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function codeOf(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'code' in value) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** `timeout` for a timeout-shaped failure (own or wrapped `cause`), otherwise `error`. */
export function classifyFailure(err: unknown): 'error' | 'timeout' {
  for (let e: unknown = err, depth = 0; e && depth < 3; depth += 1) {
    if (e instanceof Error && TIMEOUT_NAMES.has(e.name)) return 'timeout';
    const code = codeOf(e);
    if (code && TIMEOUT_CODES.has(code)) return 'timeout';
    e = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /\btim(ed|e)[ -]?out\b/i.test(message) ? 'timeout' : 'error';
}

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;
const HEADER_LINE = /\b(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)\b\s*[:=]\s*[^\n,;]*/gi;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
// A credential's NAME, matched by suffix so every vendor spelling is caught
// (`key`, `apikey`, Europeana's `wskey`, `client_secret`, `access_token`, `sig`,
// `oauth`) while ordinary words that merely contain one (`keyword`, `design`,
// `author`) are left alone: the name must END in the marker, right before the
// separator.
// The prefix is bounded: an unbounded `*` ahead of the marker backtracks
// quadratically on a long run of name characters (ReDoS).
const SECRET_NAME = '[A-Za-z0-9_.-]{0,40}(?:key|token|secret|passw(?:or)?d|credential|signature|sig|auth)';
// name, optional closing quote (JSON `"apikey":"v"`), separator, then a quoted
// or bare value. The opening quote is optional and not captured.
const SECRET_PAIR = new RegExp(`\\b(${SECRET_NAME})["']?\\s*[=:]\\s*("[^"]*"|'[^']*'|[^\\s&,;"'}]+)`, 'gi');
// Query-string parameters of a URL that has no scheme (`host/path?wskey=...`), so
// the URL rule above never saw it. Here the name may merely CONTAIN a marker
// (`partner_token_v2`): inside a query string the leaner rule is the safer one.
const QUERY_SECRET = /([?&])([^=&\s"'#]{0,64}(?:key|token|secret|passw|credential|sig|auth)[^=&\s"'#]{0,64})=[^&\s"'#]*/gi;
// Most of an upstream message the redaction rules will ever look at. Applied
// BEFORE any regex runs, so the cost is bounded whatever a museum sends back.
const MAX_SCAN_LENGTH = 2000;
const ESCAPED_QUOTE = /\\+(["'])/g;
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/g;

/**
 * Undo the encodings that hide a credential from the rules below: backslash-escaped
 * quotes (a JSON body embedded in a JSON string: `{\"apikey\":\"v\"}`) and
 * percent-escaped separators (`apikey%3Dv`, `%7B%22apikey%22%3A%22v%22%7D`). Two
 * passes cover a doubly percent-encoded value. Output is the decoded text: this
 * is an error message for people, not a value anything parses back.
 */
function decodeForScan(text: string): string {
  let out = text.replace(ESCAPED_QUOTE, '$1');
  for (let pass = 0; pass < 2 && out.includes('%'); pass++) {
    out = out.replace(PERCENT_ESCAPE, (esc) => String.fromCharCode(parseInt(esc.slice(1), 16)));
    out = out.replace(ESCAPED_QUOTE, '$1');
  }
  return out;
}
// Absolute POSIX (`/a/b/c`, `~/a/b`) and Windows (`C:\\a\\b`) paths. At least two
// segments, and never preceded by a word character, `:` or `/`, so URL paths,
// `application/json` and `a/b` stay intact.
const POSIX_PATH = /(?<![\w:/.])~?(?:\/[\w.@+~-]+){2,}\/?/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\\\s'"]+\\)*[^\\\s'"]*/g;
const STACK_FRAME = /\s+at\s+[^\n]*(\([^\n]*\)|:\d+:\d+)[^\n]*/g;

/**
 * Make an upstream error message safe to hand to a client and a log line. A
 * museum's error text can echo the request URL (with an API key in the query
 * string), a header value, or a stack trace; none of that may leave the engine.
 * URLs are cut to their origin, credentials are replaced by NAME in every form
 * (bare pairs, quoted JSON keys, query parameters of scheme-less URLs, credential
 * headers), local file paths are reduced to the file name, only the first line
 * survives, and the result is length-capped.
 */
export function sanitizeSourceError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'source failed';
  const firstLine = decodeForScan(raw.slice(0, MAX_SCAN_LENGTH).replace(STACK_FRAME, '').split(/\r?\n/)[0] ?? '');
  const cleaned = firstLine
    .replace(URL_PATTERN, (url) => {
      try {
        return new URL(url).origin;
      } catch {
        return '[url]';
      }
    })
    .replace(HEADER_LINE, (_m, name: string) => `${name}: [redacted]`)
    .replace(BEARER, (_m, scheme: string) => `${scheme} [redacted]`)
    .replace(SECRET_PAIR, (_m, name: string) => `${name}=[redacted]`)
    .replace(QUERY_SECRET, (_m, sep: string, name: string) => `${sep}${name}=[redacted]`)
    .replace(WINDOWS_PATH, (path) => path.split('\\').filter(Boolean).pop() ?? '[path]')
    .replace(POSIX_PATH, (path) => path.split('/').filter(Boolean).pop() ?? '[path]')
    .replace(/\s+/g, ' ')
    .trim();
  const text = cleaned || 'source failed';
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

/** Build the failed-source entry for a thrown search error. */
export function failedSource(museum: string, err: unknown, ms: number): SourceStatus {
  return { museum, status: classifyFailure(err), error: sanitizeSourceError(err), ms };
}

/** True when sources were queried and not one of them answered. */
export function allSourcesFailed(sources: readonly SourceStatus[]): boolean {
  return sources.length > 0 && sources.every((s) => s.status !== 'ok');
}
