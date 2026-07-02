import { assertEquals, assertRejects } from "@std/assert";
import { DEFAULT_TENANT_ID } from "../src/mod.ts";
import { withStore } from "./_fts.ts";

const T = DEFAULT_TENANT_ID;

// Multi-language stores: one generated tsv_<lang> column per configured language,
// rows carry their own `lang`, search binds the whitelisted column.

const MULTI = {
	tableName: "fts_l1",
	languages: { en: "english", sk: "simple" },
	defaultLang: "sk" as const,
};

Deno.test("per-language rows: search(lang) only sees that language's rows", async () => {
	await withStore(MULTI, async (fts) => {
		await fts.set(T, "s", "en1", {
			fields: { title: "running fast" },
			lang: "en",
		});
		await fts.set(T, "s", "sk1", {
			fields: { title: "bežiaci rýchlo" },
			lang: "sk",
		});

		// sk (simple) — prefix is fine
		assertEquals(
			(await fts.search(T, "s", "bezi", { lang: "sk" })).hits.map((h) => h.key),
			["sk1"],
		);
		// the en row is NOT in tsv_sk (CASE guard) — no cross-language bleed
		assertEquals(
			(await fts.search(T, "s", "running", { lang: "sk" })).hits,
			[],
		);
		// en (stemmed) — exact mode; stemming matches inflections both ways
		assertEquals(
			(await fts.search(T, "s", "runs", { lang: "en", mode: "exact" })).hits.map((
				h,
			) => h.key),
			["en1"],
		);
	});
});

Deno.test("§4.1 guard: prefix mode on a stemmed language is rejected", async () => {
	await withStore(MULTI, async (fts) => {
		await fts.set(T, "s", "en1", { fields: { title: "universities" }, lang: "en" });

		await assertRejects(
			() => fts.search(T, "s", "universit", { lang: "en" }), // prefix default
			Error,
			'mode "prefix" is not supported on stemmed language',
		);
		// exact on the stemmed column DOES work (stem match)
		assertEquals(
			(await fts.search(T, "s", "universities", { lang: "en", mode: "exact" }))
				.hits.length,
			1,
		);
		// and the same partial prefix on a simple-config store would have matched —
		// that asymmetry is exactly why the guard exists (documented, not silent)
	});
});

Deno.test("default lang is used when omitted; unknown lang throws", async () => {
	await withStore(MULTI, async (fts) => {
		await fts.set(T, "s", "k", { fields: { title: "domov" } }); // defaults to sk
		assertEquals((await fts.search(T, "s", "domov")).hits.length, 1);

		await assertRejects(
			() => fts.search(T, "s", "x", { lang: "de" }),
			Error,
			'unknown lang "de"',
		);
	});
});

Deno.test("compound tokens (§4.2): PG re-splits '@-' whitelisted compounds", async () => {
	await withStore({ tableName: "fts_l2" }, async (fts) => {
		await fts.set(T, "s", "k1", { fields: { title: "well-known term" } });
		await fts.set(T, "s", "k2", { fields: { title: "mail user@example.com" } });

		// whole compound and leading sub-token match (agrees with searchable)
		assertEquals((await fts.search(T, "s", "well-known")).hits.length, 1);
		assertEquals((await fts.search(T, "s", "well")).hits.length, 1);
		// interior sub-token ALSO matches in fts (PG splits the compound) —
		// more permissive than standalone searchable; documented behavior
		assertEquals((await fts.search(T, "s", "known")).hits.length, 1);
		assertEquals((await fts.search(T, "s", "example")).hits.length, 1);
	});
});
