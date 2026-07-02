/**
 * @module
 *
 * `@marianmeres/fts` — a standalone, PostgreSQL-backed full-text search primitive that
 * presents as a scoped, searchable key-value store. No third-party search engine.
 */

export { createFts, Fts } from "./fts.ts";
export { type PgExecutor } from "./_pg.ts";
export {
	DEFAULT_FIELDS,
	DEFAULT_LANG,
	DEFAULT_TABLE_NAME,
	DEFAULT_TENANT_ID,
	DEFAULT_TS_CONFIG,
	type FtsDoc,
	type FtsOptions,
	type FtsWeight,
	type OnOversize,
	type ResolvedFtsConfig,
	type SearchHit,
	type SearchMode,
	type SearchOptions,
	type SearchResult,
	type SetEntry,
} from "./types.ts";
