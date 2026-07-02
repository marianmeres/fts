/**
 * Compound-token parity semantics (see API.md → "Normalization parity").
 *
 * Two tokenizers run on both the write and the query side: searchable first, then
 * PostgreSQL's text-search parser (which re-parses even quoted tsquery lexemes —
 * quoting stops operator injection, not re-tokenization). Two kinds of tests here:
 *
 * - ROUND-TRIP GUARANTEES — searching the same compound token a document was written
 *   with must always find it. These are the tripwire for one-sided normalization
 *   changes, `quoteLexeme` changes, or a PG parser shift on upgrade.
 * - CHARACTERIZATION — the false-positive/permissive edges that the two-tokenizer
 *   chain implies are pinned as documented behavior, so a change in either direction
 *   surfaces here instead of in production search results.
 *
 * Parser facts asserted below were observed live on PostgreSQL 18.3:
 * `pump_carb` → adjacent lexemes `pump`,`carb` (parts only);
 * `well-known` → `well-known`,`well`,`known` (compound AND parts);
 * `'pump_carb':*` → `'pump':* <-> 'carb':*` (`:*` on every fragment);
 * `6'` → bare lexeme `6`.
 */

import { assert, assertEquals } from "@std/assert";
import { DEFAULT_TENANT_ID } from "../src/mod.ts";
import { withStore } from "./_fts.ts";

const T = DEFAULT_TENANT_ID;

Deno.test("round-trip: underscore compound (default config)", async () => {
	await withStore({ tableName: "fts_pc1" }, async (fts) => {
		await fts.set(T, "s", "k", { fields: { title: "pump_carb rebuild kit" } });

		assertEquals(
			(await fts.search(T, "s", "pump_carb", { mode: "exact" })).hits.length,
			1,
		);
		assertEquals((await fts.search(T, "s", "pump_carb")).hits.length, 1); // prefix
	});
});

Deno.test("round-trip: hyphen compound; sub-part matches, separate words do NOT", async () => {
	await withStore({ tableName: "fts_pc2" }, async (fts) => {
		await fts.setMany(T, "s", [
			{ key: "compound", fields: { title: "a well-known fact" } },
			// the same two words, adjacent but NOT hyphenated
			{ key: "loose", fields: { title: "well known words" } },
		]);

		// PG stores the compound AND its parts ('well-known','well','known') — so a
		// sub-part query matches (standalone searchable would not match "known"
		// against the token "well-known")
		assertEquals(
			(await fts.search(T, "s", "known", { mode: "exact" })).hits.length,
			2,
		);
		// …but the query side keeps the compound lexeme too, so — unlike underscore
		// compounds below — `well-known` does NOT match separate adjacent words
		for (const mode of ["exact", "prefix"] as const) {
			assertEquals(
				(await fts.search(T, "s", "well-known", { mode })).hits.map((h) => h.key),
				["compound"],
			);
		}
	});
});

Deno.test("round-trip: email-ish token with the default '@-' whitelist", async () => {
	await withStore({ tableName: "fts_pc3" }, async (fts) => {
		await fts.set(T, "s", "k", {
			fields: { body: "contact user@example.com anytime" },
		});

		// searchable splits on '.' → "user@example" + "com" on BOTH sides
		assertEquals(
			(await fts.search(T, "s", "user@example.com", { mode: "exact" })).hits.length,
			1,
		);
		assertEquals((await fts.search(T, "s", "user@ex")).hits.length, 1); // prefix
	});
});

Deno.test("characterization: underscore compound query false-positives on adjacent separate words", async () => {
	await withStore({ tableName: "fts_pc4" }, async (fts) => {
		await fts.setMany(T, "s", [
			// no "wire_harness" compound anywhere — just the two words, adjacent…
			{ key: "adjacent", fields: { title: "wire harness kit" } },
			// …and NOT adjacent
			{ key: "apart", fields: { title: "wire mesh harness" } },
		]);

		// `wire_harness` → phrase 'wire' <-> 'harness' → adjacency decides, in the
		// deduped/stopword-stripped indexed token list (not the original prose)
		for (const mode of ["exact", "prefix"] as const) {
			assertEquals(
				(await fts.search(T, "s", "wire_harness", { mode })).hits.map((h) =>
					h.key
				),
				["adjacent"],
			);
		}
	});
});

Deno.test("characterization: prefix on a partial compound conflates; exact keeps apart", async () => {
	await withStore({ tableName: "fts_pc5" }, async (fts) => {
		await fts.setMany(T, "s", [
			{ key: "compound", fields: { title: "pump_carb rebuild" } },
			{ key: "words", fields: { title: "pump cable spare" } },
		]);

		// 'pump_ca':* → 'pump':* <-> 'ca':* → matches BOTH docs
		assertEquals(
			(await fts.search(T, "s", "pump_ca")).hits.map((h) => h.key).toSorted(),
			["compound", "words"],
		);
		// exact phrase 'pump' <-> 'carb' → compound doc only
		assertEquals(
			(await fts.search(T, "s", "pump_carb", { mode: "exact" })).hits.map((h) =>
				h.key
			),
			["compound"],
		);
	});
});

Deno.test("apostrophe whitelisted: round-trip works, but prefix needles collapse", async () => {
	await withStore(
		{ tableName: "fts_pc6", searchable: { nonWordCharWhitelist: "@-'" } },
		async (fts) => {
			await fts.setMany(T, "s", [
				{ key: "name", fields: { title: "o'brien dossier" } },
				{ key: "part", fields: { title: "bearing 6001 spare" } },
			]);

			// round-trip guarantee
			assertEquals(
				(await fts.search(T, "s", "o'brien", { mode: "exact" })).hits.map((h) =>
					h.key
				),
				["name"],
			);
			assertEquals(
				(await fts.search(T, "s", "o'brien")).hits.map((h) => h.key),
				["name"],
			);

			// the sharp edge: `6'` collapses to bare lexeme `6` → prefix matches EVERY
			// token starting with 6 (why `'` should not be whitelisted lightly)
			assertEquals(
				(await fts.search(T, "s", "6'")).hits.map((h) => h.key),
				["part"],
			);
			// …while exact `6'` = lexeme `6`, which is not present as a whole word
			assertEquals(
				(await fts.search(T, "s", "6'", { mode: "exact" })).hits.length,
				0,
			);
		},
	);
});

Deno.test("decimals: default whitelist is order-insensitive AND; '.' whitelisted is strict", async () => {
	const DOCS = [
		{ key: "price", fields: { title: "price 139.00 eur" } },
		// both parts present, reordered and non-adjacent
		{ key: "noise", fields: { title: "get 00 units for 139 eur" } },
	];

	// default whitelist: searchable (not PG) splits "139.00" app-side into TWO query
	// groups → `'139' & '00'` — a bag-of-words AND with no adjacency requirement
	await withStore({ tableName: "fts_pc7" }, async (fts) => {
		await fts.setMany(T, "s", DOCS);
		assertEquals(
			(await fts.search(T, "s", "139.00", { mode: "exact" })).hits
				.map((h) => h.key).toSorted(),
			["noise", "price"],
		);
	});

	// '.' whitelisted: searchable keeps "139.00" whole and PG keeps decimal-shaped
	// tokens whole too → ONE strict lexeme, plus decimal prefix typeahead
	await withStore(
		{ tableName: "fts_pc8", searchable: { nonWordCharWhitelist: "@-." } },
		async (fts) => {
			await fts.setMany(T, "s", DOCS);
			assertEquals(
				(await fts.search(T, "s", "139.00", { mode: "exact" })).hits.map((h) =>
					h.key
				),
				["price"],
			);
			assertEquals(
				(await fts.search(T, "s", "139.0")).hits.map((h) => h.key), // prefix
				["price"],
			);
		},
	);
});

Deno.test("compound hits rank > 0 (phrase matches still carry a usable rank)", async () => {
	await withStore({ tableName: "fts_pc9" }, async (fts) => {
		await fts.set(T, "s", "k", { fields: { title: "pump_carb rebuild" } });
		const r = await fts.search(T, "s", "pump_carb", { mode: "exact" });
		assert(r.hits[0].rank > 0);
	});
});
