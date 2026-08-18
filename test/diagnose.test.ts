/**
 * The words a person reads when Ichor cannot start.
 *
 * These tests exist because of one real report. `ichor up` was run with Docker
 * Desktop closed, and what came back was Docker's own sentence about a named
 * pipe — true, and with no way to get from it to "start Docker Desktop".
 *
 * So the assertions here are deliberately about the TEXT, not about types. A
 * message that classifies correctly and still fails to name the thing to do has
 * not fixed the bug that prompted it. Each case therefore checks two properties:
 * the failure is recognised at all, and the answer contains the action.
 *
 * The raw strings below are copied from real Docker output rather than invented,
 * because a translator tested only against its own idea of the input is a
 * translator that works only on that idea.
 */

import { describe, expect, it } from 'vitest';

import { explainCompose, explainDocker, type DockerStatus } from '../src/stack/diagnose.js';
import { explainFailure } from '../src/errors.js';

/** Docker Desktop closed, on Windows. The message that started all of this. */
const DAEMON_DOWN_WINDOWS =
  "unable to get image 'minio/minio:RELEASE.2025-07-23T15-54-02Z': failed to connect to " +
  'the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is ' +
  'correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: The ' +
  'system cannot find the file specified.';

/** The same condition on Linux and macOS, which name a socket instead of a pipe. */
const DAEMON_DOWN_UNIX =
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';

const text = (lines: string[] | undefined) => (lines ?? []).join('\n');

describe('the report that started this', () => {
  it('turns the named-pipe error into an instruction', () => {
    const answer = text(explainCompose(DAEMON_DOWN_WINDOWS));

    expect(answer).not.toBe('');
    // The whole point: it must say what to do, not what failed.
    expect(answer).toMatch(/Docker Desktop|systemctl start docker/);
    expect(answer).toMatch(/ichor up/);
  });

  it('recognises the same failure when it names a socket instead of a pipe', () => {
    expect(text(explainCompose(DAEMON_DOWN_UNIX))).toMatch(/Docker Desktop|systemctl start docker/);
  });
});

describe('explainDocker', () => {
  it('says nothing when Docker is fine', () => {
    expect(explainDocker({ kind: 'ok', version: '29.6.1' })).toEqual([]);
  });

  it.each([
    ['daemon-down', /not running/i, /Docker Desktop|systemctl/],
    ['missing', /not installed/i, /docs\.docker\.com/],
    ['permission', /not allowed/i, /usermod -aG docker/],
    ['starting', /still starting/i, /ichor up/],
  ] as const)('explains %s with an action', (kind, names, action) => {
    const answer = text(explainDocker({ kind } as DockerStatus));
    expect(answer).toMatch(names);
    expect(answer).toMatch(action);
  });

  it('quotes Docker verbatim when it does not recognise the failure', () => {
    const weird = 'Error response from daemon: something nobody has seen before';
    const answer = text(explainDocker({ kind: 'unclear', detail: weird }));

    // Never swallow the original. An unrecognised error must survive intact, or
    // the reader loses the only evidence they had.
    expect(answer).toContain(weird);
    expect(answer).toMatch(/could not work out why/i);
  });

  it('does not invent a cause it cannot see', () => {
    const answer = text(explainDocker({ kind: 'unclear', detail: 'unknown failure' }));
    expect(answer).not.toMatch(/not installed|not running/i);
  });
});

describe('explainCompose', () => {
  it('reads a port conflict as a port conflict', () => {
    const answer = text(
      explainCompose(
        'Error response from daemon: Ports are not available: exposing port TCP ' +
          '0.0.0.0:7687 -> 0.0.0.0:0: listen tcp 0.0.0.0:7687: bind: Only one usage of ' +
          'each socket address is normally permitted.',
      ),
    );
    expect(answer).toMatch(/already using/i);
    expect(answer).toMatch(/7687/);
    expect(answer).toMatch(/ichor down/);
  });

  /**
   * Found by running `ichor up` for real, not by imagining failures.
   *
   * Docker Desktop had been closed with a stack running, so the containers
   * survived in a stopped state. `docker ps` was empty and the names were still
   * taken, which reads as a collision from nowhere.
   */
  it('recognises containers left behind by a previous stack', () => {
    const answer = text(
      explainCompose(
        'Error response from daemon: Conflict. The container name "/ichor-minio" is ' +
          'already in use by container "4ea14b83011ef89c0cce983c85f99253066c9bd0". You ' +
          'have to remove (or rename) that container to be able to reuse that name.',
      ),
    );
    expect(answer).toMatch(/left its containers behind/i);
    expect(answer).toMatch(/ichor down/);
    // Verified by hand: `ichor down` really does clear this. Advice that does not
    // work is worse than no advice, so this must stay true.
    expect(answer).toMatch(/docker rm -f/);
  });

  it('reads a full disk as a full disk', () => {
    const answer = text(explainCompose('write /var/lib/docker: no space left on device'));
    expect(answer).toMatch(/disk space/i);
    expect(answer).toMatch(/docker system df/);
  });

  it('separates being rate-limited from being offline', () => {
    const limited = text(explainCompose('toomanyrequests: You have reached your pull rate limit.'));
    expect(limited).toMatch(/docker login/);

    const offline = text(
      explainCompose('failed to resolve reference: dial tcp: lookup registry-1.docker.io: no such host'),
    );
    expect(offline).toMatch(/internet|proxy/i);
    expect(offline).not.toMatch(/docker login/);
  });

  it('returns undefined rather than guessing', () => {
    // Compose has already printed its own output. Saying nothing is correct here;
    // saying something wrong is not.
    expect(explainCompose('some failure with no known signature')).toBeUndefined();
  });
});

describe('explainFailure', () => {
  it('sends an unreachable graph to `ichor up`', () => {
    const answer = text(
      explainFailure(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7687'), {
        code: 'ECONNREFUSED',
      })),
    );
    expect(answer).toMatch(/cannot reach its graph/i);
    expect(answer).toMatch(/ichor up/);
  });

  it('recognises the driver phrasing, which never mentions Ichor', () => {
    const answer = text(explainFailure(new Error('Could not perform discovery. No routing servers available.')));
    expect(answer).toMatch(/ichor up/);
  });

  it('explains a stale auth token as a stack to restart', () => {
    const answer = text(explainFailure(new Error('Neo.ClientError.Security.Unauthorized')));
    expect(answer).toMatch(/ichor down --wipe/);
    // The reader is about to discard a graph; they are owed the consequence.
    expect(answer).toMatch(/discards the stored graph/i);
  });

  it('names the path it could not write', () => {
    const answer = text(
      explainFailure(Object.assign(new Error('permission denied'), {
        code: 'EACCES',
        path: 'D:/repo/.ichor/state.json',
      })),
    );
    expect(answer).toContain('D:/repo/.ichor/state.json');
  });

  it('keeps the original message when it recognises nothing', () => {
    const answer = text(explainFailure(new Error('a genuinely novel problem')));
    expect(answer).toContain('a genuinely novel problem');
    expect(answer).toMatch(/ICHOR_DEBUG=1/);
  });

  it('survives a thrown value that is not an Error', () => {
    expect(() => explainFailure('just a string')).not.toThrow();
    expect(text(explainFailure('just a string'))).toContain('just a string');
    expect(() => explainFailure(undefined)).not.toThrow();
  });
});
