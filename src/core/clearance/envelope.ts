/**
 * Tier-0 envelope: integrity, not authenticity. BYTE-EXACT.
 *
 * The payload is carried as the producer's exact UTF-8 JSON STRING — not a
 * nested object — because byte-exact integrity over a nested object is
 * impossible (any consumer re-serializes when it parses, and re-serialization is
 * not guaranteed to reproduce the original bytes). The hash is SHA-256 over the
 * exact bytes of that string. This mirrors how DSSE / JWS / COSE / C2PA all
 * protect the payload as bytes rather than a re-parseable object: it is
 * content-addressing-correct and removes the canonicalization attack surface.
 *
 * The hash lives HERE, never inside the payload — payload purity is a design
 * invariant (the payload never carries its own hash, its signature, or any
 * commercial data).
 *
 * This is what the keyless OSS MCP emits by default. Tiers 1/2 (C2PA signing)
 * are unchanged and sign the same payload bytes.
 */
export interface Tier0Envelope {
  tier: 0;
  payloadType: 'application/clearance-manifest+json';
  /** The exact UTF-8 JSON serialization of the manifest payload. Hash this verbatim. */
  payload: string;
  integrity: { alg: 'sha-256'; hash: string };
}

const PAYLOAD_TYPE = 'application/clearance-manifest+json' as const;

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Wrap a payload object in a byte-exact Tier-0 envelope. The object is
 * serialized to a JSON string ONCE — no key sorting, no canonicalization — and
 * that exact string both becomes the `payload` field and is what gets hashed.
 * Throws if the payload is not JSON-serializable.
 */
export async function wrapTier0(payload: unknown): Promise<Tier0Envelope> {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new Error('clearance: payload is not JSON-serializable');
  }
  const hash = await sha256Hex(serialized);
  return {
    tier: 0,
    payloadType: PAYLOAD_TYPE,
    payload: serialized,
    integrity: { alg: 'sha-256', hash },
  };
}
