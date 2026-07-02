import { assert, assertEquals, assertRejects } from "@std/assert";
import { DEFAULT_TENANT_ID } from "../src/mod.ts";
import { withStore } from "./_fts.ts";

const T = DEFAULT_TENANT_ID;

/** Seed a small dotted-scope hierarchy (a convention — the store treats scopes as opaque). */
async function seedTree(fts: {
	set: (
		t: string,
		s: string,
		k: string,
		d: { fields: Record<string, string> },
	) => Promise<void>;
}) {
	await fts.set(T, "articles.news", "n1", { fields: { title: "quantum leap" } });
	await fts.set(T, "articles.news.tech", "t1", { fields: { title: "quantum chip" } });
	await fts.set(T, "articles.blog", "b1", { fields: { title: "quantum diary" } });
	await fts.set(T, "products", "p1", { fields: { title: "quantum vacuum cleaner" } });
}

Deno.test("multi-scope search: array is matched as scope = ANY(...)", async () => {
	await withStore({ tableName: "fts_h1" }, async (fts) => {
		await seedTree(fts);

		// "subtree" lookup = enumerate descendant scopes app-side
		const r = await fts.search(T, ["articles.news", "articles.news.tech"], "quantum");
		assertEquals(r.hits.map((h) => h.key).toSorted(), ["n1", "t1"]);

		// every hit reports which scope it came from
		assertEquals(
			r.hits.map((h) => h.scope).toSorted(),
			["articles.news", "articles.news.tech"],
		);

		// withTotal counts across all listed scopes
		const rt = await fts.search(T, ["articles.news", "articles.blog"], "quantum", {
			withTotal: true,
		});
		assertEquals(rt.total, 2);
	});
});

Deno.test("scopes are literal — no implicit hierarchy, no patterns", async () => {
	await withStore({ tableName: "fts_h2" }, async (fts) => {
		await seedTree(fts);

		// a parent scope does NOT match its dotted descendants
		assertEquals((await fts.search(T, "articles.news", "chip")).hits.length, 0);
		// pattern characters are just characters, never wildcards
		assertEquals((await fts.search(T, "articles.%", "quantum")).hits.length, 0);
		assertEquals((await fts.search(T, ["articles.*"], "quantum")).hits.length, 0);
	});
});

Deno.test("single-scope behavior unchanged; hits now include scope", async () => {
	await withStore({ tableName: "fts_h3" }, async (fts) => {
		await seedTree(fts);
		const r = await fts.search(T, "articles.blog", "quantum");
		assertEquals(r.hits.length, 1);
		assertEquals(r.hits[0].key, "b1");
		assertEquals(r.hits[0].scope, "articles.blog");
	});
});

Deno.test("multi-scope: tenant isolation still holds", async () => {
	await withStore({ tableName: "fts_h4" }, async (fts) => {
		await seedTree(fts);
		await fts.set("other", "articles.news", "x1", { fields: { title: "quantum" } });

		const r = await fts.search(T, ["articles.news", "articles.news.tech"], "quantum");
		assert(!r.hits.some((h) => h.key === "x1"));
	});
});

Deno.test("multi-scope: fuzzy mode", async () => {
	await withStore({ tableName: "fts_h5" }, async (fts) => {
		await seedTree(fts);
		// typo — quantun (explicit threshold: "quantun"→"quantum" sits near 0.6)
		const r = await fts.search(T, ["articles.news", "articles.blog"], "quantun", {
			mode: "fuzzy",
			withTotal: true,
			trgmThreshold: 0.5,
		});
		assertEquals(r.hits.map((h) => h.key).toSorted(), ["b1", "n1"]);
		assertEquals(r.total, 2);
		assertEquals(r.hits.map((h) => h.scope).toSorted(), [
			"articles.blog",
			"articles.news",
		]);
	});
});

Deno.test("count accepts a scope array; duplicate entries are harmless", async () => {
	await withStore({ tableName: "fts_h6" }, async (fts) => {
		await seedTree(fts);
		assertEquals(await fts.count(T, ["articles.news", "articles.news.tech"]), 2);
		// (#resolveScopes dedupes app-side, but `= ANY` is a membership predicate —
		// duplicates could never inflate the count anyway)
		assertEquals(await fts.count(T, ["articles.news", "articles.news"]), 1);
		assertEquals(await fts.count(T), 4);
	});
});

Deno.test("same key in sibling scopes: rank ties break by scope (stable order)", async () => {
	await withStore({ tableName: "fts_h7" }, async (fts, db) => {
		// identical content in sibling scopes → identical rank; seed b BEFORE a so a
		// later `updated_at` would order them a-first anyway — pin updated_at to force
		// the tie down to the scope tiebreak
		await fts.set(T, "cat.b", "k", { fields: { title: "same words" } });
		await fts.set(T, "cat.a", "k", { fields: { title: "same words" } });
		await db.query(`UPDATE fts_h7 SET updated_at = '2026-01-01T00:00:00Z'`);

		const r = await fts.search(T, ["cat.b", "cat.a"], "same");
		assertEquals(r.hits.length, 2);
		// both hits share the key — scope disambiguates and orders the tie
		assertEquals(r.hits.map((h) => `${h.scope}/${h.key}`), ["cat.a/k", "cat.b/k"]);
	});
});

Deno.test("scope argument validation", async () => {
	await withStore({ tableName: "fts_h8" }, async (fts) => {
		await assertRejects(() => fts.search(T, [], "x"), Error, "at least one scope");
		await assertRejects(() => fts.search(T, ["ok", ""], "x"), Error, "non-empty");
		await assertRejects(() => fts.count(T, []), Error, "at least one scope");
	});
});
