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
import { nodeKey } from '../ids.js';
import type { ModelFact, FieldFact } from './types.js';

export interface PrismaSchema {
  models: ModelFact[];
  fields: FieldFact[];
  /** Where the schema was found, for reporting. */
  schemaPath?: string;
}

const CANDIDATE_PATHS = [
  'prisma/schema.prisma',
  'schema.prisma',
  'src/prisma/schema.prisma',
  'apps/web/prisma/schema.prisma',
  'packages/db/prisma/schema.prisma',
];

/** Locate schema.prisma, or undefined if this repo does not use Prisma. */
export function findSchema(repoRoot: string): string | undefined {
  for (const rel of CANDIDATE_PATHS) {
    const full = path.join(repoRoot, rel);
    if (fs.existsSync(full)) return full;
  }
  return undefined;
}

/**
 * Read models and fields.
 *
 * Returns empty lists when there is no schema — a repo without Prisma still has
 * a useful call graph, it just has no model layer.
 */
export function parsePrismaSchema(repoRoot: string): PrismaSchema {
  const schemaPath = findSchema(repoRoot);
  if (!schemaPath) return { models: [], fields: [] };

  const source = fs.readFileSync(schemaPath, 'utf8');
  const models: ModelFact[] = [];
  const fields: FieldFact[] = [];

  // `model Vendor {  ...  }` — non-greedy body, closing brace at column 0.
  const modelBlock = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;

  for (const match of source.matchAll(modelBlock)) {
    const modelName = match[1];
    const body = match[2];

    models.push({ key: nodeKey('model', modelName), name: modelName });

    for (const rawLine of body.split('\n')) {
      const line = stripComment(rawLine).trim();
      if (!line || line.startsWith('@@')) continue;

      // `email String @unique` — name, type, then attributes.
      const field = /^(\w+)\s+([\w\[\]?]+)(.*)$/.exec(line);
      if (!field) continue;

      const [, fieldName, fieldType, attributes] = field;

      fields.push({
        key: nodeKey('field', `${modelName}.${fieldName}`),
        model: modelName,
        name: fieldName,
        type: fieldType,
        isUnique: /@unique\b/.test(attributes),
        isId: /@id\b/.test(attributes),
      });
    }
  }

  return { models, fields, schemaPath };
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
