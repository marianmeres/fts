// deno-lint-ignore-file no-explicit-any

import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { createFts, DEFAULT_TENANT_ID, Fts } from "../src/mod.ts";
import { makeFts, withStore } from "./_fts.ts";

const T = DEFAULT_TENANT_ID;

// ---------------------------------------------------------------------------
// Smoke (no DB)
// ---------------------------------------------------------------------------

Deno.test("module exports the public surface", () => {
	assert(typeof createFts === "function");
	assert(typeof Fts === "function");
	assertEquals(DEFAULT_TENANT_ID, "_default");
});

Deno.test("createFts resolves and freezes config", () => {
	const fts = createFts({ db: {} as any });
	assertEquals(fts.config.tableName, "__fts");
	assertEquals(fts.config.defaultLang, "default");
	assertEquals(fts.config.languages, { default: "simple" });
	assertEquals(fts.config.fields, { title: "A", body: "B", tags: "C" });
	assertEquals(fts.initialized, false);
	assertEquals(Object.isFrozen(fts.config), true);
});

Deno.test("operations before initialize() throw", async () => {
	const fts = makeFts({} as any);
	await assertRejects(
		() => fts.set(T, "s", "k", { fields: { title: "x" } }),
		Error,
		"not initialized",
	);
	await assertRejects(() => fts.get(T, "s", "k"), Error, "not initialized");
	await assertRejects(() => fts.deleteScope(T, "s"), Error, "not initialized");
});

// ---------------------------------------------------------------------------
// CRUD (real Postgres)
// ---------------------------------------------------------------------------

Deno.test("set/get roundtrip: value defaults to fields; explicit value wins", async () => {
	await withStore({ tableName: "fts_crud" }, async (fts) => {
		await fts.set(T, "s", "k1", { fields: { title: "Hello World" } });
		assertEquals(await fts.get(T, "s", "k1"), { title: "Hello World" });

		await fts.set(T, "s", "k2", {
			fields: { title: "Hello" },
			value: { id: 42, custom: true },
		});
		assertEquals(await fts.get(T, "s", "k2"), { id: 42, custom: true });

		assertEquals(await fts.get(T, "s", "missing"), null);
	});
});

Deno.test("upsert replaces content+value, bumps updated_at, keeps created_at", async () => {
	await withStore({ tableName: "fts_ups" }, async (fts, db) => {
		await fts.set(T, "s", "k", { fields: { title: "first" } });
		const before = (await db.query(
			`SELECT created_at, updated_at FROM fts_ups WHERE key = 'k'`,
		)).rows[0];

		await fts.set(T, "s", "k", { fields: { title: "second" }, value: { v: 2 } });
		const after = (await db.query(
			`SELECT created_at, updated_at, content->>'title' AS title FROM fts_ups
			 WHERE key = 'k'`,
		)).rows[0];

		assertEquals(await fts.get(T, "s", "k"), { v: 2 });
		assertEquals(after.title, "second");
		assertEquals(after.created_at.getTime(), before.created_at.getTime());
		assert(after.updated_at.getTime() > before.updated_at.getTime());
	});
});

Deno.test("delete: true when removed, false when absent", async () => {
	await withStore({ tableName: "fts_del" }, async (fts) => {
		await fts.set(T, "s", "k", { fields: { title: "x" } });
		assertEquals(await fts.delete(T, "s", "k"), true);
		assertEquals(await fts.delete(T, "s", "k"), false);
		assertEquals(await fts.get(T, "s", "k"), null);
	});
});

Deno.test("setMany + count; duplicate keys are last-wins", async () => {
	await withStore({ tableName: "fts_many" }, async (fts) => {
		await fts.setMany(T, "s", [
			{ key: "a", fields: { title: "alpha" } },
			{ key: "b", fields: { title: "beta" } },
			{ key: "a", fields: { title: "alpha2" }, value: { last: true } },
		]);
		assertEquals(await fts.count(T, "s"), 2);
		assertEquals(await fts.get(T, "s", "a"), { last: true });

		await fts.setMany(T, "s2", [{ key: "c", fields: { title: "gamma" } }]);
		assertEquals(await fts.count(T), 3);
		assertEquals(await fts.count(T, "s2"), 1);

		await fts.setMany(T, "s", []); // no-op
		assertEquals(await fts.count(T), 3);
	});
});

Deno.test("deleteMany returns the actually-deleted count", async () => {
	await withStore({ tableName: "fts_delm" }, async (fts) => {
		await fts.setMany(T, "s", [
			{ key: "a", fields: { title: "a" } },
			{ key: "b", fields: { title: "b" } },
			{ key: "c", fields: { title: "c" } },
		]);
		assertEquals(await fts.deleteMany(T, "s", ["a", "b", "nope"]), 2);
		assertEquals(await fts.deleteMany(T, "s", []), 0);
		assertEquals(await fts.count(T, "s"), 1);
	});
});

Deno.test("unknown lang throws (whitelist)", async () => {
	await withStore({ tableName: "fts_lng" }, async (fts) => {
		await assertRejects(
			() => fts.set(T, "s", "k", { fields: { title: "x" }, lang: "xx" }),
			Error,
			'unknown lang "xx"',
		);
	});
});

Deno.test("content is searchable-normalized (folded, lowercased, deduped)", async () => {
	await withStore({ tableName: "fts_norm" }, async (fts, db) => {
		await fts.set(T, "s", "k", { fields: { title: "Čerešňa ČEREŠŇA Strom" } });
		const { rows } = await db.query(
			`SELECT content->>'title' AS title FROM fts_norm WHERE key = 'k'`,
		);
		assertEquals(rows[0].title, "ceresna strom");
		// full raw value preserved regardless of normalization
		assertEquals(await fts.get(T, "s", "k"), { title: "Čerešňa ČEREŠŇA Strom" });
	});
});

Deno.test("unconfigured fields are not indexed but survive in value", async () => {
	await withStore({ tableName: "fts_unk" }, async (fts, db) => {
		await fts.set(T, "s", "k", {
			fields: { title: "hello", internal: "should not be indexed" },
		});
		const { rows } = await db.query(
			`SELECT content FROM fts_unk WHERE key = 'k'`,
		);
		assertFalse("internal" in rows[0].content);
		assertEquals(
			await fts.get(T, "s", "k"),
			{ title: "hello", internal: "should not be indexed" },
		);
	});
});

// ---------------------------------------------------------------------------
// Truncation / tsvector byte-cap safety net
// ---------------------------------------------------------------------------

Deno.test("maxIndexedLexemes truncates indexed text, keeps full value", async () => {
	await withStore(
		{ tableName: "fts_trunc", maxIndexedLexemes: 3 },
		async (fts, db) => {
			const raw = "one two three four five six";
			await fts.set(T, "s", "k", { fields: { title: raw } });
			const { rows } = await db.query(
				`SELECT content->>'title' AS title FROM fts_trunc WHERE key = 'k'`,
			);
			assertEquals(rows[0].title, "one two three");
			assertEquals(await fts.get(T, "s", "k"), { title: raw });
		},
	);
});

/** ~150k distinct short tokens — well over the ~1MB tsvector byte cap (PG18-verified
 * shape: byte size is driven by distinct-lexeme count, not char count). */
function oversizedText(): string {
	return Array.from({ length: 150_000 }, (_, i) => `t${i}`).join(" ");
}
const HUGE_BUDGETS = { maxIndexedLexemes: 1_000_000, maxIndexedChars: 10_000_000 };

Deno.test("onOversize:truncate — 54000 triggers halve-and-retry until it fits", async () => {
	await withStore(
		{ tableName: "fts_ovt", ...HUGE_BUDGETS },
		async (fts, db) => {
			await fts.set(T, "s", "big", {
				fields: { body: oversizedText() },
				value: { big: true },
			});
			const { rows } = await db.query(
				`SELECT length(content->>'body') AS len,
				        (tsv_default <> ''::tsvector) AS indexed
				 FROM fts_ovt WHERE key = 'big'`,
			);
			assert(rows[0].indexed, "row should still be indexed after re-truncation");
			assert(rows[0].len > 0, "content should not be empty");
			assertEquals(await fts.get(T, "s", "big"), { big: true });
		},
	);
});

Deno.test("onOversize:throw — surfaces a clear error", async () => {
	await withStore(
		{ tableName: "fts_ovx", ...HUGE_BUDGETS, onOversize: "throw" },
		async (fts) => {
			await assertRejects(
				() => fts.set(T, "s", "big", { fields: { body: oversizedText() } }),
				Error,
				"tsvector byte cap",
			);
		},
	);
});

Deno.test("setMany: one oversized entry cannot drop the batch (per-row fallback)", async () => {
	await withStore(
		{ tableName: "fts_ovm", ...HUGE_BUDGETS },
		async (fts) => {
			await fts.setMany(T, "s", [
				{ key: "a", fields: { title: "small one" } },
				{ key: "big", fields: { body: oversizedText() }, value: { big: true } },
				{ key: "b", fields: { title: "small two" } },
			]);
			assertEquals(await fts.count(T, "s"), 3);
			assertEquals(await fts.get(T, "s", "a"), { title: "small one" });
			assertEquals(await fts.get(T, "s", "big"), { big: true });
			assertEquals(await fts.get(T, "s", "b"), { title: "small two" });
		},
	);
});
