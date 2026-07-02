/**
 * @module
 *
 * Public types and constants for `@marianmeres/fts`.
 */

import type pg from "pg";
import type { Logger } from "@marianmeres/clog";
import type { Searchable, SearchableOptions } from "@marianmeres/searchable";

/** Default `tenant_id` value — used as the column default and when a caller omits it. */
export const DEFAULT_TENANT_ID = "_default";

/** Default table name (may be schema-qualified, e.g. `"public.__fts"`). */
export const DEFAULT_TABLE_NAME = "__fts";

/** Default language key when a store does not configure `languages`. */
export const DEFAULT_LANG = "default";

/** Default text search config used by the default language (no stemming, no stopwords). */
export const DEFAULT_TS_CONFIG = "simple";

/** Default field → weight mapping when a store does not configure `fields`. */
export const DEFAULT_FIELDS: Readonly<Record<string, FtsWeight>> = Object.freeze({
	title: "A",
	body: "B",
	tags: "C",
});

/** PostgreSQL `ts_rank` weight label. `A` is the strongest, `D` the weakest. */
export type FtsWeight = "A" | "B" | "C" | "D";

/** What to do when a document still overflows the tsvector byte cap after truncation. */
export type OnOversize = "truncate" | "throw";

/**
 * Options accepted by {@link createFts}.
 */
export interface FtsOptions {
	/** PostgreSQL connection — either a `pg.Pool` or a `pg.Client`. Required. */
	db: pg.Pool | pg.Client;
	/**
	 * Table name. May be prefixed with a schema, e.g. `"public.__fts"`. Only word
	 * characters and a single `.` prefix are allowed (it is spliced into SQL verbatim).
	 * @default "__fts"
	 */
	tableName?: string;
	/** Logger; defaults to `createClog("fts")`. */
	logger?: Logger;
	/**
	 * Field → weight mapping. Baked into the generated tsvector DDL at store creation,
	 * so changing it later is a schema change. Only listed fields are indexed.
	 * @default { title: "A", body: "B", tags: "C" }
	 */
	fields?: Record<string, FtsWeight>;
	/**
	 * Language key → PostgreSQL text search config. Each key gets its own generated
	 * `tsv_<key>` column + composite index. `prefix` mode is only sound on the `simple`
	 * config (stemmers reduce words before the prefix is applied).
	 * @default { default: "simple" }
	 */
	languages?: Record<string, string>;
	/**
	 * Language key used when `set()`/`search()` omit `lang`.
	 * @default the first key of `languages`
	 */
	defaultLang?: string;
	/**
	 * Enable the fuzzy (`pg_trgm`) path — adds the generated `fts_trgm` column and its
	 * `gin_trgm_ops` index. Never the default search mode; opt-in per query.
	 * @default true
	 */
	fuzzy?: boolean;
	/**
	 * Run `CREATE EXTENSION IF NOT EXISTS btree_gin` (and `pg_trgm` when `fuzzy`) during
	 * {@link Fts.initialize}. Set `false` when a DBA pre-provisions them (a least-privilege
	 * role cannot create an extension that is not already installed).
	 * @default true
	 */
	manageExtensions?: boolean;
	/**
	 * Coarse per-document budget: normalized indexed text is truncated to this many
	 * characters before building `content`. NOTE: the tsvector cap is a ~1MB *byte* limit
	 * driven by distinct-lexeme count, so this alone is not a guarantee — see
	 * {@link FtsOptions.maxIndexedLexemes}.
	 * @default 1_000_000
	 */
	maxIndexedChars?: number;
	/**
	 * Per-field cap on the number of distinct indexed tokens (the real driver of tsvector
	 * byte size). Applied after normalization, before building `content`.
	 * @default 10_000
	 */
	maxIndexedLexemes?: number;
	/**
	 * Behavior when a document still overflows the tsvector byte cap on write:
	 * `"truncate"` re-truncates and retries; `"throw"` surfaces a clear error.
	 * @default "truncate"
	 */
	onOversize?: OnOversize;
	/**
	 * The normalization brain. Either a ready `Searchable` instance or options to construct
	 * one. The SAME instance is used at write and query time to keep lexemes in sync.
	 */
	searchable?: Searchable | Partial<SearchableOptions>;
}

/**
 * Fully-resolved, validated, immutable store configuration derived from {@link FtsOptions}.
 * Consumed by the schema builder and the read/write paths.
 * @internal
 */
export interface ResolvedFtsConfig {
	tableName: string;
	fields: Record<string, FtsWeight>;
	languages: Record<string, string>;
	defaultLang: string;
	fuzzy: boolean;
	manageExtensions: boolean;
	maxIndexedChars: number;
	maxIndexedLexemes: number;
	onOversize: OnOversize;
}

/** A fielded document written via {@link Fts.set}. */
export interface FtsDoc {
	/** Raw field text; normalized app-side into `content`. */
	fields: Record<string, string>;
	/** Opaque payload returned by `get()`/`search()`; defaults to `fields` if omitted. */
	value?: unknown;
	/** Language key (whitelisted); defaults to the store's `defaultLang`. */
	lang?: string;
}

/** A single entry for {@link Fts.setMany}. */
export interface SetEntry extends FtsDoc {
	key: string;
}

/** Matching mode for {@link Fts.search}. */
export type SearchMode = "prefix" | "exact" | "fuzzy";

/** Options for {@link Fts.search}. */
export interface SearchOptions {
	/** Language key (whitelisted); defaults to the store's `defaultLang`. */
	lang?: string;
	/** @default "prefix" */
	mode?: SearchMode;
	/** @default 20 */
	limit?: number;
	/** @default 0 */
	offset?: number;
	/** Also compute the total match count (an extra `COUNT(*)`). */
	withTotal?: boolean;
	/** @default "ts_rank_cd" */
	rankFn?: "ts_rank" | "ts_rank_cd";
	/** `{D, C, B, A}` weights. @default [0.1, 0.2, 0.4, 1.0] */
	weights?: [number, number, number, number];
	/** Fuzzy only: `pg_trgm` word-similarity threshold. @default 0.6 */
	trgmThreshold?: number;
}

/** A single ranked search result. */
export interface SearchHit {
	key: string;
	value: unknown;
	rank: number;
}

/** The result of {@link Fts.search}. */
export interface SearchResult {
	hits: SearchHit[];
	total?: number;
	limit: number;
	offset: number;
}
