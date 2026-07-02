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

/** Full `CREATE TABLE` + generated columns + composite indexes DDL. */
export function buildSchemaSql(cfg: ResolvedFtsConfig): string {
	const { tableName } = cfg;
	const slug = safe(tableName);
	const langs = Object.keys(cfg.languages);

	const tsvColumns = langs
		.map((lang) =>
			`\ttsv_${lang} tsvector GENERATED ALWAYS AS (\n\t\t${
				tsvExpr(cfg, lang)
			}\n\t) STORED`
		)
		.join(",\n");

	const trgmColumn = cfg.fuzzy
		? `,\n\tfts_trgm text GENERATED ALWAYS AS (\n\t\t${trgmExpr(cfg)}\n\t) STORED`
		: "";

	const table = `CREATE TABLE IF NOT EXISTS ${tableName} (
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

	const tsvIndexes = langs
		.map(
			(lang) =>
				`CREATE INDEX IF NOT EXISTS idx_${slug}_tsv_${lang}\n\tON ${tableName} USING gin (tenant_id, scope, tsv_${lang});`,
		)
		.join("\n\n");

	const trgmIndex = cfg.fuzzy
		? `\n\nCREATE INDEX IF NOT EXISTS idx_${slug}_trgm\n\tON ${tableName} USING gin (tenant_id, scope, fts_trgm gin_trgm_ops);`
		: "";

	return `${table}\n\n${tsvIndexes}${trgmIndex}`;
}

/** `DROP TABLE IF EXISTS`. */
export function buildDropSql(cfg: ResolvedFtsConfig): string {
	return `DROP TABLE IF EXISTS ${cfg.tableName};`;
}
