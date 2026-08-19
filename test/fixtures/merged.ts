/**
 * Declaration merging — the pattern that made a whole repository un-indexable.
 *
 * TypeScript merges same-named declarations in a file into ONE type. Emitting a
 * node per declaration produced two nodes with the same id and different lines,
 * and the graph engine rejects that write entirely — not the row, the whole
 * statement. One occurrence of this in a 1,396-file project meant no graph at all.
 *
 * Everything here is legal, idiomatic TypeScript.
 */

/** First declaration: carries a member, and is where the type is reported to live. */
export interface MergedOptions {
	retries?: number;
}

/** A shape the second declaration extends, so the merge is not trivially empty. */
export interface BaseOptions {
	timeout: number;
}

/** Second declaration of the SAME interface. This is the merge. */
export interface MergedOptions extends BaseOptions {}

/**
 * Merged where only the LATER declaration is exported.
 *
 * `exported` must end up true — the type is on the public surface even though
 * the first declaration did not say so.
 */
interface LateExport {
	a: string;
}

export interface LateExport {
	b: string;
}

/** A namespace merged with a function of the same name — the other common form. */
export function mergedFn(): number {
	return 1;
}

/** Uses the merged type, so a reference edge has somewhere to land. */
export function usesMerged(options: MergedOptions): number {
	return options.retries ?? 0;
}

/**
 * Written inside nothing unusual, but annotated with the type declared by the
 * SECOND declaration's shape — attribution must survive the merge.
 */
export function usesBase(options: BaseOptions): number {
	return options.timeout;
}
