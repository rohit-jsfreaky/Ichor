/**
 * The last thing a person sees when Ichor gives up.
 *
 * Every command funnels into one `catch`, and that catch used to print
 * `error.message` alone. For an Error thrown by this codebase that is fine — the
 * message was written for a reader. For anything arriving from a driver, a socket
 * or the filesystem it is a fragment of someone else's internals:
 *
 *     Could not perform discovery. No routing servers available.
 *
 * which names no cause, suggests no action, and does not even mention Ichor.
 *
 * Same contract as `stack/diagnose.ts`: recognise a short list of failures that
 * actually happen, say what to do about each, and hand back the original text
 * untouched when the failure is not on the list. A confident wrong explanation
 * costs more than an unexplained one.
 */

interface NodeError {
  code?: string;
  message?: string;
  path?: string;
}

/** Everything a thrown value might be, flattened to text we can match on. */
function textOf(error: unknown): string {
  if (typeof error === 'string') return error;
  const e = error as NodeError;
  return [e?.code, e?.message].filter(Boolean).join(' ');
}

const GRAPH_UNREACHABLE =
  /ECONNREFUSED|ServiceUnavailable|Could not perform discovery|No routing servers available|SessionExpired|Connection (was )?(closed|refused|lost)|socket hang up/i;

const GRAPH_AUTH =
  /Neo\.ClientError\.Security|authentication fail|unauthorized|invalid (auth|bearer|credentials|token)|token (mismatch|rejected)/i;

/**
 * Turn a thrown value into lines worth printing.
 *
 * Always returns something. The final case is the original message, which is the
 * honest answer when Ichor genuinely does not know what went wrong.
 */
export function explainFailure(error: unknown): string[] {
  const text = textOf(error);
  const e = error as NodeError;

  if (GRAPH_UNREACHABLE.test(text)) {
    return [
      '',
      'Ichor cannot reach its graph database.',
      '',
      '  HydraDB answers on the Bolt port (7687) and runs in Docker. Start it:',
      '',
      '      ichor up',
      '',
      '  If that reports the stack is already running, something else is holding',
      '  the port — `docker ps` will say what.',
      '',
    ];
  }

  if (GRAPH_AUTH.test(text)) {
    return [
      '',
      'HydraDB rejected the token Ichor authenticated with.',
      '',
      '  This happens when a running stack outlives the token that created it —',
      '  usually containers left behind by an older Ichor. Restart the stack:',
      '',
      '      ichor down --wipe',
      '      ichor up',
      '',
      '  `--wipe` discards the stored graph. Nothing is lost that cannot be rebuilt',
      '  from your code on the next run.',
      '',
    ];
  }

  if (e?.code === 'EACCES' || e?.code === 'EPERM') {
    return [
      '',
      `Ichor was not allowed to write to ${e.path ?? 'a file it needs'}.`,
      '',
      '  Check the permissions on that path. On Windows this is usually a file held',
      '  open by another program, or a folder synced by OneDrive mid-write.',
      '',
    ];
  }

  if (e?.code === 'ENOSPC') {
    return [
      '',
      'The disk is full, so Ichor could not write its state.',
      '',
      '  Ichor keeps its index in `.ichor/` and its graph in a Docker volume.',
      '  `docker system df` will say how much Docker is holding.',
      '',
    ];
  }

  if (e?.code === 'ENOENT' && e.path) {
    return ['', `Ichor expected a file that is not there: ${e.path}`, ''];
  }

  /**
   * Not recognised.
   *
   * Print what we were given rather than a guess, and point at the switch that
   * produces a stack trace — because the next person to see this message is the
   * one who has to debug it.
   */
  const message = (e?.message ?? String(error)).trim();
  return [
    '',
    message || 'Ichor failed, and the error carried no message.',
    '',
    '  Ichor does not recognise this failure. Re-running with ICHOR_DEBUG=1 prints',
    '  the full stack trace, which is the thing worth pasting into an issue:',
    '',
    '      https://github.com/rohit-jsfreaky/ichor/issues',
    '',
  ];
}
