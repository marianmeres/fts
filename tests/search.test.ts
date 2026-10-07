import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createFts, DEFAULT_TENANT_ID } from "../src/mod.ts";
import { withStore } from "./_fts.ts";

const T = DEFAULT_TENANT_ID;

Deno.test("prefix (default): typeahead matching, ranked", async () => {
	await withStore({ tableName: "fts_s1" }, async (fts) => {
		await fts.setMany(T, "s", [
			{ key: "a", fields: { title: "hello world" } },
			{ key: "b", fields: { body: "say hello out there" } },
			{ key: "c", fields: { title: "unrelated" } },
		]);

		// partial word — typeahead
		const r = await fts.search(T, "s", "hel");
		assertEquals(r.hits.map((h) => h.key).toSorted(), ["a", "b"]);
		assert(r.hits.every((h) => h.rank > 0));

		// full word matches too
		assertEquals((await fts.search(T, "s", "hello")).hits.length, 2);
		// no match
		assertEquals((await fts.search(T, "s", "zzz")).hits.length, 0);
	});
});

Deno.test("weights: title (A) outranks body (B); custom weights flip it", async () => {
	await withStore({ tableName: "fts_s2" }, async (fts) => {
		await fts.set(T, "s", "in-title", { fields: { title: "magic" } });
		await fts.set(T, "s", "in-body", { fields: { body: "magic" } });

		const def = await fts.search(T, "s", "magic");
		assertEquals(def.hits.map((h) => h.key), ["in-title", "in-body"]);
		assert(def.hits[0].rank > def.hits[1].rank);

		// {D, C, B, A}: boost B over A → body doc first
		const flipped = await fts.search(T, "s", "magic", {
			weights: [0.1, 0.2, 1.0, 0.05],
		});
		assertEquals(flipped.hits.map((h) => h.key), ["in-body", "in-title"]);
	});
});

Deno.test("exact mode: whole word only", async () => {
	await withStore({ tableName: "fts_s3" }, async (fts) => {
		await fts.set(T, "s", "k", { fields: { title: "hello world" } });
		assertEquals((await fts.search(T, "s", "hel", { mode: "exact" })).hits.length, 0);
		assertEquals(
			(await fts.search(T, "s", "hello", { mode: "exact" })).hits.length,
			1,
		);
	});
});

Deno.test("multi-word query is AND across words", async () => {
	await withStore({ tableName: "fts_s4" }, async (fts) => {
		await fts.setMany(T, "s", [
			{ key: "both", fields: { title: "red apple" } },
			{ key: "one", fields: { title: "red car" } },
		]);
		assertEquals(
			(await fts.search(T, "s", "red apple")).hits.map((h) => h.key),
			["both"],
		);
	});
});

Deno.test("normalizeWord expansion: OR within a group (colour|color)", async () => {
	await withStore(
		{
			tableName: "fts_s5",
			searchable: {
				normalizeWord: (w: string) => (w === "colour" ? ["colour", "color"] : w),
			},
		},
		async (fts) => {
			await fts.set(T, "s", "us", { fields: { title: "color scheme" } });
			// query "colour" expands to (colour|color) → matches the US spelling
			assertEquals(
				(await fts.search(T, "s", "colour")).hits.map((h) => h.key),
				["us"],
			);
		},
	);
});

Deno.test("write/query normalization parity: accents + case", async () => {
	await withStore({ tableName: "fts_s6" }, async (fts) => {
		await fts.set(T, "s", "k", { fields: { title: "Čerešňa v sade" } });
		assertEquals((await fts.search(T, "s", "ceresna")).hits.length, 1);
		assertEquals((await fts.search(T, "s", "ČEREŠŇA")).hits.length, 1);
		assertEquals((await fts.search(T, "s", "ceres")).hits.length, 1); // prefix
	});
});

Deno.test("empty / whitespace / all-stopword queries → empty result, never a dump", async () => {
	await withStore(
		{
			tableName: "fts_s7",
			searchable: { isStopword: (w: string) => w === "the" },
		},
		async (fts) => {
			await fts.set(T, "s", "k", { fields: { title: "something the cat" } });

			assertEquals(await fts.search(T, "s", ""), {
				hits: [],
				limit: 20,
				offset: 0,
			});
			assertEquals((await fts.search(T, "s", "   ")).hits, []);
			// normalizes to zero lexemes (stopword only) — must short-circuit
			assertEquals((await fts.search(T, "s", "the")).hits, []);
			assertEquals(
				await fts.search(T, "s", "the", { withTotal: true }),
				{ hits: [], total: 0, limit: 20, offset: 0 },
			);
		},
	);
});

Deno.test("tsquery operators in user input cannot inject", async () => {
	await withStore({ tableName: "fts_s8" }, async (fts) => {
		await fts.set(T, "s", "k", { fields: { title: "foo bar" } });
		// operators are stripped by tokenization; lexemes are quoted — no throw
		assertEquals((await fts.search(T, "s", "foo & !bar")).hits.length, 1);
		assertEquals((await fts.search(T, "s", "foo:* | (bar")).hits.length, 1);
		assertEquals((await fts.search(T, "s", "o'brien & foo")).hits.length, 0); // AND semantics: brien not present
		assertEquals((await fts.search(T, "s", "foo o'foo")).hits.length, 0);
	});
});

Deno.test("pagination: stable order, limit/offset, withTotal", async () => {
	await withStore({ tableName: "fts_s9" }, async (fts) => {
		await fts.setMany(
			T,
			"s",
			["a", "b", "c", "d", "e"].map((k) => ({
				key: k,
				fields: { title: "same text" },
			})),
		);

		const p1 = await fts.search(T, "s", "same", { limit: 2, withTotal: true });
		const p2 = await fts.search(T, "s", "same", {
			limit: 2,
			offset: 2,
			withTotal: true,
		});
		const p3 = await fts.search(T, "s", "same", { limit: 2, offset: 4 });

		assertEquals(p1.total, 5);
		assertEquals(p2.total, 5);
		assertEquals(p1.hits.length, 2);
		assertEquals(p2.hits.length, 2);
		assertEquals(p3.hits.length, 1);
		// equal rank → deterministic tiebreak; pages must not overlap
		const all = [...p1.hits, ...p2.hits, ...p3.hits].map((h) => h.key);
		assertEquals(new Set(all).size, 5);
	});
});

Deno.test("search is tenant- and scope-bound", async () => {
	await withStore({ tableName: "fts_s10" }, async (fts) => {
		await fts.set("ta", "s", "k", { fields: { title: "needle" } });
		await fts.set("tb", "s", "k", { fields: { title: "needle" } });
		await fts.set("ta", "other", "k2", { fields: { title: "needle" } });

		assertEquals((await fts.search("ta", "s", "needle")).hits.length, 1);
		assertEquals((await fts.search("tb", "s", "needle")).hits.length, 1);
		assertEquals((await fts.search("tc", "s", "needle")).hits.length, 0);
		assertEquals((await fts.search("ta", "other", "needle")).hits.length, 1);
	});
});

Deno.test("rankFn ts_rank is accepted; invalid knobs throw", async () => {
	await withStore({ tableName: "fts_s11" }, async (fts) => {
		await fts.set(T, "s", "k", { fields: { title: "hello" } });
		const r = await fts.search(T, "s", "hello", { rankFn: "ts_rank" });
		assertEquals(r.hits.length, 1);
		assert(r.hits[0].rank > 0);

		await assertRejects(
			// deno-lint-ignore no-explicit-any
			() => fts.search(T, "s", "x", { rankFn: "evil()" as any }),
			Error,
			"unknown rankFn",
		);
		await assertRejects(
			// deno-lint-ignore no-explicit-any
			() => fts.search(T, "s", "x", { mode: "nope" as any }),
			Error,
			"unknown search mode",
		);
		await assertRejects(
			// deno-lint-ignore no-explicit-any
			() => fts.search(T, "s", "x", { weights: [1, 2] as any }),
			Error,
			"weights",
		);
		// NaN is not a count: named here, not surfaced as a raw PostgreSQL 22P02
		for (const mode of ["prefix", "fuzzy"] as const) {
			await assertRejects(
				() => fts.search(T, "s", "hello", { mode, limit: NaN }),
				Error,
				"limit must be a number",
			);
			await assertRejects(
				() => fts.search(T, "s", "hello", { mode, offset: NaN }),
				Error,
				"offset must be a number",
			);
			// out-of-range values are clamped to what a bigint can hold, like negative
			// and fractional ones always were: Infinity = "no limit" / "past the end"
			const all = await fts.search(T, "s", "hello", { mode, limit: Infinity });
			assertEquals(all.hits.length, 1);
			assertEquals(all.limit, Number.MAX_SAFE_INTEGER);
			assertEquals(
				(await fts.search(T, "s", "hello", { mode, offset: Infinity })).hits,
				[],
			);
			assertEquals(
				(await fts.search(T, "s", "hello", { mode, limit: 1.9, offset: -3 })).hits
					.length,
				1,
			);
		}
	});
});

Deno.test("query budgets: an oversized query degrades to its leading terms", async () => {
	await withStore({ tableName: "fts_s13" }, async (fts) => {
		await fts.set(T, "s", "k", { fields: { title: "red apple pie" } });

		// 20k terms: unbounded, the prefix tsquery exceeded PostgreSQL's stack depth
		// (SQLSTATE 54001) and the fuzzy statement ran for minutes
		const head = "red apple";
		const huge = head + " " +
			Array.from({ length: 20_000 }, (_, i) => `w${i}`).join(" ");
		for (const mode of ["prefix", "exact", "fuzzy"] as const) {
			// default cap is 32 terms → still an AND that includes w0…, so no hit;
			// the point is that it answers, and promptly
			const started = performance.now();
			assertEquals((await fts.search(T, "s", huge, { mode })).hits, []);
			assert(performance.now() - started < 5_000, `${mode} took too long`);
		}
	});

	// terms beyond the cap are dropped, not rejected
	await withStore({ tableName: "fts_s14", maxQueryLexemes: 2 }, async (fts) => {
		await fts.set(T, "s", "k", { fields: { title: "red apple pie" } });
		for (const mode of ["prefix", "exact"] as const) {
			// "zzz" alone would defeat the AND
			assertEquals(
				(await fts.search(T, "s", "red apple zzz", { mode })).hits.length,
				1,
			);
			assertEquals((await fts.search(T, "s", "red zzz apple", { mode })).hits, []);
		}
		// fuzzy: "zzzzzzzz" would drag the similarity under a strict threshold
		assertEquals(
			(await fts.search(T, "s", "red apple zzzzzzzz", {
				mode: "fuzzy",
				trgmThreshold: 0.95,
			})).hits.length,
			1,
		);
	});
});

Deno.test("query budgets: maxQueryChars ends the query at the term that does not fit", async () => {
	await withStore({ tableName: "fts_s15", maxQueryChars: 10 }, async (fts) => {
		await fts.set(T, "s", "k", { fields: { title: "red apple pie" } });
		const long = "a".repeat(50);

		// "red" fits; the 50-char term does not → it and everything after are dropped
		assertEquals((await fts.search(T, "s", `red ${long} zzz`)).hits.length, 1);
		// nothing fits → zero terms → empty result (never an error, never a dump)
		for (const mode of ["prefix", "exact", "fuzzy"] as const) {
			assertEquals(
				await fts.search(T, "s", `${long} red`, { mode, withTotal: true }),
				{ hits: [], total: 0, limit: 20, offset: 0 },
			);
		}
	});
});

Deno.test("query budgets: validated; Infinity disables", () => {
	// deno-lint-ignore no-explicit-any
	const db = {} as any;
	for (const bad of [0, -1, NaN]) {
		assertThrows(
			() => createFts({ db, maxQueryLexemes: bad }),
			Error,
			"maxQueryLexemes",
		);
		assertThrows(() => createFts({ db, maxQueryChars: bad }), Error, "maxQueryChars");
	}
	const fts = createFts({ db, maxQueryLexemes: Infinity, maxQueryChars: Infinity });
	assertEquals(fts.config.maxQueryLexemes, Infinity);
	assertEquals(createFts({ db }).config.maxQueryLexemes, 32);
	assertEquals(createFts({ db }).config.maxQueryChars, 512);
});

Deno.test("backslash in a lexeme cannot break the tsquery quoting", async () => {
	// only reachable with `\\` whitelisted — then a term can END in a backslash, which
	// inside a quoted tsquery lexeme escaped the closing quote (a syntax error)
	await withStore(
		{ tableName: "fts_s16", searchable: { nonWordCharWhitelist: "@-\\" } },
		async (fts) => {
			await fts.set(T, "s", "k", { fields: { title: "see path\\to file" } });
			for (const mode of ["prefix", "exact"] as const) {
				assertEquals(
					(await fts.search(T, "s", "file\\", { mode })).hits.length,
					1,
				);
				assertEquals(
					(await fts.search(T, "s", "path\\to", { mode })).hits.length,
					1,
				);
				assertEquals((await fts.search(T, "s", "\\", { mode })).hits, []);
			}
		},
	);
});

Deno.test("hits carry the stored value", async () => {
	await withStore({ tableName: "fts_s12" }, async (fts) => {
		await fts.set(T, "s", "k", {
			fields: { title: "payload test" },
			value: { id: 7 },
		});
		const r = await fts.search(T, "s", "payload");
		assertEquals(r.hits[0].value, { id: 7 });
		assertEquals(r.hits[0].key, "k");
	});
});
