/**
 * @module
 *
 * Safe tsquery construction from `searchable.toQueryGroups` output.
 *
 * Semantics: OR within a group, AND across groups —
 * `[["big"], ["colour","color"], ["test"]]` (prefix) becomes
 * `'big':* & ('colour':* | 'color':*) & 'test':*`.
 *
 * Every lexeme is single-quoted (with `'` doubled), so user input can never inject
 * tsquery operators; the assembled string is then BOUND as a parameter to
 * `to_tsquery($cfg::regconfig, $qtext)` — no hand-rolled SQL escaping surface.
 */

/** Quote one lexeme for use inside a tsquery string. */
function quoteLexeme(word: string, suffix: string): string {
	return `'${word.replaceAll("'", "''")}'${suffix}`;
}

/**
 * Build the tsquery text from query groups. Returns `null` when the groups contain
 * no usable lexemes — the caller MUST short-circuit then (`to_tsquery('')` throws).
 */
export function buildTsquery(
	groups: string[][],
	mode: "prefix" | "exact",
): string | null {
	if (!groups?.length) return null;
	const suffix = mode === "prefix" ? ":*" : "";

	const parts: string[] = [];
	for (const group of groups) {
		const alts = (group ?? [])
			.filter((w) => typeof w === "string" && w.length)
			.map((w) => quoteLexeme(w, suffix));
		if (!alts.length) continue;
		parts.push(alts.length === 1 ? alts[0] : `(${alts.join(" | ")})`);
	}

	return parts.length ? parts.join(" & ") : null;
}
