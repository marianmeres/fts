import { assert, assertEquals, assertRejects } from "@std/assert";
import { DEFAULT_TENANT_ID } from "../src/mod.ts";
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
	});
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
