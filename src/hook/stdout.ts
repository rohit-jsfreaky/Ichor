/**
 * Writing to stdout from a hook, synchronously.
 *
 * `process.stdout.write` is asynchronous on a pipe, and a hook that calls
 * `process.exit` right after it truncates its own output. That produced a bug
 * that only reproduced without `ICHOR_DEBUG=1`, because the extra stderr write
 * changed the timing enough to hide it.
 */

import * as fs from 'node:fs';

/** Write every byte to fd 1 before returning. */
export function writeStdoutSync(text: string): void {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(1, buffer, offset, buffer.length - offset);
    } catch (error) {
      // A pipe that is not ready yet — retry rather than lose the decision.
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      throw error;
    }
  }
}
