import { describe, expect, it } from 'vitest';
import { wrapTier0 } from '../../src/core/clearance/envelope.js';

describe('wrapTier0 (byte-exact Tier-0 envelope)', () => {
  it('carries the payload as an exact UTF-8 JSON string with a byte-exact sha-256 hash', async () => {
    const payload = { type: 'ClearanceManifest', b: 2, a: 1 };
    const env = await wrapTier0(payload);

    expect(env.tier).toBe(0);
    expect(env.payloadType).toBe('application/clearance-manifest+json');
    expect(typeof env.payload).toBe('string');
    expect(env.integrity.alg).toBe('sha-256');
    expect(env.integrity.hash).toMatch(/^[0-9a-f]{64}$/);
    // no JCS flag any more
    expect(env.integrity).not.toHaveProperty('jcs');
    // the payload string is exactly what the producer serialized (author order kept)
    expect(env.payload).toBe('{"type":"ClearanceManifest","b":2,"a":1}');
  });

  it('round-trips: JSON.parse(payload) deep-equals the original object', async () => {
    const payload = { type: 'ClearanceManifest', work: { id: 'met:1' }, nested: { a: [1, 2, 3] } };
    const env = await wrapTier0(payload);
    expect(JSON.parse(env.payload)).toEqual(payload);
  });

  it('hashes the exact UTF-8 bytes of the payload string (known-answer vector)', async () => {
    // sha-256 of the exact string {"type":"ClearanceManifest","b":2,"a":1},
    // computed independently of this implementation.
    const env = await wrapTier0({ type: 'ClearanceManifest', b: 2, a: 1 });
    expect(env.integrity.hash).toBe(
      '534af393429518f3b81ba5334bce5f05c9566038c386f84d3d1d026204a97f57',
    );
  });

  it('the hash verifies by re-hashing the payload string verbatim (no re-serialization)', async () => {
    const env = await wrapTier0({ type: 'ClearanceManifest', x: 'café ☕', y: 1 });
    const bytes = new TextEncoder().encode(env.payload);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const recomputed = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(recomputed).toBe(env.integrity.hash);
  });

  it('does NOT canonicalize: author key order changes the bytes and the hash', async () => {
    const a = await wrapTier0({ type: 'ClearanceManifest', b: 2, a: 1 });
    const b = await wrapTier0({ a: 1, b: 2, type: 'ClearanceManifest' });
    expect(a.payload).not.toBe(b.payload);
    expect(a.integrity.hash).not.toBe(b.integrity.hash);
  });

  it('the payload string never contains its own hash (payload purity)', async () => {
    const env = await wrapTier0({ type: 'ClearanceManifest', a: 1 });
    expect(env.payload).not.toContain(env.integrity.hash);
  });

  it('rejects a payload that is not JSON-serializable', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(wrapTier0(circular)).rejects.toThrow();
  });
});
