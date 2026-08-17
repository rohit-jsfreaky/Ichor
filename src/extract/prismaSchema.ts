/**
 * Parse `schema.prisma` into models and fields.
 *
 * Prisma's schema *declares* the data model, so this is read, never inferred.
 * That is what lets Ichor say "the submit path already reaches `Vendor.email`,
 * which is @unique" as a fact rather than a guess.
 *
 * Deliberately a small regex reader rather than a dependency on Prisma's own
 * parser: we need model names, field names, types and `@unique`/`@id`, and
 * nothing else. If that stops being enough, swap this file — nothing else knows
 * how the schema is read.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeKey, normalisePath, repoIdFor } from '../ids.js';
import type { ModelFact, FieldFact } from './types.js';

export interface PrismaSchema {
  models: ModelFact[];
  fields: FieldFact[];
  /** Where the schema was found, for reporting. */
  schemaPath?: string;
}

/** Never worth walking into, and `migrations` holds SQL, not schema. */
const SKIP_DIRS = new Set([
  'node_modules', 'migrations', 'dist', 'build', 'out', '.next', 'coverage', 'generated',
]);

/** Deep enough for `apps/web/prisma/schema/`, shallow enough to stay cheap. */
const MAX_DEPTH = 4;

/**
 * Find every `.prisma` file in the repo.
 *
 * A fixed list of candidate paths is what this used to be, and it was wrong for
 * three of the four real codebases we tested against. Prisma's multi-file layout
 * — `prisma/schema/*.prisma`, one file per domain — is the modern default for
 * anything large, and monorepos scatter the schema anywhere: `packages/prisma/`,
 * `apps/web/prisma/schema/`. Missing it fails SILENTLY: no models, no data
 * anchors, and a task boundary quietly missing the layer that makes test 2 work.
 *
 * So: walk and collect. `.prisma` files are rare, and the skip list keeps it cheap.
 */
export function findSchemas(repoRoot: string): string[] {
  const found: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory is not a reason to fail the analysis
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (entry.name.endsWith('.prisma')) {
        found.push(full);
      }
    }
  };

  walk(repoRoot, 0);
  return found.sort();
}

/** The first schema found, for callers that only want to report a location. */
export function findSchema(repoRoot: string): string | undefined {
  return findSchemas(repoRoot)[0];
}

/**
 * Read models and fields.
 *
 * Returns empty lists when there is no schema — a repo without Prisma still has
 * a useful call graph, it just has no model layer.
 */
export function parsePrismaSchema(repoRoot: string): PrismaSchema {
  const repoId = repoIdFor(repoRoot);
  const schemaPaths = findSchemas(repoRoot);
  if (schemaPaths.length === 0) return { models: [], fields: [] };

  const source = schemaPaths.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const models: ModelFact[] = [];
  const fields: FieldFact[] = [];
  // Split schemas can repeat a model across files. Node ids are derived from the
  // key, so a duplicate would not collide — it would quietly write the same node
  // twice and duplicate every HAS_FIELD edge, which `CREATE` does not dedupe.
  const seen = new Set<string>();

  // `model Vendor {  ...  }` — non-greedy body, closing brace at column 0.
  const modelBlock = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;

  // One file at a time, rather than every schema concatenated. Joining them lost
  // which file declared which model, and that is exactly what makes a schema
  // edit understandable instead of unexplained.
  for (const schemaPath of schemaPaths) {
    const source = fs.readFileSync(schemaPath, 'utf8');
    const file = normalisePath(schemaPath, repoRoot);

    for (const match of source.matchAll(modelBlock)) {
      const modelName = match[1];
      const body = match[2];

      const modelKey = nodeKey(repoId, 'model', modelName);
      if (seen.has(modelKey)) continue;
      seen.add(modelKey);
      models.push({ key: modelKey, name: modelName, file });

      for (const rawLine of body.split('\n')) {
        const line = stripComment(rawLine).trim();
        if (!line || line.startsWith('@@')) continue;

        // `email String @unique` — name, type, then attributes.
        const field = /^(\w+)\s+([\w\[\]?]+)(.*)$/.exec(line);
        if (!field) continue;

        const [, fieldName, fieldType, attributes] = field;

        const fieldKey = nodeKey(repoId, 'field', `${modelName}.${fieldName}`);
        if (seen.has(fieldKey)) continue;
        seen.add(fieldKey);

        fields.push({
          key: fieldKey,
          model: modelName,
          name: fieldName,
          type: fieldType,
          isUnique: /@unique\b/.test(attributes),
          isId: /@id\b/.test(attributes),
        });
      }
    }
  }

  return { models, fields, schemaPath: schemaPaths[0] };
}

/** Drop a trailing `//` comment without mangling a `//` inside a string. */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (ch === '"') inString = !inString;
    if (!inString && ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}
