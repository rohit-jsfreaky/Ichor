/**
 * Can Ichor read a real repository, at the memory Node gives it by default?
 *
 *   npm run read:test -- <repo> [<repo> …]
 *
 * WHY THIS EXISTS
 *
 * `analyzeRepo` used to run out of memory on THREE OF FIVE real repositories,
 * and nothing caught it — every suite runs against an eleven-file demo, where
 * both causes were invisible:
 *
 *   `isExported()`      ts-morph's version falls through to `getSymbol()`, which
 *                       builds the whole TypeScript Program and loads the type
 *                       definitions of every dependency. 15,389 filesystem calls
 *                       on a TWENTY-file package. The demo has no dependencies.
 *
 *   `globAllSources()`  `addSourceFilesAtPaths(['**\/*.ts', '!**\/node_modules/**'])`
 *                       filters the RESULT but still walks into every
 *                       node_modules, and a pnpm `.pnpm` directory holds one
 *                       entry per version of every transitive dependency. The
 *                       demo has no node_modules, and any repo with a usable
 *                       tsconfig never reached this branch — which is why
 *                       papermark looked fine and every monorepo did not.
 *
 * Deliberately runs at the DEFAULT heap. Passing `--max-old-space-size` would
 * turn a hard failure into a slow one and move the wall rather than remove it, so
 * the whole point of this check is that it never appears here.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repos = process.argv.slice(2);

if (repos.length === 0) {
  console.error('usage: npm run read:test -- <repo> [<repo> …]');
  process.exit(1);
}

/** Source bytes on disk, so the cost can be read against the size of the job. */
function sourceSize(root: string): { files: number; mb: number } {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files++;
        bytes += fs.statSync(full).size;
      }
    }
  };
  walk(root);
  return { files, mb: Math.round((bytes / 1e6) * 10) / 10 };
}

/**
 * The child that does one repository.
 *
 * A separate process per repo, so one that dies reports its own failure instead
 * of taking the whole run with it — and so peak memory is that repo's, not the
 * high-water mark of everything before it.
 */
const CHILD = path.join(here, 'read-one.mjs');

console.log('');
console.log('  repo                      files    source        peak       time   result');
console.log('  ' + '-'.repeat(72));

let failed = 0;
for (const repo of repos) {
  const root = path.resolve(repo);
  const name = path.basename(root).slice(0, 22);
  const size = sourceSize(root);

  const run = spawnSync(process.execPath, [CHILD, root], { encoding: 'utf8', timeout: 900_000 });
  const line = (run.stdout ?? '').trim().split('\n').pop() ?? '';
  const parsed = /^(\d+) (\d+) (\d+)$/.exec(line);

  if (!parsed) {
    failed++;
    const why = /heap out of memory/i.test(run.stderr ?? '') ? 'OUT OF MEMORY' : 'FAILED';
    console.log(
      `  ${name.padEnd(24)} ${String(size.files).padStart(5)}  ${`${size.mb} MB`.padStart(8)}` +
        `  ${'—'.padStart(9)}  ${'—'.padStart(9)}   ✗ ${why}`,
    );
    continue;
  }

  const [, functions, ms, peakMb] = parsed;
  console.log(
    `  ${name.padEnd(24)} ${String(size.files).padStart(5)}  ${`${size.mb} MB`.padStart(8)}` +
      `  ${`${peakMb} MB`.padStart(9)}  ${`${(Number(ms) / 1000).toFixed(1)}s`.padStart(9)}` +
      `   ✓ ${functions} functions`,
  );
}

console.log('');
console.log(
  failed === 0
    ? `  all ${repos.length} repositories read at the default heap\n`
    : `  ${failed} of ${repos.length} could not be read\n`,
);
process.exitCode = failed === 0 ? 0 : 1;
