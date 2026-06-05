import { describe, expect, it } from 'vitest';
import { wrapTier0 } from '../../src/core/clearance/envelope.js';

describe('wrapTier0', () => {
  it('wraps a payload with a JCS sha-256 hash that lives outside the payload', async () => {
    const payload = { type: 'ClearanceManifest', b: 2, a: 1 };
    const env = await wrapTier0(payload);

    expect(env.tier).toBe(0);
    expect(env.payload).toEqual(payload);
    expect(env.integrity.alg).toBe('sha-256');
    expect(env.integrity.jcs).toBe(true);
    expect(env.integrity.hash).toMatch(/^[0-9a-f]{64}$/);
    // the payload must never carry its own hash
    expect(env.integrity).not.toHaveProperty('tier');
    expect(JSON.stringify(env.payload)).not.toContain(env.integrity.hash);
  });

  it('is deterministic regardless of authored key order (canonicalize before hashing)', async () => {
    const a = await wrapTier0({ type: 'ClearanceManifest', b: 2, a: 1 });
    const b = await wrapTier0({ a: 1, b: 2, type: 'ClearanceManifest' });
    expect(b.integrity.hash).toBe(a.integrity.hash);
  });

  it('hashes the RFC 8785 canonical bytes, not the raw serialization (known-answer vector)', async () => {
    // sha-256 of the canonical form {"a":1,"b":2,"type":"ClearanceManifest"},
    // computed independently of this implementation.
    const env = await wrapTier0({ type: 'ClearanceManifest', b: 2, a: 1 });
    expect(env.integrity.hash).toBe(
      'fb3a2706bb349989bc6b588758232b9fc325afd511b18c6d59c42ebb33862f5f',
    );
  });

  it('rejects payloads that are not canonicalizable JSON', async () => {
    await expect(wrapTier0(() => 'not json')).rejects.toThrow();
  });
});
