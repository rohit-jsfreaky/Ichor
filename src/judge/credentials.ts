/**
 * Where the OpenRouter key lives when it is not an environment variable.
 *
 * WHY THIS FILE EXISTS
 *
 * Ichor works fully without a key — no key means an argument alone never grants an
 * expansion, and anything unverifiable comes to the developer instead. But asking
 * someone to keep `ICHOR_OPENROUTER_KEY` exported in every shell that might launch
 * an agent is a real obstacle to trying the one feature that needs it, and the
 * common workaround is worse: a key pasted into a file inside the repository, one
 * `git add -A` away from being published.
 *
 * So the key goes in the USER'S HOME directory, never the repo:
 *
 *   ~/.ichor/credentials.json     mode 0600, one key for every project
 *
 * Home rather than per-repo for two reasons. It cannot be committed by accident,
 * and a developer with six checkouts sets it once.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface Credentials {
  version: 1;
  openrouterKey?: string;
  /** Recorded so `ichor key` can say when it was set, without storing the key twice. */
  setAt?: string;
}

export const credentialsPath = (): string =>
  path.join(os.homedir(), '.ichor', 'credentials.json');

/** The stored key, or undefined. Never throws — a missing or broken file is "no key". */
export function readStoredKey(): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')) as Credentials;
    const key = parsed.openrouterKey?.trim();
    return key ? key : undefined;
  } catch {
    return undefined;
  }
}

export function readStoredSetAt(): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')) as Credentials).setAt;
  } catch {
    return undefined;
  }
}

/**
 * Store the key, readable only by this user.
 *
 * `mode: 0o600` on the file AND `0o700` on the directory. On Windows those bits
 * are advisory rather than enforced, so the location does the real work: a file in
 * the home directory is not inside anybody's git repository.
 */
export function writeStoredKey(key: string): string {
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  const body: Credentials = { version: 1, openrouterKey: key.trim(), setAt: new Date().toISOString() };
  // Written to a temp file and renamed, so an interrupted write cannot leave a
  // half-written key behind that reads as corrupt.
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return file;
}

/** Remove the stored key. Returns false if there was nothing to remove. */
export function clearStoredKey(): boolean {
  try {
    fs.rmSync(credentialsPath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Enough of the key to recognise, never enough to use.
 *
 * A command that prints a secret in full ends up in a screen recording, and this
 * project's own demo video is about to be one.
 */
export function maskKey(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/**
 * Does this look like an OpenRouter key?
 *
 * A format check, not a validity check — only OpenRouter can say whether a key
 * works, and `ichor key set` asks it. This exists to catch the ordinary mistakes:
 * a pasted shell prompt, a truncated copy, quotes included.
 */
export function looksLikeOpenRouterKey(key: string): { ok: boolean; why?: string } {
  const value = key.trim();
  if (value.length === 0) return { ok: false, why: 'empty' };
  if (/\s/.test(value)) return { ok: false, why: 'contains a space — was the whole line copied?' };
  if (/^["']|["']$/.test(value)) return { ok: false, why: 'wrapped in quotes — paste the key alone' };
  if (!value.startsWith('sk-or-')) {
    return { ok: false, why: 'an OpenRouter key starts with `sk-or-`' };
  }
  if (value.length < 20) return { ok: false, why: 'too short — the copy may have been truncated' };
  return { ok: true };
}
