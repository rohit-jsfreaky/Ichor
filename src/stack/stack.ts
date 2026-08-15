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

function docker(args: string[], repoRoot: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { cwd: repoRoot, stdio: 'inherit', shell: false });
    child.on('error', () => resolve(127)); // docker not installed
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function up(repoRoot: string): Promise<number> {
  if (await isRunning()) {
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

export async function down(repoRoot: string, wipe: boolean): Promise<number> {
  const compose = path.join(repoRoot, COMPOSE_FILE);
  if (!fs.existsSync(compose)) {
    console.error(`${COMPOSE_FILE} not found. Nothing to stop.\n`);
    return 1;
  }

  const args = ['compose', '-f', COMPOSE_FILE, 'down'];
  if (wipe) args.push('-v');
  const code = await docker(args, repoRoot);
  console.log(wipe ? '\nStack stopped and the graph wiped.\n' : '\nStack stopped. The graph is kept.\n');
  return code;
}
