/**
 * Client-id normalization for the orchestrator's submit_findings handler.
 *
 * The orchestrator brain (Claude Agent SDK) parses brutalist roast output
 * and emits Finding / CliBreakdown objects whose `clientId` is copied from
 * prose HTML comments. When multiple independent orchestrator runs process
 * different diff chunks the brain can hallucinate or drift on the clientId
 * value. The action provisions the valid set and threads it through here so
 * every brain-emitted id is clamped before the result is captured.
 */

const NATIVE_CLIS = ['claude', 'codex', 'agy'] as const;

/**
 * Clamp a brain-emitted clientId to the provisioned set ∪ native cli names.
 * Absent or clientId===cli => undefined (native); known => kept; unknown =>
 * undefined (dropped to native).
 */
export function makeClientIdNormalizer(
  knownClientIds?: string[],
): (cli: string, clientId?: string) => string | undefined {
  const known = new Set<string>([...(knownClientIds ?? []), ...NATIVE_CLIS]);
  return (cli, clientId) =>
    !clientId || clientId === cli ? undefined : known.has(clientId) ? clientId : undefined;
}

/**
 * Dedupe per-CLI breakdown rows by (clientId ?? cli), keep-first.
 *
 * The submit_findings clamp can collapse a hallucinated
 * {cli:'claude', clientId:'phantom'} row to {cli:'claude', clientId:undefined},
 * making it byte-identical to a genuine native {cli:'claude'} row. The
 * single-chunk action path skips chunk-diff.ts's mergePerCli, so without this
 * the brain emitting both a native and a phantom-clamped row would surface two
 * identical native rows. The key MUST match mergePerCli's `e.clientId ?? e.cli`
 * so the single-chunk and multi-chunk paths agree.
 */
export function dedupePerCli<T extends { cli: string; clientId?: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = row.clientId ?? row.cli;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
