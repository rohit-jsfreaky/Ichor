/**
 * The local HydraDB stack, as a file Ichor can write into somebody else's repo.
 *
 * `ichor init` emits this next to the hooks. Without it the quick start is a
 * lie: `npm i -g ichor-cli` gives you the CLI, but `ichor start` needs a graph
 * database, and nobody installing a global npm package also has this project's
 * docker-compose.yml.
 *
 * Kept byte-identical to the repo's own docker-compose.yml except for the token
 * mount, which moves to `.ichor/` because a consumer repo has no `docker/`
 * directory. test/stack.test.ts holds the two in sync.
 */

export const COMPOSE_FILE = 'docker-compose.ichor.yml';

/** Relative to the repo root. Written by `ichor init`, read by the container. */
export const TOKEN_FILE = '.ichor/hydradb-auth-token';

/**
 * Dev-only, and deliberately not a secret.
 *
 * Every port in this stack binds to 127.0.0.1, so the token guards a socket
 * that nothing off this machine can reach. It matches the client default in
 * graph/client.ts — change one and you must change the other.
 */
export const AUTH_TOKEN = 'ichor-local-development-token-32b';

export const COMPOSE_YAML = `# Ichor's local stack: MinIO (S3-compatible object storage) + HydraDB.
#
# Written by \`ichor init\`. Safe to commit, safe to delete — \`ichor init\`
# writes it again. Everything binds to 127.0.0.1.
#
# WHY MinIO AND NOT \`CLOUD_PROVIDER=local\`:
#   HydraDB's documented local mode cannot sustain writes — manifest GC fails
#   permanently. S3-compatible storage is the supported write path.
#
# WHY \`CLOUD_PROVIDER=aws\` WHEN THERE IS NO AWS HERE:
#   Straight from HydraDB's own benchmark harness: CLOUD_PROVIDER=aws selects
#   the S3 protocol, not Amazon. AWS_ENDPOINT points it at MinIO.
#
#   Start:  ichor up      (or: docker compose -f ${COMPOSE_FILE} up -d)
#   Stop:   ichor down

services:
  minio:
    image: minio/minio:RELEASE.2025-07-23T15-54-02Z
    container_name: ichor-minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: \${MINIO_ROOT_USER:-ichor}
      MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD:-ichor-dev-secret}
    ports:
      - "127.0.0.1:9000:9000"
      - "127.0.0.1:9001:9001"
    volumes:
      - minio-data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 3s
      timeout: 3s
      retries: 20
      start_period: 5s

  # HydraDB expects the bucket to already exist. This runs once and exits.
  minio-init:
    image: minio/mc:RELEASE.2025-04-16T18-13-26Z
    container_name: ichor-minio-init
    depends_on:
      minio:
        condition: service_healthy
    environment:
      MINIO_ROOT_USER: \${MINIO_ROOT_USER:-ichor}
      MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD:-ichor-dev-secret}
      ICHOR_BUCKET: \${ICHOR_BUCKET:-ichor}
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 $$MINIO_ROOT_USER $$MINIO_ROOT_PASSWORD &&
      mc mb --ignore-existing local/$$ICHOR_BUCKET &&
      echo 'bucket ready: '$$ICHOR_BUCKET
      "

  hydradb:
    image: ghcr.io/hydra-db/hydradb:latest
    container_name: ichor-hydradb
    depends_on:
      minio-init:
        condition: service_completed_successfully
    environment:
      # --- storage: S3 protocol, pointed at MinIO ---
      CLOUD_PROVIDER: aws
      AWS_ACCESS_KEY_ID: \${MINIO_ROOT_USER:-ichor}
      AWS_SECRET_ACCESS_KEY: \${MINIO_ROOT_PASSWORD:-ichor-dev-secret}
      AWS_DEFAULT_REGION: us-east-1
      AWS_ENDPOINT: http://minio:9000
      AWS_BUCKET: \${ICHOR_BUCKET:-ichor}
      # Both of these are REQUIRED for MinIO and appear only in HydraDB's
      # benchmark harness, not in its README. Without them the node starts,
      # listens on 7687, and every object-store operation fails — a
      # healthy-looking but dead node.
      AWS_ALLOW_HTTP: "true"
      AWS_VIRTUAL_HOSTED_STYLE_REQUEST: "false"

      # --- graph identity / topology (single dev node) ---
      GRAPH_NAMESPACE: default
      GRAPH_ID: default
      GRAPH_CELL_ID: cell-0
      GRAPH_CELLS: cell-0
      GRAPH_NODE_ID: node-0
      GRAPH_BOLT_NODE_ADDRESSES: node-0=0.0.0.0:7687
      GRAPH_ADVERTISED_BOLT_ADDR: 127.0.0.1:7687

      # --- local disposable state ---
      GRAPH_DATA_CACHE_DIR: /cache
      GRAPH_AUTH_TOKEN_FILE: /run/secrets/hydradb-auth-token
      GRAPH_ALLOW_PLAINTEXT: "true"   # dev only — TLS is required in real deployments
      RUST_MIN_STACK: "33554432"
    ports:
      - "127.0.0.1:7687:7687"   # Bolt   <- this is the one Ichor uses
      - "127.0.0.1:8443:8443"   # HTTP query API
      - "127.0.0.1:9090:9090"   # metrics
    volumes:
      - hydradb-cache:/cache
      - ./${TOKEN_FILE}:/run/secrets/hydradb-auth-token:ro

volumes:
  minio-data:
  hydradb-cache:
`;
