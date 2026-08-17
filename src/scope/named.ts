/**
 * What a prompt names outright.
 *
 * Pure text parsing over the prompt: no graph, no facts, no repository. It lives
 * in its own module because both halves of scoping need it and they must not
 * import each other — `anchors` seeds a boundary from a named file, `taskSwitch`
 * decides whether a named file means the job changed. Putting this in either one
 * made them circular.
 */

/**
 * Things the prompt named outright, before any splitting or stemming.
 *
 * WHY THIS EXISTS
 *
 * *"Also refactor lib/utils.ts: extract the cn helper into its own file"* was
 * classified SAME. `lib/utils.ts` was shredded into `lib`, `utils` and `ts` —
 * all three on the STRUCTURAL list, so the one thing the prompt was unambiguously
 * about contributed NOTHING. What remained were the words *extract*, *file*,
 * *update* and *imports*, which match something in any codebase. Meanwhile `cn`,
 * the actual subject, was dropped for being under three characters.
 *
 * Two shapes are recovered here, and they are held apart from ordinary terms
 * because they are evidence of a different quality: a developer who types a path
 * has told you where they are working.
 *
 *   paths        `lib/utils.ts`, `src/scope/anchors.ts`, `./x/y.tsx`
 *   identifiers  `cn`, `handleSubmit`, `VendorForm` — a backticked or
 *                camel/Pascal-cased word, or anything followed by `()`
 *
 * A bare lowercase word is NOT an identifier. "extract the file" would otherwise
 * name a symbol called `file`, which is exactly the failure this fixes.
 */
export function namedTokens(prompt: string): { paths: string[]; identifiers: string[] } {
  const paths = new Set<string>();
  const identifiers = new Set<string>();

  // A path is anything with a slash and a source extension, or a bare filename
  // with one. `./` and `@/` prefixes are stripped so it can be compared to a
  // repo-relative path.
  for (const match of prompt.matchAll(/(?:^|[\s`'"(\[])((?:[\w.@/-]*\/)?[\w.-]+\.(?:tsx?|jsx?|prisma|json|css))/g)) {
    const raw = match[1]!.replace(/^\.\//, '').replace(/^@\//, '');
    paths.add(raw.toLowerCase());
  }

  // Backticked, or camel/PascalCase, or called with parentheses. Length 2 is
  // allowed on purpose — `cn` and `id` are real names, and dropping them is how
  // the subject of a refactor became invisible.
  for (const match of prompt.matchAll(/`([\w.$]{2,})`/g)) identifiers.add(match[1]!);
  for (const match of prompt.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\)/g)) identifiers.add(match[1]!);
  for (const match of prompt.matchAll(/\b([a-z$][\w$]*[A-Z][\w$]*|[A-Z][a-z$][\w$]*)\b/g)) {
    identifiers.add(match[1]!);
  }

  return { paths: [...paths], identifiers: [...identifiers] };
}
