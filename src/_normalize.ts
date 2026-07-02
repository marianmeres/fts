/**
 * @module
 *
 * Normalization bridge to `@marianmeres/searchable` — THE parity invariant. One
 * `Searchable` instance per store is used at BOTH write time (here) and query time
 * (`_tsquery.ts`), so the lexemes PostgreSQL sees agree on both sides.
 */

import { Searchable, type SearchableOptions } from "@marianmeres/searchable";
import type { ResolvedFtsConfig } from "./types.ts";

/** Accept a ready instance or options; always end up with one `Searchable`. */
export function resolveSearchable(
	input?: Searchable | Partial<SearchableOptions>,
): Searchable {
	if (input instanceof Searchable) return input;
	return new Searchable(input ?? {});
}

/** Result of normalizing one document's fields. */
export interface NormalizedDoc {
	/** field → space-joined normalized tokens (the generated tsvector's source). */
	content: Record<string, string>;
	/** True when any budget kicked in. */
	truncated: boolean;
}

/**
 * Normalize raw field text into the indexable `content` document.
 *
 * - Only fields configured in `cfg.fields` are indexed; anything else is ignored here
 *   (the caller preserves the full payload in `value`).
 * - `searchable.toWords(raw, false)` tokenizes, folds case/accents, drops stopwords and
 *   de-duplicates — so the per-field token count IS the distinct-lexeme count, which is
 *   what actually drives tsvector byte size.
 * - `budgetScale` (0 < scale <= 1) proportionally shrinks both budgets; the oversize
 *   retry path halves it until the row fits under the tsvector byte cap.
 */
export function normalizeDoc(
	searchable: Searchable,
	cfg: ResolvedFtsConfig,
	fields: Record<string, string>,
	budgetScale = 1,
): NormalizedDoc {
	const maxLexemes = Math.max(1, Math.floor(cfg.maxIndexedLexemes * budgetScale));
	let remainingChars = Math.max(1, Math.floor(cfg.maxIndexedChars * budgetScale));
	const content: Record<string, string> = {};
	let truncated = false;

	for (const field of Object.keys(cfg.fields)) {
		const raw = fields?.[field];
		if (raw == null) continue;

		let words = searchable.toWords(String(raw), false);
		if (words.length > maxLexemes) {
			words = words.slice(0, maxLexemes);
			truncated = true;
		}

		let text = words.join(" ");
		if (text.length > remainingChars) {
			text = text.slice(0, remainingChars);
			// avoid a cut-in-half trailing token
			const lastSpace = text.lastIndexOf(" ");
			if (lastSpace > 0) text = text.slice(0, lastSpace);
			truncated = true;
		}

		content[field] = text;
		remainingChars = Math.max(1, remainingChars - text.length);
	}

	return { content, truncated };
}

/** Is this the PostgreSQL "string is too long for tsvector" write-time error? */
// deno-lint-ignore no-explicit-any
export function isTsvectorOversize(err: any): boolean {
	return err?.code === "54000" ||
		/string is too long for tsvector/i.test(err?.message ?? "");
}
