// deno-lint-ignore-file no-explicit-any

import {
	assert,
	assertEquals,
	assertFalse,
	assertRejects,
	assertThrows,
} from "@std/assert";
import { createFts, DEFAULT_TENANT_ID, type FtsOptions } from "../src/mod.ts";
import { createPg, freshStore, makeFts, warnSpy } from "./_fts.ts";

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

// ---------------------------------------------------------------------------
// Schema drift (real Postgres)
//
// `fields` / `languages` / `fuzzy` are baked into generated columns and all DDL is
// `IF NOT EXISTS`. A store configured differently from the table it finds used to
// initialize "successfully" and then silently search the old definition.
// ---------------------------------------------------------------------------

/** Assert that a store configured with `opts` refuses the existing table `tableName`. */
async function assertDrift(
	db: any,
	tableName: string,
	opts: Partial<FtsOptions>,
	...expected: string[]
): Promise<void> {
	const drifted = makeFts(db, { tableName, ...opts });
	const err = await assertRejects(() => drifted.initialize(), Error, "schema drift");
	for (const part of expected) {
		assert(err.message.includes(part), `expected "${part}" in: ${err.message}`);
	}
	assertFalse(drifted.initialized);
}

Deno.test("schema drift: a table created for other fields is refused", async () => {
	await withStore({ tableName: "fts_drift1" }, async (_fts, db) => {
		// the silent failure this guards: `summary` would never be indexed
		await assertDrift(
			db,
			"fts_drift1",
			{ fields: { title: "A", summary: "B" } },
			"tsv_default",
			"simple: title:A, body:B, tags:C",
			"simple: title:A, summary:B",
			"fts_trgm covers [title, body, tags]",
		);
		// same fields, another weight
		await assertDrift(
			db,
			"fts_drift1",
			{ fields: { title: "B", body: "B", tags: "C" } },
			"tsv_default",
			"title:B",
		);
		// same fields, another order — the trigram text (and so fuzzy rank) differs
		await assertDrift(
			db,
			"fts_drift1",
			{ fields: { body: "B", title: "A", tags: "C" } },
			"fts_trgm",
		);
	});
});

Deno.test("schema drift: changed languages / text search config are refused", async () => {
	await withStore({ tableName: "fts_drift2" }, async (_fts, db) => {
		// a new language: named, instead of a bare "column tsv_sk does not exist"
		await assertDrift(
			db,
			"fts_drift2",
			{ languages: { default: "simple", sk: "simple" } },
			'column tsv_sk is missing (language "sk")',
		);
		// the same language key on another config
		await assertDrift(
			db,
			"fts_drift2",
			{ languages: { default: "english" } },
			"tsv_default",
			"english: title:A",
		);
	});
});

Deno.test("schema drift: fuzzy:true needs the trigram column", async () => {
	await withStore({ tableName: "fts_drift3", fuzzy: false }, async (_fts, db) => {
		await assertDrift(
			db,
			"fts_drift3",
			{ fuzzy: true },
			"column fts_trgm is missing",
		);
	});
});

Deno.test("schema drift: columns the config no longer uses only warn", async () => {
	await withStore(
		{
			tableName: "fts_drift4",
			languages: { en: "english", sk: "simple" },
			defaultLang: "sk",
		},
		async (fts, db) => {
			await fts.set(DEFAULT_TENANT_ID, "s", "k", { fields: { title: "domov" } });

			// one language dropped, fuzzy switched off: everything still configured
			// works on this table, so it is usable — but not silently
			const { logger, warns } = warnSpy();
			const subset = createFts({
				db,
				logger,
				tableName: "fts_drift4",
				languages: { sk: "simple" },
				fuzzy: false,
			});
			await subset.initialize();
			assertEquals(
				(await subset.search(DEFAULT_TENANT_ID, "s", "domov")).hits.length,
				1,
			);
			assertEquals(warns.length, 1);
			assert(warns[0].includes("fts_trgm, tsv_en"), warns[0]);
		},
	);
});

Deno.test("schema drift: a matching table passes (also schema-qualified, folded case)", async () => {
	const opts = {
		tableName: "public.fts_drift5",
		// PostgreSQL folds these: column `tsv_en`, config `english`
		languages: { EN: "English", sk: "simple" },
		fields: { title: "A" as const, Body_2: "D" as const },
	};
	await withStore(opts, async (_fts, db) => {
		const { logger, warns } = warnSpy();
		const again = createFts({ db, logger, ...opts });
		await again.initialize();
		assert(again.initialized);
		assertEquals(warns, []);

		await assertDrift(db, "public.fts_drift5", {
			...opts,
			fields: { title: "A", Body_2: "C" },
		}, "Body_2:C");
	});
});

Deno.test("schema drift: verifySchema:false skips the check", async () => {
	await withStore({ tableName: "fts_drift6" }, async (_fts, db) => {
		const unchecked = makeFts(db, {
			tableName: "fts_drift6",
			fields: { title: "A", summary: "B" },
			verifySchema: false,
		});
		await unchecked.initialize(); // the caller has taken responsibility
		assert(unchecked.initialized);
	});
});
