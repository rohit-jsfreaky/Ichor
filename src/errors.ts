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

/**
 * An error Ichor wrote on purpose, for a person to read.
 *
 * These already say what happened and what to do about it, so the fallback below
 * must hand them over untouched. Without the distinction they were printed
 * correctly and then followed by *"Ichor does not recognise this failure … paste
 * it into an issue"* — advice to report a bug, appended to a message Ichor had
 * carefully authored. Seen on a malformed `.claude/settings.json` and on `ichor
 * check` with no task open: both messages were exactly right, and both were
 * labelled as unexplained.
 *
 * A brand rather than an `instanceof` check, because a subclass does not survive
 * being thrown across a module boundary in every bundler, and this has to be
 * reliable in the one place a user is already having a bad time.
 */
export class IchorError extends Error {
  readonly isIchorError = true;

  constructor(message: string) {
    super(message);
    this.name = 'IchorError';
  }
}

/** Did Ichor author this message for a reader? */
function isAuthored(error: unknown): boolean {
  return Boolean(error) && (error as { isIchorError?: boolean }).isIchorError === true;
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

  /**
   * Ichor's own message, alone.
   *
   * Checked first so nothing below can second-guess a sentence written for this
   * exact situation — and so no "report a bug" boilerplate lands under it.
   */
  if (isAuthored(error)) {
    return ['', (e.message ?? '').trim(), ''];
  }

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

  /**
   * The graph answered too slowly and the server cut the query off.
   *
   * Nearly always one cause: several repositories share one database. HydraDB
   * cannot index the `repo` property every node carries, so each extra project
   * makes every query scan more, and three repos was enough to blow a 30s ceiling
   * on a query that is normally milliseconds. Ichor runs ONE database per machine
   * by design, so this is a foreseeable state, not a corruption — and it is
   * cheap to get out of.
   */
  if (/query timeout|client_query_runtime exceeded|Transaction[.]Terminated|exceeded query timeout/i.test(text)) {
    return [
      '',
      'The graph took too long to answer and the query was cut off.',
      '',
      '  This is almost always several repositories sharing one database. Ichor runs',
      '  one database per machine, and the engine cannot index which repo a node',
      '  belongs to — so every extra project makes every query slower.',
      '',
      '  Clear it and index just the repo you are working in:',
      '',
      '      ichor down --wipe',
      '      ichor up',
      '      ichor watch',
      '',
      '  `--wipe` discards the stored graph; the next run rebuilds it from your code.',
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
