import { z } from 'zod';
import type { Federation } from './core/index.js';

/**
 * Input schema for the `clearance_record` MCP tool.
 *
 * Deliberately does NOT regex-validate the id against ID_REGEX, unlike
 * `get_artwork` and `cite`. The clearance tool's contract is that a non-cleared
 * work — including a malformed id — returns a definitive DENY manifest, not an
 * error. `federation.clearanceManifest` emits that deny for an invalid id, so
 * gating the id here would wrongly convert a contractual deny into a ZodError.
 */
export const ClearanceInput = z.object({
  id: z.string(),
});

/**
 * Handle a `clearance_record` call. Returns a normal (non-error) tool result
 * for every id: a cleared work yields a permitted manifest, a non-cleared or
 * malformed id yields a deny manifest. Both are valid answers.
 */
export async function handleClearanceRecord(federation: Federation, args: unknown) {
  const input = ClearanceInput.parse(args);
  const env = await federation.clearanceManifest(input.id);
  return { content: [{ type: 'text' as const, text: JSON.stringify(env, null, 2) }] };
}
