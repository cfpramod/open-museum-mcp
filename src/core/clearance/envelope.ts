import { canonicalizeToBytes } from './jcs.js';

/**
 * Tier-0 envelope: integrity, not authenticity. It wraps a pure Clearance
 * Manifest payload with a hash computed over the payload's RFC 8785 (JCS)
 * canonical bytes. The hash lives HERE, never inside the payload — payload
 * purity is a design invariant (the payload never carries its own hash, its
 * signature, or any commercial data).
 *
 * This is what the distributed OSS MCP emits by default; it ships no key.
 * Tiers 1/2 (C2PA signing) wrap the same payload with a signature — the payload
 * shape is unchanged across tiers.
 */
export interface Tier0Envelope<T = unknown> {
  tier: 0;
  payload: T;
  integrity: { alg: 'sha-256'; jcs: true; hash: string };
}

/**
 * Wrap a payload in a Tier-0 envelope. Canonicalizes FIRST (RFC 8785), then
 * hashes the canonical bytes with Web Crypto (`crypto.subtle`, Workers-safe).
 * Throws if the payload is not canonicalizable JSON.
 */
export async function wrapTier0<T>(payload: T): Promise<Tier0Envelope<T>> {
  const bytes = canonicalizeToBytes(payload);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { tier: 0, payload, integrity: { alg: 'sha-256', jcs: true, hash } };
}
