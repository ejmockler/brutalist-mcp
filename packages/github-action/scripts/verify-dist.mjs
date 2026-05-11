#!/usr/bin/env node
/**
 * verify-dist
 *
 * Asserts that packages/github-action/dist/index.js is the file ncc
 * would produce from the current src/. Run in CI on PRs that touch
 * src/ — if a contributor forgot to commit a fresh bundle, the check
 * fails with a one-line fix.
 *
 * Why this exists: action.yml runs dist/index.js, NOT src. Stale
 * bundles ship old behavior even when source is correct, which is
 * exactly the bug the brutalist self-review flagged.
 *
 * Strategy: rebuild into a temp dir, hash both the committed and the
 * fresh dist/index.js, diff. We hash only index.js (not the source
 * map) because the map embeds absolute paths and timestamps that
 * legitimately differ across machines.
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const committedBundlePath = join(here, 'dist', 'index.js');

const tmpDir = mkdtempSync(join(tmpdir(), 'brutalist-verify-dist-'));
try {
  execSync(
    `npx ncc build "${join(here, 'src', 'index.ts')}" -o "${tmpDir}" --source-map --license=licenses.txt`,
    { cwd: here, stdio: 'inherit' },
  );

  const fresh = hashFile(join(tmpDir, 'index.js'));
  const committed = hashFile(committedBundlePath);

  if (fresh !== committed) {
    console.error(
      `\nERROR: dist/index.js is out of date with src/.\n` +
        `Committed bundle sha256: ${committed}\n` +
        `Fresh build sha256:      ${fresh}\n\n` +
        `Run \`npm run build\` in packages/github-action and commit the result.\n`,
    );
    process.exit(1);
  }
  console.log('dist/index.js is up to date.');
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
