/**
 * The compose file Ichor writes into somebody else's repo.
 *
 * This is the one artefact a user never reviews before it runs, and three of
 * its lines took a day to find (see docker-compose.yml). A silent drift here
 * produces a HydraDB that starts, listens, and fails every write — so these
 * tests assert the specific settings that make it work, not that a file exists.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { COMPOSE_FILE, COMPOSE_YAML, TOKEN_FILE, AUTH_TOKEN } from '../src/stack/compose.js';
import { writeStack } from '../src/stack/stack.js';
import { configFromEnv } from '../src/graph/client.js';

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ichor-stack-'));
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('the emitted compose file', () => {
  it('keeps the four settings MinIO cannot work without', () => {
    // Documented only in HydraDB's benchmark harness. Losing any one of these
    // gives a node that looks healthy and cannot store anything.
    expect(COMPOSE_YAML).toContain('CLOUD_PROVIDER: aws');
    expect(COMPOSE_YAML).toContain('AWS_ENDPOINT: http://minio:9000');
    expect(COMPOSE_YAML).toContain('AWS_ALLOW_HTTP: "true"');
    expect(COMPOSE_YAML).toContain('AWS_VIRTUAL_HOSTED_STYLE_REQUEST: "false"');
  });

  it('exposes Bolt on the port the client connects to', () => {
    const { url } = configFromEnv({ url: undefined as unknown as string });
    const port = new URL(url.replace('bolt://', 'http://')).port;
    expect(COMPOSE_YAML).toContain(`127.0.0.1:${port}:7687`);
  });

  it('binds every published port to localhost only', () => {
    const published = [...COMPOSE_YAML.matchAll(/^\s+- "([^"]+:\d+:\d+)"/gm)].map((m) => m[1]);
    expect(published.length).toBeGreaterThan(0);
    for (const mapping of published) expect(mapping.startsWith('127.0.0.1:')).toBe(true);
  });

  it('mounts the token file that writeStack actually writes', () => {
    expect(COMPOSE_YAML).toContain(`./${TOKEN_FILE}:/run/secrets/hydradb-auth-token`);

    writeStack(repo);
    const written = path.join(repo, TOKEN_FILE);
    expect(fs.statSync(written).isFile()).toBe(true);
    // Docker bind-mounts a DIRECTORY when the source is missing, so the file
    // existing at exactly this path is the whole point of the assertion.
    expect(fs.readFileSync(written, 'utf8').trim()).toBe(AUTH_TOKEN);
  });

  it('uses the same token the graph client sends', () => {
    expect(configFromEnv({}).token).toBe(AUTH_TOKEN);
  });
});

describe('writeStack', () => {
  it('writes both files into the repo root', () => {
    const result = writeStack(repo);
    expect(fs.existsSync(path.join(repo, COMPOSE_FILE))).toBe(true);
    expect(result.compose).toBe(path.join(repo, COMPOSE_FILE));
  });

  it('overwrites a stale compose file rather than leaving it', () => {
    fs.writeFileSync(path.join(repo, COMPOSE_FILE), 'services: {}\n', 'utf8');
    writeStack(repo);
    expect(fs.readFileSync(path.join(repo, COMPOSE_FILE), 'utf8')).toBe(COMPOSE_YAML);
  });
});
