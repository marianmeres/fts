import { assert, assertEquals, assertRejects } from "@std/assert";
import { DEFAULT_TENANT_ID } from "../src/mod.ts";
import { withStore } from "./_fts.ts";

const T = DEFAULT_TENANT_ID;

const LONG_BODY = "introductory chapter about lorem ipsum dolor sit amet " +
	"consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore";

Deno.test("fuzzy: short query hits a long body containing the word", async () => {
	await withStore({ tableName: "fts_f1" }, async (fts) => {
		await fts.set(T, "s", "doc", { fields: { body: LONG_BODY } });
		await fts.set(T, "s", "other", { fields: { body: "completely different" } });

		// word-similarity scores against the best window, not the whole field —
		// the old whole-string % design would score ~0.06 here and miss
		const r = await fts.search(T, "s", "lorem", { mode: "fuzzy" });
		assertEquals(r.hits.map((h) => h.key), ["doc"]);
		assertEquals(r.hits[0].rank, 1); // exact word present → 1.0
	});
});

Deno.test("fuzzy: typo tolerance, per-query threshold actually applies", async () => {
	await withStore({ tableName: "fts_f2" }, async (fts) => {
		await fts.set(T, "s", "doc", { fields: { body: LONG_BODY } });

		// typo — permissive threshold matches
		const loose = await fts.search(T, "s", "lorm", {
			mode: "fuzzy",
			trgmThreshold: 0.4,
		});
		assertEquals(loose.hits.map((h) => h.key), ["doc"]);
		assert(loose.hits[0].rank >= 0.4 && loose.hits[0].rank < 1);

		// same typo — strict threshold rejects (proves set_config path works;
		// with the GUC default this would behave identically for both calls)
		const strict = await fts.search(T, "s", "lorm", {
			mode: "fuzzy",
			trgmThreshold: 0.95,
		});
		assertEquals(strict.hits, []);
	});
});

Deno.test("fuzzy: query is normalized with the same searchable brain", async () => {
	await withStore({ tableName: "fts_f3" }, async (fts) => {
		await fts.set(T, "s", "k", { fields: { title: "Čerešňa v sade" } });
		// accents/case folded on BOTH sides (content + query)
		const r = await fts.search(T, "s", "ČEREŠŇA", { mode: "fuzzy" });
		assertEquals(r.hits.map((h) => h.key), ["k"]);
	});
});

Deno.test("fuzzy: tenant- and scope-bound; withTotal; pagination shape", async () => {
	await withStore({ tableName: "fts_f4" }, async (fts) => {
		await fts.set("ta", "s", "k", { fields: { body: LONG_BODY } });
		await fts.set("tb", "s", "k", { fields: { body: LONG_BODY } });

		const r = await fts.search("ta", "s", "lorem", {
			mode: "fuzzy",
			withTotal: true,
			limit: 10,
		});
		assertEquals(r.hits.length, 1);
		assertEquals(r.total, 1);
		assertEquals(r.limit, 10);
		assertEquals((await fts.search("tc", "s", "lorem", { mode: "fuzzy" })).hits, []);
	});
});

Deno.test("fuzzy: empty/zero-lexeme query → empty result", async () => {
	await withStore({ tableName: "fts_f5" }, async (fts) => {
		await fts.set(T, "s", "k", { fields: { title: "anything" } });
		assertEquals((await fts.search(T, "s", "", { mode: "fuzzy" })).hits, []);
		assertEquals((await fts.search(T, "s", "   ", { mode: "fuzzy" })).hits, []);
	});
});

Deno.test("fuzzy: disabled store rejects; bad threshold rejects", async () => {
	await withStore({ tableName: "fts_f6", fuzzy: false }, async (fts) => {
		await fts.set(T, "s", "k", { fields: { title: "x" } });
		await assertRejects(
			() => fts.search(T, "s", "x", { mode: "fuzzy" }),
			Error,
			"fuzzy mode is disabled",
		);
	});
	await withStore({ tableName: "fts_f7" }, async (fts) => {
		await assertRejects(
			() => fts.search(T, "s", "x", { mode: "fuzzy", trgmThreshold: 2 }),
			Error,
			"trgmThreshold",
		);
	});
});
