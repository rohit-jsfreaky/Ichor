/**
 * Starting and stopping the local graph database.
 *
 * Thin wrappers over `docker compose`, with one piece of real logic: Ichor uses
 * ONE HydraDB per machine, not one per repo. The Bolt port and the container
 * names are global, so a second stack cannot start anyway — `up` therefore
 * checks whether the database already answers before it touches Docker, and
 * reports that as success rather than as a name collision.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { GraphClient, configFromEnv } from '../graph/client.js';
import { AUTH_TOKEN, COMPOSE_FILE, COMPOSE_YAML, TOKEN_FILE } from './compose.js';

export interface StackFiles {
  compose: string;
  token: string;
  wrote: boolean;
}

/**
 * Write the compose file and the auth token into a repo.
 *
 * Both are rewritten every time. They are generated artefacts, not user
 * configuration, and a stale compose file from an older Ichor is worse than no
 * compose file at all.
 */
export function writeStack(repoRoot: string): StackFiles {
  const compose = path.join(repoRoot, COMPOSE_FILE);
  const token = path.join(repoRoot, TOKEN_FILE);

  fs.mkdirSync(path.dirname(token), { recursive: true });
  // No trailing newline games: HydraDB reads this file raw, and the client
  // sends the same string from graph/client.ts.
  fs.writeFileSync(token, `${AUTH_TOKEN}\n`, 'utf8');
  fs.writeFileSync(compose, COMPOSE_YAML, 'utf8');

  return { compose, token, wrote: true };
}

/** Is a HydraDB already listening and answering queries? */
export async function isRunning(): Promise<boolean> {
  const client = new GraphClient(configFromEnv());
  try {
    await client.verify();
    return true;
  } catch {
    return false;
  } finally {
    await client.close();
  }
}

/**
 * Which directory the running stack was started from, if one is running.
 *
 * Compose stamps every container it creates with the working directory of the
 * project that owns it, and that label is the only thing that can answer the
 * question that matters here: is the graph currently answering MY repository's
 * questions, or another one's?
 *
 * It matters because the container names are global (`ichor-hydradb`) while
 * Compose scopes ownership by PROJECT, which defaults to the directory name. So
 * a stack started in `~/work/alpha` is invisible to compose commands run in
 * `~/work/beta`, even though `beta` can talk to it perfectly well over Bolt.
 *
 * Returns undefined when nothing is running, when docker is absent, or when the
 * label is missing — all of which mean "cannot tell", never "same repo".
 */
interface RunningStack {
  /** The directory Compose was invoked in. */
  dir?: string;
  /** The Compose PROJECT, which is what identifies the containers. */
  project?: string;
}

async function runningStack(): Promise<RunningStack> {
  const label =
    '{{index .Config.Labels "com.docker.compose.project.working_dir"}}|' +
    '{{index .Config.Labels "com.docker.compose.project"}}';
  const output = await new Promise<string>((resolve) => {
    const child = spawn('docker', ['inspect', 'ichor-hydradb', '--format', label], {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
    });
    let out = '';
    child.stdout?.on('data', (d) => (out += String(d)));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });

  const clean = (v: string | undefined) => {
    const t = (v ?? '').trim();
    return t && t !== '<no value>' ? t : undefined;
  };
  const [dir, project] = output.trim().split('|');
  return { dir: clean(dir), project: clean(project) };
}

async function stackOwner(): Promise<string | undefined> {
  return (await runningStack()).dir;
}

/** Same directory, whatever the platform thinks about slashes and case. */
function sameDirectory(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[/\\]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function docker(args: string[], repoRoot: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { cwd: repoRoot, stdio: 'inherit', shell: false });
    child.on('error', () => resolve(127)); // docker not installed
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function up(repoRoot: string): Promise<number> {
  if (await isRunning()) {
    const owner = await stackOwner();

    /**
     * Reusing a running stack is correct — one HydraDB per machine is the design.
     * Reusing one WITHOUT SAYING WHOSE IT IS is not.
     *
     * The graph holds a `repo` property per node, so sharing a database is safe
     * for correctness. It is not free: every extra project makes every query
     * slower, because this engine cannot index that property. Someone who does
     * not know they inherited another repo's stack has no way to explain why
     * their queries are suddenly taking thirty seconds — which is exactly the
     * confusion this line now prevents.
     */
    if (owner && !sameDirectory(owner, repoRoot)) {
      console.log('HydraDB is already running. Nothing to do.');
      console.log(`\nNote: this stack was started in ${owner}, not here.`);
      console.log('Sharing it is safe — the graph keeps each repository separate — but every');
      console.log('extra project in one database makes every query slower, and `ichor down`');
      console.log('here will not be able to stop it.\n');
      return 0;
    }

    console.log('HydraDB is already running. Nothing to do.\n');
    return 0;
  }

  const compose = path.join(repoRoot, COMPOSE_FILE);
  if (!fs.existsSync(compose)) {
    console.error(`${COMPOSE_FILE} not found. Run: ichor init\n`);
    return 1;
  }

  // The compose file is committable; the token lives in gitignored `.ichor/`.
  // So a teammate who clones the repo has the first and not the second, and
  // Docker would silently bind-mount a DIRECTORY where a file belongs. Write it
  // back before that can happen.
  if (!fs.existsSync(path.join(repoRoot, TOKEN_FILE))) {
    writeStack(repoRoot);
    console.log(`Restored ${TOKEN_FILE}.`);
  }

  console.log('Starting HydraDB and MinIO…\n');
  const code = await docker(['compose', '-f', COMPOSE_FILE, 'up', '-d'], repoRoot);
  if (code === 127) {
    console.error('\nDocker was not found on PATH. Ichor needs Docker to run HydraDB.\n');
    return code;
  }
  if (code !== 0) return code;

  // Compose returns as soon as the containers are created. A listening port is
  // not proof of a working node — this waits for a query to round-trip.
  process.stdout.write('\nWaiting for the graph to answer… ');
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await isRunning()) {
      console.log('ready.\n');
      return 0;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('timed out.');
  console.log(`Check the logs: docker compose -f ${COMPOSE_FILE} logs hydradb\n`);
  return 1;
}

/**
 * Stop the stack that is actually running, wherever it was started from.
 *
 * THIS USED TO BE A DEAD END, and the dead end was of my own making.
 *
 * `down` looked for `docker-compose.ichor.yml` in the current repo and gave up if it
 * was missing. A previous fix noticed the related problem — Compose only stops
 * containers belonging to the PROJECT that created them, so `down` in repo B cannot
 * touch a stack started in repo A — and printed helpful advice: `cd <owner> && ichor
 * down`. Rohit followed it exactly and got:
 *
 *     docker-compose.ichor.yml not found. Nothing to stop.
 *
 * Because the owning directory was Ichor's own repo, whose stack comes from
 * `docker-compose.yml` (via `npm run up`) rather than the generated per-repo file. The
 * advice sent him somewhere that could not help him. I had spotted that case while
 * writing it and judged it acceptable; it was not — advice that fails is worse than no
 * advice, because it spends the reader's trust as well as their time.
 *
 * The file was never the right thing to key on. Compose stamps its PROJECT name onto
 * every container, and `docker compose -p <project> down` finds them by that label from
 * any directory, with no compose file present at all. So Ichor now identifies the
 * running stack and stops it, instead of explaining why it cannot.
 *
 * Only one stack can run per machine — the container names and the Bolt port are
 * global — so stopping "the" stack is unambiguous. It still says where the stack came
 * from when that is not here, because `--wipe` discards every project's graph and
 * someone who does not know they inherited a shared stack deserves to be told what
 * they just threw away.
 */
export async function down(repoRoot: string, wipe: boolean): Promise<number> {
  const running = await isRunning();
  const stack = await runningStack();

  if (!running && !stack.project) {
    // Not an error, and not a missing file — there is simply nothing to stop.
    console.log('\nHydraDB is not running. Nothing to stop.\n');
    return 0;
  }

  const localCompose = path.join(repoRoot, COMPOSE_FILE);
  const elsewhere = Boolean(stack.dir && !sameDirectory(stack.dir, repoRoot));

  // Prefer this repo's own compose file when it owns the stack: it is the most
  // explicit form, and it keeps working if the labels are ever absent.
  const useLocalFile = fs.existsSync(localCompose) && !elsewhere;

  const args = useLocalFile
    ? ['compose', '-f', COMPOSE_FILE, 'down']
    : ['compose', '-p', stack.project ?? 'ichor', 'down'];
  if (wipe) args.push('-v');

  if (elsewhere) {
    console.log(`\nThis stack was started in ${stack.dir}, not here.`);
    console.log(
      wipe
        ? 'Stopping it and wiping the graph — that discards EVERY project in this database.'
        : 'Stopping it anyway; Ichor runs one database per machine.',
    );
  }

  const code = await docker(args, repoRoot);
  if (code !== 0) {
    console.error('\nDocker could not stop the stack. Nothing was wiped.\n');
    return code;
  }

  /**
   * Claim nothing until the graph has actually stopped answering.
   *
   * `docker compose down` exits ZERO when it finds nothing of its own to remove, so
   * the success message used to print unconditionally. The `--wipe` version of that
   * was the dangerous one: you are told the graph is gone, it is not, and every query
   * afterwards silently answers out of another repository's code. That is not
   * hypothetical — it happened here, and the next command then timed out reading five
   * stale projects.
   */
  if (await isRunning()) {
    console.error('\nThe graph is still answering, so nothing was stopped or wiped.');
    console.error('Check `docker ps` — something is still holding the Bolt port.\n');
    return 1;
  }

  console.log(wipe ? '\nStack stopped and the graph wiped.\n' : '\nStack stopped. The graph is kept.\n');
  return 0;
}
