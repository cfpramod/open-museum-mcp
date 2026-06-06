// RFC 8785 JSON Canonicalization Scheme (JCS).
//
// Produces the canonical UTF-8 serialization of a JSON value: object keys sorted
// by UTF-16 code unit, ECMAScript number serialization, minimal string escaping,
// no insignificant whitespace. This is the byte sequence a Clearance Manifest's
// Tier-0 envelope hashes over.
//
// Lifted verbatim (ported to TypeScript) from the PIF sibling standard's vetted
// dependency-free verifier (pif-spec/verifier/jcs.mjs). Runs unchanged in Node,
// the browser, and Cloudflare Workers — no dependencies, no `node:` imports.
//
// IMPORTANT (the contract the spec must warn implementers about): canonicalize
// FIRST, then hash the canonical bytes. Never hash the raw serialized string —
// JSON.stringify on the same object can produce different bytes (key order,
// whitespace) and therefore a different, non-interoperable hash.

/**
 * Canonicalize a JSON-compatible value to its RFC 8785 string form.
 * Throws on values JSON cannot represent (functions, symbols, undefined,
 * non-finite numbers) — a Clearance Manifest payload must be canonicalizable.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('JCS: non-finite numbers are not permitted in JSON');
    }
    // JSON.stringify uses ECMAScript Number-to-string, which is what JCS mandates.
    return JSON.stringify(value);
  }

  if (t === 'string') {
    // ECMAScript JSON string escaping (control chars as \u00XX, correct surrogate
    // handling) is exactly the escaping RFC 8785 specifies.
    //
    // PORTABILITY NOTE for non-JS implementers (RFC 8785 §3.2.2.2): escape ONLY the
    // two mandatory characters (" -> \", \ -> \\) and the C0 control range U+0000..U+001F,
    // using the short forms \b \t \n \f \r where they exist and \u00XX (lowercase hex)
    // otherwise. Do NOT escape the forward solidus "/", and do NOT escape any non-ASCII
    // character; codepoints >= U+0080 are emitted as raw UTF-8. Over-escaping (e.g.
    // \uXXXX for every non-ASCII char, as some language JSON encoders do by default) is
    // the most common interop bug and will produce a different byte string, hence a
    // different hash. V8's JSON.stringify already implements exactly this.
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }

  if (t === 'object') {
    // Object.keys() then default Array sort: lexicographic by UTF-16 code unit,
    // which is the ordering RFC 8785 requires.
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const members = keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]));
    return '{' + members.join(',') + '}';
  }

  throw new Error(`JCS: unsupported value of type ${t}`);
}

/** Canonicalize and encode to UTF-8 bytes (ArrayBuffer-backed, for Web Crypto). */
export function canonicalizeToBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalize(value));
}
