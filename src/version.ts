/**
 * What version of Ichor this is — asked once, answered in one place.
 *
 * There were two answers to this and they disagreed. `ichor --version` read
 * `package.json`, which is right; the MCP server announced a hardcoded `0.1.0` in
 * its `serverInfo` while the published package was `0.1.5`. Version is the one
 * number a user can check to tell whether their install has a fix, and a second
 * copy of it is a second thing to forget (ENGINEERING-RULES rule 3).
 *
 * The literal drifted once before, inside `cli.ts`, which is why that copy started
 * reading the manifest. This is the same fix applied to the whole codebase rather
 * than to one caller.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolved relative to this file, which lands on the package root both from
 * `dist/src/` in a checkout and from `node_modules/ichor-cli/dist/src/` once
 * installed.
 */
export function packageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(here, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    // Never let a missing manifest stop the CLI, or the MCP handshake, from working.
    return '0.0.0';
  }
}
