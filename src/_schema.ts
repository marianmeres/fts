/**
 * @module
 *
 * Schema construction. Builds the `CREATE`/`DROP` DDL from a resolved store config.
 * Everything spliced into SQL here is validated first ({@link assertValidTableName},
 * {@link assertValidIdent}) since it is interpolated verbatim (no bind params in DDL).
 */

import type { ResolvedFtsConfig } from "./types.ts";

/** Allows a single optional `schema.` prefix; otherwise word characters only. */
const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** A single SQL identifier / config token (no schema prefix, no dots). */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Name of the generated trigram source column (present only when `fuzzy`). */
const TRGM_COLUMN = "fts_trgm";

/** Validate a table name (may be schema-qualified). Throws on failure. */
export function assertValidTableName(tableName: string): void {
	if (!TABLE_NAME_RE.test(tableName)) {
		throw new Error(
			`fts: invalid tableName "${tableName}". Only word characters and a single ` +
				`"schema." prefix are allowed.`,
		);
	}
}

/** Validate a bare identifier (field name, language key, text search config). */
export function assertValidIdent(value: string, what: string): void {
	if (!IDENT_RE.test(value)) {
		throw new Error(
			`fts: invalid ${what} "${value}". Only word characters are allowed ` +
				`(must match ${IDENT_RE}).`,
		);
	}
}

/**
 * Slug derived from a (possibly schema-qualified) table name, safe for use inside
 * other identifiers such as index names. Mirrors `@marianmeres/kv` (`\W → _`), so a
 * schema-qualified `public.__fts` yields `public___fts`.
 */
export function safe(name: string): string {
	return name.replace(/\W/g, "_");
}

/** The weighted tsvector expression for one language's generated column. */
function tsvExpr(cfg: ResolvedFtsConfig, lang: string): string {
	const tsConfig = cfg.languages[lang];
	const parts = Object.entries(cfg.fields).map(
		([field, weight]) =>
			`setweight(to_tsvector('${tsConfig}', coalesce(content->>'${field}', '')), '${weight}')`,
	);
	// CASE-guard by `lang` so a row only populates its own language column
	// (sparse multi-language storage; non-matching columns store an empty tsvector).
	return `CASE WHEN lang = '${lang}' THEN\n\t\t\t${
		parts.join(" ||\n\t\t\t")
	}\n\t\tELSE ''::tsvector END`;
}

/** The concatenated trigram source expression (lang-independent). */
function trgmExpr(cfg: ResolvedFtsConfig): string {
	return Object.keys(cfg.fields)
		.map((field) => `coalesce(content->>'${field}', '')`)
		.join(" || ' ' || ");
}

/** `CREATE EXTENSION` statements needed by the store (empty when `manageExtensions` is off). */
export function buildExtensionsSql(cfg: ResolvedFtsConfig): string {
	const exts = ["btree_gin"];
	if (cfg.fuzzy) exts.push("pg_trgm");
	return exts.map((e) => `CREATE EXTENSION IF NOT EXISTS ${e};`).join("\n");
}

/**
 * `CREATE TABLE IF NOT EXISTS` with the generated columns. Split from
 * {@link buildIndexesSql} because the drift check must run in between: on a table
 * created under a different config the index DDL would otherwise fail first, with a
 * bare "column does not exist".
 */
export function buildTableSql(cfg: ResolvedFtsConfig): string {
	const { tableName } = cfg;
	const langs = Object.keys(cfg.languages);

	const tsvColumns = langs
		.map((lang) =>
			`\ttsv_${lang} tsvector GENERATED ALWAYS AS (\n\t\t${
				tsvExpr(cfg, lang)
			}\n\t) STORED`
		)
		.join(",\n");

	const trgmColumn = cfg.fuzzy
		? `,\n\t${TRGM_COLUMN} text GENERATED ALWAYS AS (\n\t\t${
			trgmExpr(cfg)
		}\n\t) STORED`
		: "";

	return `CREATE TABLE IF NOT EXISTS ${tableName} (
	tenant_id  VARCHAR(255) NOT NULL DEFAULT '_default',
	scope      TEXT NOT NULL,
	key        TEXT NOT NULL,
	lang       VARCHAR(32) NOT NULL DEFAULT '${cfg.defaultLang}',
	content    JSONB NOT NULL,
	value      JSONB,
${tsvColumns}${trgmColumn},
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (tenant_id, scope, key)
);`;
}

/** The composite `CREATE INDEX IF NOT EXISTS` statements (one per language, + trgm). */
export function buildIndexesSql(cfg: ResolvedFtsConfig): string {
	const { tableName } = cfg;
	const slug = safe(tableName);

	const tsvIndexes = Object.keys(cfg.languages)
		.map(
			(lang) =>
				`CREATE INDEX IF NOT EXISTS idx_${slug}_tsv_${lang}\n\tON ${tableName} USING gin (tenant_id, scope, tsv_${lang});`,
		)
		.join("\n\n");

	const trgmIndex = cfg.fuzzy
		? `\n\nCREATE INDEX IF NOT EXISTS idx_${slug}_trgm\n\tON ${tableName} USING gin (tenant_id, scope, ${TRGM_COLUMN} gin_trgm_ops);`
		: "";

	return `${tsvIndexes}${trgmIndex}`;
}

/** `DROP TABLE IF EXISTS`. */
export function buildDropSql(cfg: ResolvedFtsConfig): string {
	return `DROP TABLE IF EXISTS ${cfg.tableName};`;
}

// ---------------------------------------------------------------------------
// Schema drift detection
//
// `fields` / `languages` / `fuzzy` are baked into generated-column DDL, and every
// statement above is `IF NOT EXISTS` — so a store configured differently from the
// table it finds would provision "successfully" and then silently index the OLD
// definition (a newly-configured field is simply never searchable). The table's
// generated columns are therefore read back from the catalog and compared.
// ---------------------------------------------------------------------------

/**
 * Reads every stored generated column of the table (`$1` = table name) with its
 * expression as PostgreSQL deparses it. Returns no rows when the table is absent.
 */
export const GENERATED_COLUMNS_SQL =
	`SELECT a.attname AS name, pg_get_expr(d.adbin, d.adrelid) AS expr
	FROM pg_attribute a
	JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
	WHERE a.attrelid = to_regclass($1::text) AND a.attgenerated = 's' AND NOT a.attisdropped`;

/** One row of {@link GENERATED_COLUMNS_SQL}. */
export interface GeneratedColumn {
	name: string;
	expr: string;
}

/** Result of {@link diffSchema}. */
export interface SchemaDiff {
	/** The table cannot serve this config correctly — refuse to use it. */
	errors: string[];
	/** Leftover columns this config does not use — harmless, worth a warning. */
	extras: string[];
}

/** `english: title:A, body:B` — what one tsvector column indexes, for messages. */
function describeTsv(tsConfig: string, parts: [string, string][]): string {
	return `${tsConfig}: ${parts.map(([f, w]) => `${f}:${w}`).join(", ")}`;
}

/**
 * Reduce a deparsed tsvector column expression to what it indexes: the `lang` guard
 * literal plus the ordered `(text search config, field, weight)` triples. Matches the
 * structure, not the exact text, so deparse whitespace and cast noise do not matter
 * (PostgreSQL prints `'simple'::regconfig`, `(content ->> 'title'::text)`,
 * `'A'::"char"`). Returns `null` when the expression is not one of ours.
 */
function parseTsvExpr(
	expr: string,
): { lang: string; parts: [string, string, string][] } | null {
	const lang = /\blang\b[^=']*=\s*'([^']*)'/.exec(expr)?.[1];
	// `[^|]*?` keeps one match inside one `setweight(...)` — parts are `||`-joined
	const re =
		/to_tsvector\(\s*'([^']+)'[^|]*?content\s*->>\s*'([^']+)'[^|]*?'([A-D])'::"char"/g;
	const parts: [string, string, string][] = [];
	for (const m of expr.matchAll(re)) {
		// regconfig may deparse schema-qualified and is case-folded like an identifier
		const tsConfig = m[1].split(".").pop()!.replaceAll('"', "").toLowerCase();
		parts.push([tsConfig, m[2], m[3]]);
	}
	return lang === undefined || !parts.length ? null : { lang, parts };
}

/** The ordered field list a deparsed trigram column expression concatenates. */
function parseTrgmExpr(expr: string): string[] {
	return [...expr.matchAll(/content\s*->>\s*'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Compare the table's actual generated columns with what `cfg` would create.
 *
 * Only a column this config NEEDS can produce an error (missing, or defined
 * differently): that is the case that returns wrong results. Columns the config does
 * not use (a dropped language, the trigram column of a store now configured
 * `fuzzy:false`) still work for everything configured, so they are reported as
 * `extras` and never block.
 */
export function diffSchema(
	cfg: ResolvedFtsConfig,
	actual: GeneratedColumn[],
): SchemaDiff {
	// unquoted identifiers fold to lower case, so `tsv_EN` is stored as `tsv_en`
	const byName = new Map(actual.map((c) => [c.name.toLowerCase(), c.expr]));
	const fields = Object.entries(cfg.fields);
	const errors: string[] = [];
	const used = new Set<string>();

	for (const [lang, tsConfig] of Object.entries(cfg.languages)) {
		const column = `tsv_${lang}`.toLowerCase();
		used.add(column);
		const expr = byName.get(column);
		if (expr === undefined) {
			errors.push(`column ${column} is missing (language "${lang}")`);
			continue;
		}
		const want = describeTsv(tsConfig.toLowerCase(), fields);
		const parsed = parseTsvExpr(expr);
		if (!parsed) {
			errors.push(
				`column ${column} has an unrecognized definition: ${expr.trim()}`,
			);
			continue;
		}
		// one config per column is all this package ever generates; a hand-made mix
		// is spelled out per field so the message stays truthful
		const sameConfig = parsed.parts.every(([c]) => c === parsed.parts[0][0]);
		const got = sameConfig
			? describeTsv(parsed.parts[0][0], parsed.parts.map(([, f, w]) => [f, w]))
			: parsed.parts.map(([c, f, w]) => `${c}: ${f}:${w}`).join("; ");
		if (got !== want) {
			errors.push(
				`column ${column} indexes [${got}] but the store is configured for [${want}]`,
			);
		} else if (parsed.lang !== lang) {
			errors.push(
				`column ${column} is populated for lang "${parsed.lang}" but the store ` +
					`is configured for "${lang}"`,
			);
		}
	}

	if (cfg.fuzzy) {
		used.add(TRGM_COLUMN);
		const expr = byName.get(TRGM_COLUMN);
		if (expr === undefined) {
			errors.push(
				`column ${TRGM_COLUMN} is missing (the store is configured with fuzzy:true)`,
			);
		} else {
			const got = parseTrgmExpr(expr).join(", ");
			const want = Object.keys(cfg.fields).join(", ");
			if (got !== want) {
				errors.push(
					`column ${TRGM_COLUMN} covers [${got}] but the store is configured for [${want}]`,
				);
			}
		}
	}

	const extras = [...byName.keys()]
		.filter((n) => (n.startsWith("tsv_") || n === TRGM_COLUMN) && !used.has(n))
		.sort();
	return { errors, extras };
}
