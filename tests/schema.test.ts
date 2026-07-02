// deno-lint-ignore-file no-explicit-any

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { createFts, type FtsOptions } from "../src/mod.ts";
import { createPg, freshStore } from "./_fts.ts";

/** Run `fn` against a freshly-provisioned store, always cleaning up. */
async function withStore(
	opts: Partial<FtsOptions>,
	fn: (fts: Awaited<ReturnType<typeof freshStore>>, db: any) => Promise<void>,
): Promise<void> {
	const db = createPg();
	try {
		const fts = await freshStore(db, opts);
		try {
			await fn(fts, db);
		} finally {
			await fts.destroy(true);
		}
	} finally {
		await db.end();
	}
}

/** Bare table part of a possibly schema-qualified name. */
function tablePart(name: string): string {
	return name.includes(".") ? name.split(".")[1] : name;
}
function schemaPart(name: string): string {
	return name.includes(".") ? name.split(".")[0] : "public";
}

async function columns(db: any, tableName: string): Promise<string[]> {
	const { rows } = await db.query(
		`SELECT column_name FROM information_schema.columns
		 WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`,
		[schemaPart(tableName), tablePart(tableName)],
	);
	return rows.map((r: any) => r.column_name);
}

async function indexes(db: any, tableName: string): Promise<Record<string, string>> {
	const { rows } = await db.query(
		`SELECT indexname, indexdef FROM pg_indexes
		 WHERE schemaname = $1 AND tablename = $2`,
		[schemaPart(tableName), tablePart(tableName)],
	);
	return Object.fromEntries(rows.map((r: any) => [r.indexname, r.indexdef]));
}

// ---------------------------------------------------------------------------
// Config validation (no DB needed — constructor resolves + validates eagerly)
// ---------------------------------------------------------------------------

Deno.test("createFts: missing db throws", () => {
	assertThrows(() => createFts({} as any), Error, "missing pg instance");
});

Deno.test("createFts: invalid tableName throws", () => {
	assertThrows(
		() => createFts({ db: {} as any, tableName: "bad name!" }),
		Error,
		"invalid tableName",
	);
	// two dots (only a single schema. prefix is allowed)
	assertThrows(() => createFts({ db: {} as any, tableName: "a.b.c" }), Error);
});

Deno.test("createFts: invalid field weight throws", () => {
	assertThrows(
		() => createFts({ db: {} as any, fields: { title: "Z" as any } }),
		Error,
		"invalid weight",
	);
});

Deno.test("createFts: invalid field name throws", () => {
	assertThrows(
		() => createFts({ db: {} as any, fields: { "bad-field": "A" } }),
		Error,
		"invalid field name",
	);
});

Deno.test("createFts: empty fields / languages throw", () => {
	assertThrows(
		() => createFts({ db: {} as any, fields: {} }),
		Error,
		"at least one field",
	);
	assertThrows(
		() => createFts({ db: {} as any, languages: {} }),
		Error,
		"at least one language",
	);
});

Deno.test("createFts: defaultLang not in languages throws", () => {
	assertThrows(
		() =>
			createFts({ db: {} as any, languages: { en: "english" }, defaultLang: "sk" }),
		Error,
		"defaultLang",
	);
});

Deno.test("createFts: invalid text search config throws", () => {
	assertThrows(
		() => createFts({ db: {} as any, languages: { en: "eng lish" } }),
		Error,
		"text search config",
	);
});

// ---------------------------------------------------------------------------
// Provisioning (real Postgres)
// ---------------------------------------------------------------------------

Deno.test("initialize: default schema has expected columns", async () => {
	await withStore({ tableName: "fts_cols" }, async (_fts, db) => {
		const cols = await columns(db, "fts_cols");
		for (
			const c of [
				"tenant_id",
				"scope",
				"key",
				"lang",
				"content",
				"value",
				"tsv_default",
				"fts_trgm",
				"created_at",
				"updated_at",
			]
		) {
			assert(cols.includes(c), `missing column: ${c} (got ${cols.join(", ")})`);
		}
	});
});

Deno.test("initialize: composite btree_gin indexes exist", async () => {
	await withStore({ tableName: "fts_idx" }, async (_fts, db) => {
		const idx = await indexes(db, "fts_idx");
		const tsv = idx["idx_fts_idx_tsv_default"];
		assert(tsv, `missing tsv index (got ${Object.keys(idx).join(", ")})`);
		assert(/USING gin/i.test(tsv), `tsv index not gin: ${tsv}`);
		assert(
			/tenant_id/.test(tsv) && /scope/.test(tsv) && /tsv_default/.test(tsv),
			tsv,
		);

		const trgm = idx["idx_fts_idx_trgm"];
		assert(trgm, "missing trgm index");
		assert(/gin_trgm_ops/.test(trgm), `trgm index missing gin_trgm_ops: ${trgm}`);
	});
});

Deno.test("initialize: is idempotent", async () => {
	await withStore({ tableName: "fts_idem" }, async (fts) => {
		await fts.initialize(); // second call — must not throw
		assert(fts.initialized);
	});
});

Deno.test("destroy(hard) drops the table; destroy() only flips state", async () => {
	const db = createPg();
	try {
		const fts = await freshStore(db, { tableName: "fts_drop" });
		await fts.destroy(); // soft
		assertFalse(fts.initialized);
		assertEquals(
			(await columns(db, "fts_drop")).length > 0,
			true,
			"soft destroy kept table",
		);

		await fts.initialize();
		await fts.destroy(true); // hard
		assertEquals(await columns(db, "fts_drop"), [], "hard destroy left table behind");
	} finally {
		await db.end();
	}
});

Deno.test("generated tsv_default populates from content, with weights", async () => {
	await withStore({ tableName: "fts_gen" }, async (_fts, db) => {
		await db.query(
			`INSERT INTO fts_gen (tenant_id, scope, key, content)
			 VALUES ('_default', 's', 'k1', $1)`,
			[JSON.stringify({ title: "hello world", body: "the body" })],
		);
		const { rows } = await db.query(
			`SELECT tsv_default::text AS tsv,
			        (tsv_default @@ to_tsquery('simple','hello')) AS m_title,
			        (tsv_default @@ to_tsquery('simple','body'))  AS m_body
			 FROM fts_gen WHERE key = 'k1'`,
		);
		const row = rows[0];
		assert(row.m_title, "title lexeme not matched");
		assert(row.m_body, "body lexeme not matched");
		assert(/'hello':1A/.test(row.tsv), `title should be weight A: ${row.tsv}`);
		assert(/'body':\d+B/.test(row.tsv), `body should be weight B: ${row.tsv}`);
	});
});

Deno.test("multi-language: one column+index per lang; per-row lang guard", async () => {
	await withStore(
		{
			tableName: "fts_lang",
			languages: { en: "english", sk: "simple" },
			defaultLang: "en",
		},
		async (_fts, db) => {
			const cols = await columns(db, "fts_lang");
			assert(cols.includes("tsv_en") && cols.includes("tsv_sk"), cols.join(", "));

			const idx = await indexes(db, "fts_lang");
			assert(
				idx["idx_fts_lang_tsv_en"] && idx["idx_fts_lang_tsv_sk"],
				Object.keys(idx).join(", "),
			);

			// an english row: stemmed lexeme in tsv_en, and tsv_sk empty (CASE guard)
			await db.query(
				`INSERT INTO fts_lang (tenant_id, scope, key, lang, content)
				 VALUES ('_default','s','en1','en', $1)`,
				[JSON.stringify({ title: "running cats", body: "" })],
			);
			const { rows } = await db.query(
				`SELECT (tsv_en @@ to_tsquery('english','run')) AS en_stemmed,
				        (tsv_sk = ''::tsvector) AS sk_empty
				 FROM fts_lang WHERE key = 'en1'`,
			);
			assert(rows[0].en_stemmed, "english column should stem running->run");
			assert(rows[0].sk_empty, "non-selected language column should be empty");
		},
	);
});

Deno.test("fuzzy:false omits fts_trgm column and trgm index", async () => {
	await withStore({ tableName: "fts_nofz", fuzzy: false }, async (_fts, db) => {
		assertFalse((await columns(db, "fts_nofz")).includes("fts_trgm"));
		assertFalse(
			Object.keys(await indexes(db, "fts_nofz")).includes("idx_fts_nofz_trgm"),
		);
	});
});

Deno.test("schema-qualified tableName derives slugged index names", async () => {
	await withStore({ tableName: "public.fts_q" }, async (_fts, db) => {
		const idx = await indexes(db, "public.fts_q");
		assert(
			idx["idx_public_fts_q_tsv_default"],
			`expected slugged index name, got ${Object.keys(idx).join(", ")}`,
		);
	});
});

Deno.test("manageExtensions:false initializes without touching extensions", async () => {
	// extensions are pre-provisioned in the test DB, so this must succeed cleanly
	await withStore(
		{ tableName: "fts_noext", manageExtensions: false },
		async (_fts, db) => {
			assert((await columns(db, "fts_noext")).includes("tsv_default"));
		},
	);
});
