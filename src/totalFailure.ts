import { allSourcesFailed, type SourceStatus } from './core/index.js';

/**
 * Total failure must never read as `count: 0`. When every queried source failed
 * a tool call is an MCP error carrying each source's (sanitised) message; a
 * partial failure is not an error and still returns the normal result, with the
 * failures listed in its `sources`. Returns null when the call should succeed.
 */
export function totalFailureResult(tool: string, sources: SourceStatus[]) {
  if (!allSourcesFailed(sources)) return null;
  const lines = sources.map((s) => `- ${s.museum}: ${s.status}: ${s.error ?? 'no detail'}`);
  return {
    content: [
      {
        type: 'text' as const,
        text: `${tool}: every queried source failed (${sources.length}), so there are no results.\n${lines.join('\n')}`,
      },
    ],
    isError: true,
  };
}
