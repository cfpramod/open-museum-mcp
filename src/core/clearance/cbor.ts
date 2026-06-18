/**
 * Minimal canonical (deterministic) CBOR encoder — RFC 8949 §4.2 Core
 * Deterministic Encoding profile, limited to the types the Tier-1 C2PA claim
 * needs: unsigned/negative integers, text strings, byte strings, arrays, and
 * maps. No floats, no tags, no indefinite-length items.
 *
 * Why hand-rolled and zero-dependency: the Tier-1 seam is byte-exact — the
 * keyless lib emits `claimToBeSigned` and the signing service signs those exact
 * bytes verbatim (contract C2). A deterministic encoder we fully control, with
 * pinned known-answer vectors, is the integrity anchor for that seam; a general
 * CBOR library would be a heavier dependency and a larger trust surface for a
 * zero-infra OSS engine.
 *
 * Determinism rules enforced here:
 *  - integers use the shortest possible encoding;
 *  - all lengths are definite and minimally encoded;
 *  - map keys are sorted by their canonical encoded bytes (bytewise lexical),
 *    RFC 8949 §4.2.1 — independent of insertion order.
 */

/** Marker for a CBOR byte string (major type 2), distinguishing it from text. */
export interface CborBytes {
  readonly __cbor: 'bytes';
  readonly value: Uint8Array;
}

/** Marker for a CBOR map (major type 5) with explicit, possibly non-string keys. */
export interface CborMap {
  readonly __cbor: 'map';
  readonly entries: ReadonlyArray<readonly [CborValue, CborValue]>;
}

export type CborValue = number | string | CborBytes | CborMap | CborValue[];

export function cborBytes(value: Uint8Array): CborBytes {
  return { __cbor: 'bytes', value };
}

export function cborMap(entries: ReadonlyArray<readonly [CborValue, CborValue]>): CborMap {
  return { __cbor: 'map', entries };
}

function isBytes(v: CborValue): v is CborBytes {
  return typeof v === 'object' && v !== null && (v as CborBytes).__cbor === 'bytes';
}

function isMap(v: CborValue): v is CborMap {
  return typeof v === 'object' && v !== null && (v as CborMap).__cbor === 'map';
}

/** Encode a major type (0-7) and an unsigned argument with the shortest head. */
function head(major: number, arg: number): Uint8Array {
  const mt = major << 5;
  if (arg < 24) return new Uint8Array([mt | arg]);
  if (arg < 0x100) return new Uint8Array([mt | 24, arg]);
  if (arg < 0x10000) return new Uint8Array([mt | 25, arg >> 8, arg & 0xff]);
  if (arg < 0x100000000) {
    return new Uint8Array([mt | 26, (arg >>> 24) & 0xff, (arg >> 16) & 0xff, (arg >> 8) & 0xff, arg & 0xff]);
  }
  // 64-bit argument — use BigInt to stay exact above 2^32.
  const big = BigInt(arg);
  const out = new Uint8Array(9);
  out[0] = mt | 27;
  for (let i = 0; i < 8; i++) out[8 - i] = Number((big >> BigInt(8 * i)) & 0xffn);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const textEncoder = new TextEncoder();

/**
 * Narrow a `Uint8Array` to one whose backing store is a plain `ArrayBuffer`, as
 * the WebCrypto `BufferSource` type requires (it excludes `SharedArrayBuffer`).
 * Our byte arrays are always ArrayBuffer-backed, so this is a no-op cast in
 * practice; it copies only in the impossible SharedArrayBuffer case.
 */
export function asBufferSource(u: Uint8Array): Uint8Array<ArrayBuffer> {
  return (u.buffer instanceof ArrayBuffer ? u : new Uint8Array(u)) as Uint8Array<ArrayBuffer>;
}

/** Bytewise lexicographic comparison of two byte arrays (RFC 8949 §4.2.1). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function encodeCanonicalCbor(value: CborValue): Uint8Array {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`cbor: only integers are supported in the deterministic profile, got ${value}`);
    }
    return value >= 0 ? head(0, value) : head(1, -value - 1);
  }

  if (typeof value === 'string') {
    const bytes = textEncoder.encode(value);
    return concat([head(3, bytes.length), bytes]);
  }

  if (isBytes(value)) {
    return concat([head(2, value.value.length), value.value]);
  }

  if (Array.isArray(value)) {
    return concat([head(4, value.length), ...value.map(encodeCanonicalCbor)]);
  }

  if (isMap(value)) {
    const encoded = value.entries.map(([k, v]) => ({
      k: encodeCanonicalCbor(k),
      v: encodeCanonicalCbor(v),
    }));
    encoded.sort((a, b) => compareBytes(a.k, b.k));
    return concat([head(5, encoded.length), ...encoded.flatMap((e) => [e.k, e.v])]);
  }

  throw new Error('cbor: unsupported value type');
}

/** Decoded CBOR: ints -> number, text -> string, bytes -> Uint8Array, arrays/maps recursively. */
export type DecodedCbor = number | string | Uint8Array | DecodedCbor[] | Map<DecodedCbor, DecodedCbor>;

const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Decode the deterministic CBOR profile produced by `encodeCanonicalCbor`. Strict
 * and fail-closed: rejects trailing bytes, indefinite-length items, floats, tags,
 * and truncated input. Used to extract the signature (and confirm the claim
 * payload) from a COSE_Sign1 during Tier-1 verification.
 */
export function decodeCanonicalCbor(bytes: Uint8Array): { value: DecodedCbor } {
  const [value, offset] = decodeAt(bytes, 0);
  if (offset !== bytes.length) {
    throw new Error('cbor: trailing bytes after top-level item');
  }
  return { value };
}

function readArg(bytes: Uint8Array, pos: number, info: number): [number, number] {
  if (info < 24) return [info, pos];
  if (info === 24) {
    if (pos >= bytes.length) throw new Error('cbor: truncated 1-byte argument');
    return [bytes[pos], pos + 1];
  }
  if (info === 25) {
    if (pos + 2 > bytes.length) throw new Error('cbor: truncated 2-byte argument');
    return [(bytes[pos] << 8) | bytes[pos + 1], pos + 2];
  }
  if (info === 26) {
    if (pos + 4 > bytes.length) throw new Error('cbor: truncated 4-byte argument');
    return [
      (bytes[pos] * 0x1000000) + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3],
      pos + 4,
    ];
  }
  if (info === 27) {
    if (pos + 8 > bytes.length) throw new Error('cbor: truncated 8-byte argument');
    let big = 0n;
    for (let i = 0; i < 8; i++) big = (big << 8n) | BigInt(bytes[pos + i]);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor: integer exceeds safe range');
    return [Number(big), pos + 8];
  }
  throw new Error('cbor: indefinite-length or reserved additional-info not supported');
}

function decodeAt(bytes: Uint8Array, pos: number): [DecodedCbor, number] {
  if (pos >= bytes.length) throw new Error('cbor: truncated input');
  const ib = bytes[pos];
  const major = ib >> 5;
  const info = ib & 0x1f;
  let p = pos + 1;

  switch (major) {
    case 0: {
      const [arg, np] = readArg(bytes, p, info);
      return [arg, np];
    }
    case 1: {
      const [arg, np] = readArg(bytes, p, info);
      return [-1 - arg, np];
    }
    case 2: {
      const [len, np] = readArg(bytes, p, info);
      if (np + len > bytes.length) throw new Error('cbor: truncated byte string');
      return [bytes.slice(np, np + len), np + len];
    }
    case 3: {
      const [len, np] = readArg(bytes, p, info);
      if (np + len > bytes.length) throw new Error('cbor: truncated text string');
      return [textDecoder.decode(bytes.slice(np, np + len)), np + len];
    }
    case 4: {
      const [len, np] = readArg(bytes, p, info);
      p = np;
      const arr: DecodedCbor[] = [];
      for (let i = 0; i < len; i++) {
        const [v, q] = decodeAt(bytes, p);
        arr.push(v);
        p = q;
      }
      return [arr, p];
    }
    case 5: {
      const [len, np] = readArg(bytes, p, info);
      p = np;
      const map = new Map<DecodedCbor, DecodedCbor>();
      for (let i = 0; i < len; i++) {
        const [k, q] = decodeAt(bytes, p);
        const [v, r] = decodeAt(bytes, q);
        map.set(k, v);
        p = r;
      }
      return [map, p];
    }
    default:
      throw new Error(`cbor: unsupported major type ${major}`);
  }
}
