/**
 * `db` as a `pg.Client` — ONE connection the caller owns, and the way an app joins the
 * store to its own transaction.
 *
 * The contract pinned here: the store never commits or rolls back a transaction it did
 * not open. It used to wrap its multi-statement units in a bare `BEGIN`/`COMMIT`;
 * inside an open transaction PostgreSQL downgrades that `BEGIN` to a warning and the
 * `COMMIT` then commits the CALLER's pending work — even from a fuzzy `search()`, a
 * read. The store now detects an open transaction and nests with savepoints.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { DEFAULT_TENANT_ID } from "../src/mod.ts";
import {
	createPg,
	HUGE_BUDGETS,
	makeFts,
	oversizedText,
	withClientStore,
} from "./_fts.ts";

const T = DEFAULT_TENANT_ID;
const GUC = "pg_trgm.word_similarity_threshold";
const BODY = "introductory chapter about lorem ipsum dolor sit amet";

// deno-lint-ignore no-explicit-any
async function showThreshold(client: any): Promise<string | null> {
	const { rows } = await client.query(`SELECT current_setting('${GUC}', true) AS v`);
	return rows[0].v;
}

Deno.test("caller transaction: a fuzzy search never commits it", async () => {
	await withClientStore({ tableName: "fts_c1" }, async ({ fts, clientFts, client }) => {
		await fts.set(T, "s", "k", { fields: { body: BODY } });

		// default threshold (nothing to set) and a custom one (set + restore)
		for (const trgmThreshold of [undefined, 0.4]) {
			await client.query("BEGIN");
			await clientFts.set(T, "s", "pending", { fields: { title: "uncommitted" } });
			const r = await clientFts.search(T, "s", "lorem", {
				mode: "fuzzy",
				trgmThreshold,
				withTotal: true,
			});
			assertEquals(r.hits.map((h) => h.key), ["k"]);
			assertEquals(r.total, 1);
			await client.query("ROLLBACK");

			// the caller rolled back — had the search committed, the row would exist
			assertEquals(await fts.get(T, "s", "pending"), null);
		}
	});
});

Deno.test("caller transaction: initialize() and destroy(true) join it", async () => {
	await withClientStore(
		{ tableName: "fts_c2" },
		async ({ fts, clientFts, client, db }) => {
			try {
				await client.query("BEGIN");
				const fresh = makeFts(client, { tableName: "fts_c2_new" });
				await fresh.initialize();
				await fresh.set(T, "s", "k", { fields: { title: "x" } });
				assertEquals(await fresh.count(T), 1);
				await client.query("ROLLBACK");
				// created inside the caller's transaction → gone with it
				const { rows } = await db.query(`SELECT to_regclass('fts_c2_new') AS r`);
				assertEquals(rows[0].r, null);
			} finally {
				await db.query(`DROP TABLE IF EXISTS fts_c2_new`);
			}

			await fts.set(T, "s", "k", { fields: { title: "kept" } });
			await client.query("BEGIN");
			await clientFts.destroy(true);
			await client.query("ROLLBACK");
			// the drop was the caller's to commit — and they did not
			assertEquals(await fts.count(T), 1);
		},
	);
});

Deno.test("caller transaction: set() truncate-retry works and keeps it usable", async () => {
	await withClientStore(
		{ tableName: "fts_c3", ...HUGE_BUDGETS },
		async ({ fts, clientFts, client }) => {
			await client.query("BEGIN");
			await clientFts.set(T, "s", "before", { fields: { title: "before" } });
			// overflows the tsvector cap: the failed INSERT would abort a plain
			// transaction, leaving the retry (and everything after) dead with 25P02
			await clientFts.set(T, "s", "big", {
				fields: { body: oversizedText() },
				value: { big: true },
			});
			await clientFts.set(T, "s", "after", { fields: { title: "after" } });

			assertEquals(await clientFts.count(T, "s"), 3);
			assertEquals(await fts.count(T, "s"), 0); // still pending for everyone else
			await client.query("COMMIT");

			assertEquals(await fts.count(T, "s"), 3);
			assertEquals(await fts.get(T, "s", "big"), { big: true });
		},
	);
});

Deno.test("caller transaction: setMany oversize fallback stays pending", async () => {
	await withClientStore(
		{ tableName: "fts_c4", ...HUGE_BUDGETS },
		async ({ fts, clientFts, client }) => {
			await client.query("BEGIN");
			await clientFts.setMany(T, "s", [
				{ key: "a", fields: { title: "small one" } },
				{ key: "big", fields: { body: oversizedText() } },
				{ key: "b", fields: { title: "small two" } },
			]);
			assertEquals(await clientFts.count(T, "s"), 3);
			assertEquals(await fts.count(T, "s"), 0);
			await client.query("ROLLBACK");
			assertEquals(await fts.count(T, "s"), 0);
		},
	);
});

Deno.test("caller transaction: a failing setMany undoes only itself", async () => {
	await withClientStore(
		{ tableName: "fts_c5", ...HUGE_BUDGETS, onOversize: "throw" },
		async ({ fts, clientFts, client }) => {
			await client.query("BEGIN");
			await clientFts.set(T, "s", "mine", { fields: { title: "caller write" } });
			await assertRejects(
				() =>
					clientFts.setMany(T, "s", [
						{ key: "a", fields: { title: "small one" } },
						{ key: "big", fields: { body: oversizedText() } },
					]),
				Error,
				"tsvector byte cap",
			);
			// the transaction survived, the batch is gone whole, the earlier write stayed
			assertEquals(await clientFts.count(T, "s"), 1);
			await client.query("COMMIT");

			assertEquals(await fts.get(T, "s", "mine"), { title: "caller write" });
			assertEquals(await fts.get(T, "s", "a"), null);
		},
	);
});

Deno.test("fuzzy threshold never outlives the search on a caller's connection", async () => {
	await withClientStore({ tableName: "fts_c6" }, async ({ fts, clientFts, client }) => {
		await fts.set(T, "s", "k", { fields: { body: BODY } });
		const fuzzy = (trgmThreshold?: number) =>
			clientFts.search(T, "s", "lorm", { mode: "fuzzy", trgmThreshold });

		// first use loads pg_trgm in this session and settles the baseline; "lorm"
		// scores exactly 0.6 against "lorem", so it matches at the default threshold
		assertEquals((await fuzzy()).hits.length, 1);
		const base = await showThreshold(client);

		// idle connection: a strict threshold applies to the search (no hit proves
		// it), and is gone right after
		assertEquals((await fuzzy(0.95)).hits, []);
		assertEquals(await showThreshold(client), base);
		assertEquals((await fuzzy()).hits.length, 1);

		// inside the caller's transaction: restored at once, not only at its end
		await client.query("BEGIN");
		assertEquals((await fuzzy(0.95)).hits, []);
		assertEquals(await showThreshold(client), base);
		await client.query("COMMIT");
		assertEquals(await showThreshold(client), base);

		// the caller's own transaction-local value is put back, and stays local
		await client.query("BEGIN");
		await client.query(`SET LOCAL ${GUC} = 0.9`);
		assertEquals((await fuzzy(0.4)).hits.length, 1); // ours applied, not their 0.9
		assertEquals(await showThreshold(client), "0.9");
		await client.query("COMMIT");
		assertEquals(await showThreshold(client), base);

		// a search that FAILS inside a transaction aborts it, so the restore cannot
		// run — the caller's rollback then reverts the setting on its own
		await client.query("BEGIN");
		await client.query(`ALTER TABLE fts_c6 RENAME TO fts_c6_gone`);
		await assertRejects(() => fuzzy(0.95), Error, "does not exist");
		await client.query("ROLLBACK");
		assertEquals(await showThreshold(client), base);
		assertEquals((await fuzzy()).hits.length, 1);
	});
});

Deno.test("fuzzy on a fresh session: restores the default it found unset", async () => {
	await withClientStore({ tableName: "fts_c9" }, async ({ fts }) => {
		await fts.set(T, "s", "k", { fields: { body: BODY } });

		// a session that has never touched pg_trgm: its threshold GUC is not even
		// defined yet (reads NULL), so "restore" must mean "reset to default"
		const pool = createPg();
		try {
			const session = await pool.connect();
			try {
				const sessionFts = makeFts(session, { tableName: "fts_c9" });
				await sessionFts.initialize();
				const search = (trgmThreshold?: number) =>
					sessionFts.search(T, "s", "lorm", { mode: "fuzzy", trgmThreshold });

				assertEquals((await search(0.95)).hits, []);
				// not stuck at 0.95: the default applies again, to SQL and to the store
				assertEquals(await showThreshold(session), "0.6");
				assertEquals((await search()).hits.length, 1);
			} finally {
				session.release();
			}
		} finally {
			await pool.end();
		}
	});
});

Deno.test("concurrent fuzzy searches on one connection keep their own thresholds", async () => {
	await withClientStore({ tableName: "fts_c7" }, async ({ fts, clientFts, client }) => {
		await fts.set(T, "s", "k", { fields: { body: BODY } });
		await clientFts.search(T, "s", "lorem", { mode: "fuzzy" });
		const base = await showThreshold(client);

		// a single connection runs statements in arrival order, so unserialized units
		// would interleave: one search's threshold would decide another's matches, and
		// the "previous value" one of them restores would be the other's
		const loose = (i: number) => i % 2 === 0;
		const runs = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				clientFts.search(T, "s", "lorm", {
					mode: "fuzzy",
					trgmThreshold: loose(i) ? 0.4 : 0.95,
				})),
		);
		runs.forEach((r, i) => assertEquals(r.hits.length, loose(i) ? 1 : 0, `run ${i}`));
		assertEquals(await showThreshold(client), base);
	});
});

Deno.test("idle connection: units commit, stay atomic, and queue", async () => {
	await withClientStore(
		{ tableName: "fts_c8", ...HUGE_BUDGETS },
		async ({ fts, clientFts, client }) => {
			// no caller transaction → the per-row fallback opens and commits its own
			await clientFts.setMany(T, "s", [
				{ key: "a", fields: { title: "small one" } },
				{ key: "big", fields: { body: oversizedText() } },
				{ key: "b", fields: { title: "small two" } },
			]);
			assertEquals(await fts.count(T, "s"), 3); // visible to another connection

			// …and rolls its own back, whole, when a row cannot be written
			const strict = makeFts(client, {
				tableName: "fts_c8",
				...HUGE_BUDGETS,
				onOversize: "throw",
			});
			await strict.initialize();
			await assertRejects(
				() =>
					strict.setMany(T, "s2", [
						{ key: "a", fields: { title: "small one" } },
						{ key: "big", fields: { body: oversizedText() } },
					]),
				Error,
				"tsvector byte cap",
			);
			assertEquals(await fts.count(T, "s2"), 0);

			// two stores booting on the same connection at once do not share a BEGIN
			const [one, two] = [makeFts(client, { tableName: "fts_c8" }), strict];
			await two.destroy();
			await Promise.all([one.initialize(), two.initialize()]);
			assertEquals(await one.count(T, "s"), 3);
		},
	);
});
