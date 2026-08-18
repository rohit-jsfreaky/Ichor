/**
 * Turning Docker's failures into sentences a person can act on.
 *
 * `ichor up` is the first command anyone runs, and its failure mode was to hand
 * Docker's own stderr to the reader unedited:
 *
 *     unable to get image 'minio/minio:RELEASE.2025-07-23T15-54-02Z': failed to
 *     connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine;
 *     check if the path is correct and if the daemon is running: open
 *     //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.
 *
 * Every word of that is true, and none of it says *start Docker Desktop*. The
 * reader is handed a named pipe and left to infer the product. This module exists
 * so the common failures — and it is a short list — arrive as an instruction
 * rather than as a diagnosis.
 *
 * TWO RULES, both learned from the message above.
 *
 * **Never swallow what Docker said.** An unrecognised failure prints Docker's own
 * text verbatim. A confident wrong translation is worse than a raw error, because
 * it spends the reader's trust as well as their time — the same reason
 * `stack.ts:down` stopped printing advice it could not stand behind.
 *
 * **Never name a cause the evidence does not support.** These are pattern matches
 * on error text, not proof. Where a symptom has more than one cause, the message
 * says so and gives the command that distinguishes them, instead of guessing.
 */

import { spawn } from 'node:child_process';

/** How long to wait for `docker info` before calling Docker unresponsive. */
const PROBE_TIMEOUT_MS = 12_000;

export type DockerStatus =
  /** Daemon reachable and answering. */
  | { kind: 'ok'; version: string }
  /** No `docker` binary on PATH. */
  | { kind: 'missing' }
  /** Binary present, daemon not listening. Overwhelmingly the common case. */
  | { kind: 'daemon-down' }
  /** Daemon listening, this user not permitted to talk to it. Linux, usually. */
  | { kind: 'permission' }
  /** Reachable but not answering yet — Docker Desktop mid-boot. */
  | { kind: 'starting' }
  /** Something real, but not something this module recognises. */
  | { kind: 'unclear'; detail: string };

interface Probe {
  code: number;
  stdout: string;
  stderr: string;
  spawnFailed: boolean;
  timedOut: boolean;
}

function probe(command: string, args: string[], timeoutMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: Probe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ code: 1, stdout, stderr, spawnFailed: false, timedOut: true });
    }, timeoutMs);

    child.stdout?.on('data', (d) => (stdout += String(d)));
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', () => finish({ code: 127, stdout, stderr, spawnFailed: true, timedOut: false }));
    child.on('close', (code) =>
      finish({ code: code ?? 1, stdout, stderr, spawnFailed: false, timedOut: false }),
    );
  });
}

/**
 * Anything that means "the daemon is not there".
 *
 * Windows names a pipe, macOS and Linux name a unix socket, and Docker's own
 * wording has changed across versions — so this matches the shapes rather than
 * any one sentence.
 */
const DAEMON_DOWN =
  /docker daemon is not running|cannot connect to the docker daemon|failed to connect to the docker API|is the docker daemon running|the system cannot find the file specified|no such file or directory.*docker\.sock|dockerDesktopLinuxEngine|docker_engine|open \/\/\.\/pipe/i;

const PERMISSION = /permission denied.*docker\.sock|dial unix.*permission denied|got permission denied while trying to connect/i;

function classify(text: string): DockerStatus {
  if (PERMISSION.test(text)) return { kind: 'permission' };
  if (DAEMON_DOWN.test(text)) return { kind: 'daemon-down' };
  return { kind: 'unclear', detail: text.trim() };
}

/** Ask Docker whether it is actually there, before asking it to do anything. */
export async function checkDocker(): Promise<DockerStatus> {
  const result = await probe('docker', ['info', '--format', '{{.ServerVersion}}'], PROBE_TIMEOUT_MS);

  if (result.spawnFailed) return { kind: 'missing' };
  if (result.timedOut) return { kind: 'starting' };

  const version = result.stdout.trim();
  if (result.code === 0 && version) return { kind: 'ok', version };

  return classify(`${result.stderr}\n${result.stdout}`);
}

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/** Where "start Docker" points depends on how Docker got installed. */
function startDockerHint(): string[] {
  if (isWindows || isMac) {
    return [
      '  Start Docker Desktop and wait until it reports "Engine running", then:',
      '',
      '      ichor up',
    ];
  }
  return [
    '  Start the daemon, then run `ichor up` again:',
    '',
    '      sudo systemctl start docker',
  ];
}

/** Indent someone else's error text so it reads as a quotation, not as our voice. */
function quote(text: string, limit = 6): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
  const shown = lines.slice(0, limit).map((l) => `      ${l}`);
  if (lines.length > limit) shown.push(`      … ${lines.length - limit} more line(s)`);
  return shown;
}

/**
 * The whole point of the module: a status becomes something to do.
 *
 * Returns the lines to print. Never returns anything for `ok`.
 */
export function explainDocker(status: DockerStatus): string[] {
  switch (status.kind) {
    case 'ok':
      return [];

    case 'daemon-down':
      return [
        '',
        'Docker is installed, but it is not running.',
        '',
        '  Ichor keeps its graph in HydraDB, and HydraDB runs in Docker.',
        '',
        ...startDockerHint(),
        '',
      ];

    case 'missing':
      return [
        '',
        'Docker is not installed, or it is not on your PATH.',
        '',
        '  Ichor keeps its graph in HydraDB, and HydraDB runs in Docker. There is no',
        '  other storage mode, so `ichor up` has nothing to start without it.',
        '',
        '      Install Docker Desktop:  https://docs.docker.com/get-started/get-docker/',
        '',
        "  If Docker IS installed, it is not on this shell's PATH — check with:",
        '',
        '      docker --version',
        '',
      ];

    case 'permission':
      return [
        '',
        'Docker is running, but this user is not allowed to talk to it.',
        '',
        '      sudo usermod -aG docker $USER',
        '',
        '  Then log out and back in — group membership is only read at login.',
        '',
      ];

    case 'starting':
      return [
        '',
        `Docker did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds. It is probably still starting.`,
        '',
        '  Give it a moment and run `ichor up` again. If it never becomes ready,',
        '  restart Docker Desktop and watch for "Engine running".',
        '',
      ];

    case 'unclear':
      return [
        '',
        'Ichor could not reach Docker, and could not work out why.',
        '',
        '  Docker said:',
        '',
        ...quote(status.detail),
        '',
        '  Ichor needs a running Docker daemon to start HydraDB. If that text does not',
        '  suggest a fix, `docker info` on its own usually says more.',
        '',
      ];
  }
}

/**
 * Translate a `docker compose` failure.
 *
 * Ordered most-specific first, and deliberately incomplete: it returns undefined
 * when nothing matches, and the caller then leaves Docker's own output as the
 * last word. Compose has already streamed that output to the terminal, so an
 * unrecognised failure is never silent — it is simply not editorialised.
 */
export function explainCompose(stderr: string): string[] | undefined {
  const text = stderr.toLowerCase();

  const say = (...lines: string[]) => ['', ...lines, ''];

  // The daemon went away mid-run, or was never there and the preflight was skipped.
  if (DAEMON_DOWN.test(stderr)) {
    return say(
      'Docker stopped responding while Ichor was starting the stack.',
      '',
      ...startDockerHint(),
    );
  }

  // Windows-specific: the Linux backend failed rather than Docker itself.
  if (/wsl|virtual machine platform|hypervisor|vmcompute|hcs_e_/i.test(stderr)) {
    return say(
      "Docker's Linux backend (WSL 2) failed to start.",
      '',
      '  This is a Docker installation problem rather than an Ichor one. The usual fix:',
      '',
      '      wsl --update',
      '',
      '  then restart Docker Desktop. If that fails, Docker Desktop → Settings →',
      '  Troubleshoot → Reset to factory defaults is the reliable last resort.',
    );
  }

  /**
   * Containers that exist but are not running.
   *
   * Closing Docker Desktop stops containers without removing them, so the names
   * stay claimed. `docker ps` shows nothing, which makes this look like a name
   * collision out of nowhere — it is simply the last stack, still there.
   */
  if (/container name .* is already in use|conflict\. the container name/i.test(text)) {
    return say(
      'An earlier Ichor stack left its containers behind.',
      '',
      '  They exist but are not running, which is what closing Docker Desktop does to',
      '  them. Removing them is safe: the graph lives in a Docker volume, not in the',
      '  containers.',
      '',
      '      ichor down',
      '      ichor up',
      '',
      '  If `ichor down` cannot find them because the stack was started somewhere',
      '  else, remove them by name:',
      '',
      '      docker rm -f ichor-hydradb ichor-minio ichor-minio-init',
    );
  }

  if (
    /port is already allocated|address already in use|only one usage of each socket address|failed to bind host port|bind: an attempt was made/i.test(
      stderr,
    )
  ) {
    const inspect = isWindows ? 'netstat -ano | findstr :7687' : 'lsof -i :7687';
    return say(
      "Something is already using one of HydraDB's ports.",
      '',
      '  Ichor needs 7687 (Bolt), 9000 and 9001 (MinIO). The usual culprits are an',
      '  Ichor stack still running from another repo, a local Neo4j, or a container',
      '  that was never stopped.',
      '',
      '  See what is running, and what is holding the port:',
      '',
      '      docker ps',
      `      ${inspect}`,
      '',
      '  If it is an Ichor stack from another repo, this stops it from here:',
      '',
      '      ichor down',
    );
  }

  if (/no space left on device|disk quota exceeded/i.test(text)) {
    return say(
      'Docker has run out of disk space.',
      '',
      '  Reclaim what Docker is holding — this deletes unused images and volumes,',
      '  so read what it lists before agreeing:',
      '',
      '      docker system df        how much is in use',
      '      docker system prune     remove what nothing is using',
    );
  }

  if (
    /pull access denied|manifest unknown|manifest for .* not found|repository does not exist|unauthorized: authentication required|toomanyrequests/i.test(
      stderr,
    )
  ) {
    return say(
      'Docker could not pull one of the images.',
      '',
      '  Either Docker Hub is rate-limiting this IP — which it does to anonymous',
      '  pulls — or the image is genuinely unreachable. Signing in raises the limit:',
      '',
      '      docker login',
    );
  }

  if (
    /dial tcp|no such host|i\/o timeout|tls handshake|failed to resolve|temporary failure in name resolution|network is unreachable|proxyconnect/i.test(
      text,
    )
  ) {
    return say(
      'Docker could not reach the internet to download the images.',
      '',
      '  The first `ichor up` has to pull HydraDB and MinIO; every run after that is',
      '  offline. Check your connection, and any VPN or corporate proxy — Docker',
      '  needs its own proxy settings, it does not inherit the shell’s.',
    );
  }

  return undefined;
}
