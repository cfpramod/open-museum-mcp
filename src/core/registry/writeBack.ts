import type { Assertion } from './types.js';
import type { RegistryStore } from './store.js';

/**
 * The low-friction contract any fleet lane calls when it researches a work
 * for its own purpose (a story's provenance note, an attribution note, a
 * plate credit, a caption fact) and wants the extracted detail to compound
 * back into the registry instead of living only in that lane's own output.
 */
export interface WriteBackRequest {
  /** `WorkIdentity.registryId` (increment 1: the source `Artwork.id`). */
  subject: string;
  assertion: Omit<Assertion, 'id' | 'subject' | 'assertedAt'>;
}

export interface WriteBackOptions {
  /** Injectable for deterministic tests; defaults to `new Date().toISOString()`. */
  clock?: () => string;
  /** Injectable for deterministic tests; defaults to the global `crypto.randomUUID()` (Node + Workers safe). */
  idGen?: () => string;
}

export type WriteBackOutcome =
  | { ok: true; assertionId: string; status: 'applied' | 'pending' }
  | { ok: false; reason: string };

/**
 * Every write-back assertion must carry at least one evidence entry, a lane
 * calling this seam supplies its own research citation, never a bare value.
 * `Assertion.evidence` is non-optional at the type level, but a request
 * arriving over an untyped boundary (MCP JSON args, a future HTTP endpoint)
 * bypasses that compile-time check, so this validates again at the runtime
 * boundary.
 */
export function validateWriteBackRequest(req: WriteBackRequest): string | null {
  if (!req.subject || req.subject.trim() === '') {
    return 'write-back: subject (registryId) is required';
  }
  if (!req.assertion.evidence || req.assertion.evidence.length === 0) {
    return 'write-back: at least one evidence entry is required, never a bare value';
  }
  if (!req.assertion.value || req.assertion.value.trim() === '') {
    return 'write-back: assertion value is required';
  }
  return null;
}

/**
 * Assembles a full {@link Assertion} (mints its id + timestamp) from a
 * write-back request and delegates persistence to the injected
 * {@link RegistryStore}. Increment 1 treats every caller as internal/trusted
 *, the store returns `status: 'applied'` today; once the openclearance
 * Tier-2 gate lands (later, wired by OM-C), an untrusted/low-tier caller's
 * request lands `'pending'` from the SAME store method, no seam change here.
 */
export async function proposeWriteBack(
  store: RegistryStore,
  req: WriteBackRequest,
  opts: WriteBackOptions = {},
): Promise<WriteBackOutcome> {
  const invalid = validateWriteBackRequest(req);
  if (invalid) return { ok: false, reason: invalid };

  const clock = opts.clock ?? (() => new Date().toISOString());
  const idGen = opts.idGen ?? (() => crypto.randomUUID());
  const assertedAt = clock();

  const assertion: Assertion = {
    ...req.assertion,
    id: idGen(),
    subject: req.subject,
    assertedAt,
  };

  const result = await store.proposeAssertion({ subject: req.subject, assertion });
  return { ok: true, assertionId: assertion.id, status: result.status };
}
