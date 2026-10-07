/**
 * @module
 *
 * `@marianmeres/fts` — a PostgreSQL-backed full-text search primitive that presents as
 * a scoped, searchable key-value store. This file holds the public factory + class and
 * the store lifecycle (`initialize` / `destroy`); read/write paths are added on top.
 */

import type pg from "pg";
import { createClog, type Logger } from "@marianmeres/clog";
import type { Searchable } from "@marianmeres/searchable";
import {
	DEFAULT_FIELDS,
	DEFAULT_LANG,
	DEFAULT_TABLE_NAME,
	DEFAULT_TS_CONFIG,
	type FtsDoc,
	type FtsOptions,
	type FtsWeight,
	type ResolvedFtsConfig,
	type SearchOptions,
	type SearchResult,
	type SetEntry,
} from "./types.ts";
import {
	assertValidIdent,
	assertValidTableName,
	buildDropSql,
	buildExtensionsSql,
	buildIndexesSql,
	buildTableSql,
	diffSchema,
	GENERATED_COLUMNS_SQL,
} from "./_schema.ts";
import {
	type PgExecutor,
	withLocalSetting,
	withSavepoint,
	withTx,
	withTxState,
} from "./_pg.ts";
import {
	clampQueryGroups,
	isTsvectorOversize,
	normalizeDoc,
	resolveSearchable,
} from "./_normalize.ts";
import { buildTsquery } from "./_tsquery.ts";

/** `ts_rank*` weights in PostgreSQL's `{D, C, B, A}` order. */
const DEFAULT_RANK_WEIGHTS: [number, number, number, number] = [0.1, 0.2, 0.4, 1.0];

const VALID_WEIGHTS: readonly FtsWeight[] = ["A", "B", "C", "D"];

/** Validate + freeze a full store config from user options. */
function resolveConfig(options: FtsOptions): ResolvedFtsConfig {
	const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
	assertValidTableName(tableName);

	const fields = options.fields ?? { ...DEFAULT_FIELDS };
	const fieldEntries = Object.entries(fields);
	if (fieldEntries.length === 0) {
		throw new Error("fts: `fields` must contain at least one field.");
	}
	for (const [field, weight] of fieldEntries) {
		assertValidIdent(field, "field name");
		if (!VALID_WEIGHTS.includes(weight)) {
			throw new Error(
				`fts: invalid weight "${weight}" for field "${field}". Use one of A, B, C, D.`,
			);
		}
	}

	const languages = options.languages ?? { [DEFAULT_LANG]: DEFAULT_TS_CONFIG };
	const langEntries = Object.entries(languages);
	if (langEntries.length === 0) {
		throw new Error("fts: `languages` must contain at least one language.");
	}
	for (const [lang, tsConfig] of langEntries) {
		assertValidIdent(lang, "language key");
		assertValidIdent(tsConfig, "text search config");
	}

	const defaultLang = options.defaultLang ?? langEntries[0][0];
	if (!(defaultLang in languages)) {
		throw new Error(
			`fts: defaultLang "${defaultLang}" is not one of the configured languages ` +
				`(${Object.keys(languages).join(", ")}).`,
		);
	}

	const maxQueryLexemes = options.maxQueryLexemes ?? 32;
	const maxQueryChars = options.maxQueryChars ?? 512;
	for (
		const [what, n] of [
			["maxQueryLexemes", maxQueryLexemes],
			["maxQueryChars", maxQueryChars],
		] as const
	) {
		// `>= 1` also rejects NaN; Infinity is the documented way to disable a cap
		if (typeof n !== "number" || !(n >= 1)) {
			throw new Error(
				`fts: ${what} must be a number >= 1 (or Infinity to disable).`,
			);
		}
	}

	return Object.freeze({
		tableName,
		fields: Object.freeze({ ...fields }),
		languages: Object.freeze({ ...languages }),
		defaultLang,
		fuzzy: options.fuzzy ?? true,
		manageExtensions: options.manageExtensions ?? true,
		maxIndexedChars: options.maxIndexedChars ?? 1_000_000,
		maxIndexedLexemes: options.maxIndexedLexemes ?? 10_000,
		onOversize: options.onOversize ?? "truncate",
		maxQueryLexemes,
		maxQueryChars,
		verifySchema: options.verifySchema ?? true,
	});
}

/**
 * A scoped, searchable KV store backed by one PostgreSQL table.
 *
 * Construct via {@link createFts}, then call {@link Fts.initialize} once before use.
 */
export class Fts {
	readonly #db: pg.Pool | pg.Client;
	readonly #logger: Logger;
	/** Fully-resolved, validated, frozen store configuration. */
	readonly config: ResolvedFtsConfig;
	/**
	 * The normalization brain — used identically at write and query time (THE parity
	 * invariant). Exposed so callers can share the exact same normalization.
	 */
	readonly searchable: Searchable;
	#initialized = false;

	constructor(options: FtsOptions) {
		if (!options?.db) {
			throw new Error("fts: missing pg instance (`db` option is required).");
		}
		this.#db = options.db;
		this.#logger = options.logger ?? createClog("fts");
		this.config = resolveConfig(options);
		this.searchable = resolveSearchable(options.searchable);
	}

	/** Whether {@link Fts.initialize} has completed in this instance. */
	get initialized(): boolean {
		return this.#initialized;
	}

	/**
	 * Create the table, generated columns and indexes (idempotent, `IF NOT EXISTS`).
	 * When `manageExtensions` is on, also creates `btree_gin` (+ `pg_trgm` when `fuzzy`).
	 *
	 * Because the DDL is `IF NOT EXISTS`, a table that already exists is kept as it is —
	 * so unless `verifySchema` is off, its generated columns are compared with this
	 * store's `fields`/`languages`/`fuzzy` and a mismatch throws instead of silently
	 * searching the old definition.
	 */
	async initialize(): Promise<void> {
		if (this.#initialized) return;
		await withTx(this.#db, async (c) => {
			if (this.config.manageExtensions) await this.#createExtensions(c);
			await c.query(buildTableSql(this.config));
			// between table and indexes: on a drifted table the index DDL would fail
			// first, with a bare "column does not exist"
			if (this.config.verifySchema) await this.#verifySchema(c);
			await c.query(buildIndexesSql(this.config));
		});
		this.#initialized = true;
		this.#logger?.debug?.(`fts: initialized table "${this.config.tableName}"`);
	}

	/**
	 * Reset lifecycle state. When `hard` is true, drops the table (and its indexes).
	 */
	async destroy(hard = false): Promise<void> {
		if (hard) {
			await withTx(this.#db, (c) => c.query(buildDropSql(this.config)));
			this.#logger?.debug?.(`fts: dropped table "${this.config.tableName}"`);
		}
		this.#initialized = false;
	}

	// -----------------------------------------------------------------------
	// Write path (KV-shaped). `tenantId` is a REQUIRED positional first arg on
	// every method — no operation can accidentally cross tenants.
	// -----------------------------------------------------------------------

	/** Upsert one document under `(tenantId, scope, key)`. */
	async set(tenantId: string, scope: string, key: string, doc: FtsDoc): Promise<void> {
		this.#assertInitialized();
		this.#assertStr(tenantId, "tenantId");
		this.#assertStr(scope, "scope");
		this.#assertStr(key, "key");
		if (this.config.onOversize !== "truncate") {
			// nothing is retried, so there is no need to know about an outer transaction
			await this.#setOn(
				this.#db as unknown as PgExecutor,
				tenantId,
				scope,
				key,
				doc,
			);
			return;
		}
		// truncate-retry re-runs a FAILED statement — inside a caller's transaction
		// (`db` is a pg.Client) that is only possible under a savepoint
		await withTxState(
			this.#db,
			(exec, inTx) => this.#setOn(exec, tenantId, scope, key, doc, inTx),
		);
	}

	/**
	 * Upsert many documents under one `(tenantId, scope)` — atomic: either all entries
	 * land or none. Uses a single statement whatever the batch size (the rows travel as
	 * arrays, so the 65,535 bind-parameter limit of a `VALUES` list does not apply); on
	 * tsvector overflow it falls back to per-row writes (with truncate-retry) inside one
	 * transaction, so a single oversized entry can never silently drop the batch.
	 */
	async setMany(tenantId: string, scope: string, entries: SetEntry[]): Promise<void> {
		this.#assertInitialized();
		this.#assertStr(tenantId, "tenantId");
		this.#assertStr(scope, "scope");
		if (!entries?.length) return;

		// last-wins dedupe — duplicate keys in one multi-row upsert would error
		// ("cannot affect row a second time")
		const byKey = new Map<string, SetEntry>();
		for (const e of entries) {
			this.#assertStr(e?.key, "entry.key");
			byKey.set(e.key, e);
		}
		const deduped = [...byKey.values()];

		const { tableName } = this.config;
		const keys: string[] = [];
		const langs: string[] = [];
		const contents: string[] = [];
		const values: (string | undefined)[] = [];
		for (const e of deduped) {
			const lang = this.#resolveLang(e.lang);
			const { content, truncated } = normalizeDoc(
				this.searchable,
				this.config,
				e.fields,
			);
			if (truncated) this.#warnTruncated(tenantId, scope, e.key);
			keys.push(e.key);
			langs.push(lang);
			contents.push(JSON.stringify(content));
			values.push(JSON.stringify(e.value === undefined ? e.fields : e.value));
		}

		// one array per column, zipped by unnest() — six parameters for any row count
		const sql =
			`INSERT INTO ${tableName} (tenant_id, scope, key, lang, content, value)
			SELECT $1::text, $2::text, u.key, u.lang, u.content, u.value
			FROM unnest($3::text[], $4::text[], $5::jsonb[], $6::jsonb[])
				AS u(key, lang, content, value)
			ON CONFLICT (tenant_id, scope, key) DO UPDATE SET
				lang = EXCLUDED.lang,
				content = EXCLUDED.content,
				value = EXCLUDED.value,
				updated_at = NOW()`;
		const params = [tenantId, scope, keys, langs, contents, values];

		// inside a caller's transaction the attempt runs under a savepoint, so an
		// overflow does not abort it and the per-row fallback below can still run
		const oversize = await withTxState(this.#db, async (exec, inTx) => {
			const upsert = () => exec.query(sql, params);
			try {
				await (inTx ? withSavepoint(exec, "fts_many", upsert) : upsert());
				return false;
			} catch (err) {
				if (!isTsvectorOversize(err)) throw err;
				return true;
			}
		});
		if (!oversize) return;

		// atomic per-row fallback: each row gets its own truncate-retry
		this.#logger?.warn?.(
			`fts: setMany batch hit the tsvector byte cap — retrying per-row`,
		);
		await withTx(this.#db, async (c) => {
			for (const e of deduped) {
				await this.#setOn(c, tenantId, scope, e.key, e, true);
			}
		});
	}

	/** Return the stored `value` (or `null` when the row does not exist). */
	async get(tenantId: string, scope: string, key: string): Promise<unknown | null> {
		this.#assertInitialized();
		const { rows } = await this.#db.query(
			`SELECT value FROM ${this.config.tableName}
			WHERE tenant_id = $1 AND scope = $2 AND key = $3`,
			[tenantId, scope, key],
		);
		return rows.length ? rows[0].value : null;
	}

	/** Delete one row. Returns true when a row was actually deleted. */
	async delete(tenantId: string, scope: string, key: string): Promise<boolean> {
		this.#assertInitialized();
		const { rowCount } = await this.#db.query(
			`DELETE FROM ${this.config.tableName}
			WHERE tenant_id = $1 AND scope = $2 AND key = $3`,
			[tenantId, scope, key],
		);
		return (rowCount ?? 0) > 0;
	}

	/** Delete many keys within one `(tenantId, scope)`. Returns the deleted count. */
	async deleteMany(tenantId: string, scope: string, keys: string[]): Promise<number> {
		this.#assertInitialized();
		if (!keys?.length) return 0;
		const { rowCount } = await this.#db.query(
			`DELETE FROM ${this.config.tableName}
			WHERE tenant_id = $1 AND scope = $2 AND key = ANY($3)`,
			[tenantId, scope, keys],
		);
		return rowCount ?? 0;
	}

	/** Delete a whole scope within ONE tenant. Returns the deleted count. */
	async deleteScope(tenantId: string, scope: string): Promise<number> {
		this.#assertInitialized();
		this.#assertStr(tenantId, "tenantId");
		this.#assertStr(scope, "scope");
		const { rowCount } = await this.#db.query(
			`DELETE FROM ${this.config.tableName} WHERE tenant_id = $1 AND scope = $2`,
			[tenantId, scope],
		);
		return rowCount ?? 0;
	}

	/** Delete EVERYTHING belonging to one tenant (loud, tenant-wide). */
	async deleteTenant(tenantId: string): Promise<number> {
		this.#assertInitialized();
		this.#assertStr(tenantId, "tenantId");
		const { rowCount } = await this.#db.query(
			`DELETE FROM ${this.config.tableName} WHERE tenant_id = $1`,
			[tenantId],
		);
		return rowCount ?? 0;
	}

	/** Count rows in a tenant (optionally narrowed to one scope, or several). */
	async count(tenantId: string, scope?: string | string[]): Promise<number> {
		this.#assertInitialized();
		this.#assertStr(tenantId, "tenantId");
		const where = scope === undefined
			? `tenant_id = $1`
			: `tenant_id = $1 AND scope = ANY($2)`;
		const params = scope === undefined
			? [tenantId]
			: [tenantId, this.#resolveScopes(scope)];
		const { rows } = await this.#db.query(
			`SELECT COUNT(*)::int AS count FROM ${this.config.tableName} WHERE ${where}`,
			params,
		);
		return rows[0]?.count ?? 0;
	}

	// -----------------------------------------------------------------------
	// Read path — the real surface: ranked, paginated search
	// -----------------------------------------------------------------------

	/**
	 * Search one `(tenantId, scope)` — or several scopes at once when `scope` is an
	 * array — and return ranked hits.
	 *
	 * - `prefix` (default): index-backed typeahead (`'word':*`). Only sound on
	 *   `simple`-config languages — rejected on stemmed configs (PostgreSQL stems
	 *   BEFORE the prefix is applied, so partial-word prefixes silently miss).
	 * - `exact`: whole-word matching; works on any config (stemmed included).
	 * - `fuzzy`: `pg_trgm` word-similarity (substring + typo tolerance); requires
	 *   the store's `fuzzy` option; threshold via `trgmThreshold` (default 0.6).
	 *   Language-independent: spans every language unless `lang` is given.
	 *
	 * Multi-scope search is the "subtree" primitive for hierarchical scope
	 * conventions (e.g. dotted scopes): enumerate the descendant scopes app-side and
	 * pass them as an array — `scope = ANY(...)` rides the same composite GIN index
	 * as the single-scope path. Scopes are matched literally; there is NO pattern
	 * matching here (a `%` or `*` in a scope is just a character).
	 *
	 * A query that normalizes to zero lexemes returns an empty result (never a
	 * full-scope dump, never a `to_tsquery('')` error). A query beyond the store's
	 * `maxQueryLexemes` / `maxQueryChars` is searched on its leading terms only.
	 */
	async search(
		tenantId: string,
		scope: string | string[],
		query: string,
		opts: SearchOptions = {},
	): Promise<SearchResult> {
		this.#assertInitialized();
		this.#assertStr(tenantId, "tenantId");
		const scopes = this.#resolveScopes(scope);

		const mode = opts.mode ?? "prefix";
		const limit = this.#resolveCount(opts.limit ?? 20, "limit");
		const offset = this.#resolveCount(opts.offset ?? 0, "offset");
		const withTotal = !!opts.withTotal;
		const empty: SearchResult = withTotal
			? { hits: [], total: 0, limit, offset }
			: { hits: [], limit, offset };

		if (typeof query !== "string" || !query.trim().length) return empty;

		if (mode === "fuzzy") {
			return await this.#searchFuzzy(tenantId, scopes, query, {
				limit,
				offset,
				withTotal,
				empty,
				trgmThreshold: opts.trgmThreshold,
				// trigrams carry no language: narrow only when the caller asks to
				lang: opts.lang === undefined ? undefined : this.#resolveLang(opts.lang),
			});
		}
		if (mode !== "prefix" && mode !== "exact") {
			throw new Error(`fts: unknown search mode "${mode}".`);
		}

		const lang = this.#resolveLang(opts.lang);
		const tsConfig = this.config.languages[lang];
		if (mode === "prefix" && tsConfig !== "simple") {
			throw new Error(
				`fts: mode "prefix" is not supported on stemmed language "${lang}" ` +
					`(config "${tsConfig}") — PostgreSQL stems before the prefix is applied, ` +
					`so partial-word prefixes silently miss. Use mode:"exact" or a ` +
					`"simple"-config language.`,
			);
		}

		const rankFn = opts.rankFn ?? "ts_rank_cd";
		if (rankFn !== "ts_rank" && rankFn !== "ts_rank_cd") {
			throw new Error(`fts: unknown rankFn "${rankFn}".`);
		}
		const weights = opts.weights ?? DEFAULT_RANK_WEIGHTS;
		if (
			!Array.isArray(weights) || weights.length !== 4 ||
			weights.some((w) => typeof w !== "number")
		) {
			throw new Error(`fts: weights must be 4 numbers in {D, C, B, A} order.`);
		}

		const { groups, clamped } = clampQueryGroups(
			this.searchable.toQueryGroups(query),
			this.config,
		);
		if (clamped) this.#debugClamped(groups.length);
		// empty-token short-circuit — to_tsquery('') would throw
		const qtext = buildTsquery(groups, mode);
		if (!qtext) return empty;

		const { tableName } = this.config;
		const col = `tsv_${lang}`; // lang is whitelisted; never raw user input

		const { rows } = await this.#db.query(
			`SELECT key, scope, value, ${rankFn}($1::float4[], ${col}, q)::float8 AS rank
			FROM ${tableName}, to_tsquery($2::regconfig, $3) q
			WHERE tenant_id = $4 AND scope = ANY($5) AND ${col} @@ q
			ORDER BY rank DESC, updated_at DESC, scope ASC, key ASC
			LIMIT $6 OFFSET $7`,
			[weights, tsConfig, qtext, tenantId, scopes, limit, offset],
		);
		const hits = rows.map((r) => ({
			key: r.key as string,
			scope: r.scope as string,
			value: r.value as unknown,
			rank: Number(r.rank),
		}));

		if (!withTotal) return { hits, limit, offset };

		const { rows: cnt } = await this.#db.query(
			`SELECT COUNT(*)::int AS count
			FROM ${tableName}, to_tsquery($1::regconfig, $2) q
			WHERE tenant_id = $3 AND scope = ANY($4) AND ${col} @@ q`,
			[tsConfig, qtext, tenantId, scopes],
		);
		return { hits, total: cnt[0]?.count ?? 0, limit, offset };
	}

	/**
	 * Fuzzy (`pg_trgm`) search via WORD-similarity (`$q <% fts_trgm`) — scores the
	 * query against the best-matching substring window, so a short query matches a
	 * long document (whole-string `similarity()`/`%` would silently miss it).
	 *
	 * The `<%` operator takes no per-query threshold — the boundary is the
	 * `pg_trgm.word_similarity_threshold` GUC — so it is scoped to these statements by
	 * `withLocalSetting`: transaction-local on a pinned pool connection, set-and-restored
	 * on a caller's `pg.Client` (never leaks, and never commits a caller's transaction).
	 */
	async #searchFuzzy(
		tenantId: string,
		scopes: string[],
		query: string,
		o: {
			limit: number;
			offset: number;
			withTotal: boolean;
			empty: SearchResult;
			trgmThreshold?: number;
			lang?: string;
		},
	): Promise<SearchResult> {
		if (!this.config.fuzzy) {
			throw new Error(
				`fts: fuzzy mode is disabled for this store (construct with fuzzy:true).`,
			);
		}
		const threshold = o.trgmThreshold ?? 0.6;
		if (typeof threshold !== "number" || !(threshold > 0 && threshold <= 1)) {
			throw new Error(`fts: trgmThreshold must be a number in (0, 1].`);
		}

		// same normalization brain as the write side (accent/case folding parity)
		const { groups, clamped } = clampQueryGroups(
			this.searchable.toWords(query, true).map((w) => [w]),
			this.config,
		);
		if (clamped) this.#debugClamped(groups.length);
		const qNorm = groups.flat().join(" ");
		if (!qNorm) return o.empty;

		const { tableName } = this.config;
		const params = [qNorm, tenantId, scopes];
		let where = `tenant_id = $2 AND scope = ANY($3) AND $1 <% fts_trgm`;
		if (o.lang !== undefined) {
			params.push(o.lang);
			where += ` AND lang = $${params.length}`;
		}
		const n = params.length;

		return await withLocalSetting(
			this.#db,
			"pg_trgm.word_similarity_threshold",
			String(threshold),
			async (c) => {
				const { rows } = await c.query(
					`SELECT key, scope, value, word_similarity($1, fts_trgm)::float8 AS rank
					FROM ${tableName}
					WHERE ${where}
					ORDER BY rank DESC, updated_at DESC, scope ASC, key ASC
					LIMIT $${n + 1} OFFSET $${n + 2}`,
					[...params, o.limit, o.offset],
				);
				const hits = rows.map((r) => ({
					key: r.key as string,
					scope: r.scope as string,
					value: r.value as unknown,
					rank: Number(r.rank),
				}));

				if (!o.withTotal) return { hits, limit: o.limit, offset: o.offset };

				const { rows: cnt } = await c.query(
					`SELECT COUNT(*)::int AS count FROM ${tableName} WHERE ${where}`,
					params,
				);
				return {
					hits,
					total: cnt[0]?.count ?? 0,
					limit: o.limit,
					offset: o.offset,
				};
			},
		);
	}

	// -----------------------------------------------------------------------
	// internals
	// -----------------------------------------------------------------------

	/**
	 * Upsert one row on the given executor, with the oversize safety net: the tsvector
	 * byte cap (~1MB, SQLSTATE 54000) is driven by distinct-lexeme count, so a doc can
	 * overflow even under the char budget. Per `onOversize`, either halve the budgets
	 * and retry ("truncate") or surface a clear error ("throw").
	 *
	 * When running inside an open transaction (`inTx` — the store's own, or one the
	 * caller holds on a `pg.Client`), each attempt is wrapped in a SAVEPOINT — a failed
	 * statement aborts a plain transaction, so retrying is only possible after
	 * `ROLLBACK TO SAVEPOINT`.
	 */
	async #setOn(
		exec: PgExecutor,
		tenantId: string,
		scope: string,
		key: string,
		doc: FtsDoc,
		inTx = false,
	): Promise<void> {
		const { tableName, onOversize } = this.config;
		const lang = this.#resolveLang(doc.lang);
		const value = JSON.stringify(doc.value === undefined ? doc.fields : doc.value);

		let scale = 1;
		for (;;) {
			const { content, truncated } = normalizeDoc(
				this.searchable,
				this.config,
				doc.fields,
				scale,
			);
			if (truncated) this.#warnTruncated(tenantId, scope, key);
			const upsert = () =>
				exec.query(
					`INSERT INTO ${tableName} (tenant_id, scope, key, lang, content, value)
					VALUES ($1, $2, $3, $4, $5, $6)
					ON CONFLICT (tenant_id, scope, key) DO UPDATE SET
						lang = EXCLUDED.lang,
						content = EXCLUDED.content,
						value = EXCLUDED.value,
						updated_at = NOW()`,
					[tenantId, scope, key, lang, JSON.stringify(content), value],
				);
			try {
				// the savepoint un-aborts the surrounding transaction on failure
				await (inTx ? withSavepoint(exec, "fts_set", upsert) : upsert());
				return;
			} catch (err) {
				if (!isTsvectorOversize(err)) throw err;
				if (onOversize === "throw") {
					throw new Error(
						`fts: document ("${tenantId}", "${scope}", "${key}") exceeds the ` +
							`tsvector byte cap (~1MB) even after budgets. Reduce the indexed ` +
							`text or use onOversize:"truncate".`,
						{ cause: err },
					);
				}
				scale /= 2;
				if (scale < 1 / 64) {
					throw new Error(
						`fts: could not truncate document ("${tenantId}", "${scope}", ` +
							`"${key}") under the tsvector byte cap.`,
						{ cause: err },
					);
				}
				this.#logger?.warn?.(
					`fts: tsvector byte cap hit for ("${tenantId}", "${scope}", "${key}") ` +
						`— re-truncating at scale ${scale}`,
				);
			}
		}
	}

	#assertInitialized(): void {
		if (!this.#initialized) {
			throw new Error("fts: not initialized (call `initialize()` first).");
		}
	}

	/**
	 * `limit` / `offset` as an integer PostgreSQL accepts as a bigint: floored and
	 * clamped to `[0, Number.MAX_SAFE_INTEGER]` (so `Infinity` reads as "no limit").
	 * `NaN` has no such reading and is rejected here rather than by the database.
	 */
	#resolveCount(value: number, what: string): number {
		if (typeof value !== "number" || Number.isNaN(value)) {
			throw new Error(`fts: ${what} must be a number.`);
		}
		return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
	}

	#assertStr(value: string, what: string): void {
		if (typeof value !== "string" || !value.length) {
			throw new Error(`fts: ${what} must be a non-empty string.`);
		}
	}

	/**
	 * Normalize the read-path `scope` argument (`string | string[]`) into a validated,
	 * deduped, non-empty array of literal scope values (fed to `scope = ANY(...)`).
	 */
	#resolveScopes(scope: string | string[]): string[] {
		if (!Array.isArray(scope)) {
			this.#assertStr(scope, "scope");
			return [scope];
		}
		if (!scope.length) {
			throw new Error(`fts: scope array must contain at least one scope.`);
		}
		for (const s of scope) this.#assertStr(s, "scope");
		return [...new Set(scope)];
	}

	/** Whitelist the language key (the dead-\`__tsv_en\` scar — never guess a column). */
	#resolveLang(lang?: string): string {
		const resolved = lang ?? this.config.defaultLang;
		if (!(resolved in this.config.languages)) {
			throw new Error(
				`fts: unknown lang "${resolved}". Configured: ` +
					`${Object.keys(this.config.languages).join(", ")}.`,
			);
		}
		return resolved;
	}

	#warnTruncated(tenantId: string, scope: string, key: string): void {
		this.#logger?.warn?.(
			`fts: indexed text truncated for ("${tenantId}", "${scope}", "${key}") ` +
				`(maxIndexedChars/maxIndexedLexemes) — full \`value\` is preserved`,
		);
	}

	#debugClamped(kept: number): void {
		this.#logger?.debug?.(
			`fts: query exceeded maxQueryLexemes/maxQueryChars — searching its first ` +
				`${kept} term(s) only`,
		);
	}

	/**
	 * Refuse a pre-existing table created for a different `fields`/`languages`/`fuzzy`
	 * (see `diffSchema`). Unused leftover columns are only warned about.
	 */
	async #verifySchema(exec: PgExecutor): Promise<void> {
		const { tableName } = this.config;
		const { rows } = await exec.query(GENERATED_COLUMNS_SQL, [tableName]);
		const { errors, extras } = diffSchema(this.config, rows);
		if (extras.length) {
			this.#logger?.warn?.(
				`fts: table "${tableName}" has generated column(s) this store's ` +
					`configuration does not use: ${extras.join(", ")}`,
			);
		}
		if (errors.length) {
			throw new Error(
				`fts: table "${tableName}" was created for a different configuration ` +
					`(schema drift): ${
						errors.join("; ")
					}. \`fields\`, \`languages\` and ` +
					`\`fuzzy\` are baked into generated columns when the table is created — ` +
					`migrate the table (in development: destroy(true) + initialize()), or ` +
					`pass { verifySchema: false } to skip this check.`,
			);
		}
	}

	async #createExtensions(exec: PgExecutor): Promise<void> {
		try {
			await exec.query(buildExtensionsSql(this.config));
		} catch (err) {
			const needed = this.config.fuzzy ? "btree_gin, pg_trgm" : "btree_gin";
			throw new Error(
				`fts: failed to create required extension(s) (${needed}). The database role ` +
					`likely lacks privilege — ask a superuser to install them, then construct the ` +
					`store with { manageExtensions: false }. Original error: ` +
					`${(err as Error)?.message ?? err}`,
			);
		}
	}
}

/** Create an {@link Fts} store. Call `initialize()` once before use. */
export function createFts(options: FtsOptions): Fts {
	return new Fts(options);
}
