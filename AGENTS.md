# @marianmeres/fts — Agent Guide

PostgreSQL-backed full-text search presenting as a tenant-scoped, searchable KV store.
No external search engine — one PG table with generated tsvector columns.

## Quick Reference

- **Stack**: Deno-first TypeScript, dual-published to JSR + npm (via `@marianmeres/npmbuild`); PostgreSQL (`pg` Pool/Client), `@marianmeres/searchable` (normalization), `@marianmeres/clog` (logging).
- **Test**: `deno task test` (needs a real PG — see [Testing](#testing)) | **Build (npm)**: `deno task npm:build` | **Format**: `deno fmt src tests` | **Lint**: `deno lint src tests`

## Project Structure

```
src/mod.ts        — barrel (public surface only)
src/fts.ts        — createFts() + Fts class: config resolution, lifecycle, CRUD, search
src/types.ts      — public types + DEFAULT_* constants
src/_schema.ts    — config-driven DDL builders + identifier validation (internal)
src/_normalize.ts — searchable wiring: normalizeDoc(), budgets, oversize detection (internal)
src/_tsquery.ts   — query groups → safe tsquery string (internal)
src/_pg.ts        — PgExecutor seam, isPool/acquireClient/withTx (internal)
tests/_pg.ts      — createPg() from TEST_PG_* env
tests/_fts.ts     — makeFts/freshStore/withStore helpers, noopLogger
example/          — movie search playground (demino REST server + vanilla client); `deno task example`, see example/README.md
tmp/              — initial spec, implementation plan, spike results (git-ignored, local only)
```

`_`-prefixed src modules are internal; everything public is re-exported from `src/mod.ts`.

## DB Schema

One table (default `__fts`), self-provisioned by `initialize()` (`IF NOT EXISTS`, idempotent; no @marianmeres/migrate):

| Column                      | Type                                       | Notes                                                                                                |
| --------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `tenant_id`                 | `VARCHAR(255) NOT NULL DEFAULT '_default'` | Hard isolation axis; NOT a FK (matches cron).                                                        |
| `scope`                     | `TEXT NOT NULL`                            | Logical bucket within a tenant.                                                                      |
| `key`                       | `TEXT NOT NULL`                            | Identity within scope. **PK = (tenant_id, scope, key)**.                                             |
| `lang`                      | `VARCHAR(32)`                              | Selects which `tsv_<lang>` populates (CASE guard in the generated column).                           |
| `content`                   | `JSONB NOT NULL`                           | App-normalized (searchable) field text — the tsvector source.                                        |
| `value`                     | `JSONB`                                    | Opaque payload returned to callers.                                                                  |
| `tsv_<lang>`                | `tsvector GENERATED ... STORED`            | One per configured language; weighted `setweight(to_tsvector('<cfg>', content->>'<field>'), '<W>')`. |
| `fts_trgm`                  | `text GENERATED ... STORED`                | Concatenated fields for pg_trgm (only when `fuzzy`).                                                 |
| `created_at` / `updated_at` | `TIMESTAMPTZ DEFAULT NOW()`                | `updated_at` bumped on every upsert.                                                                 |

Indexes: `idx_<safe(tableName)>_tsv_<lang>` = `gin (tenant_id, scope, tsv_<lang>)` (needs `btree_gin`); `idx_<safe(tableName)>_trgm` = `gin (tenant_id, scope, fts_trgm gin_trgm_ops)`. `safe()` = `\W → _`.

## Critical Conventions

1. **Tenant isolation is structural**: `tenantId` is a required positional first arg on EVERY data method and appears in every `WHERE`. Never add a method that omits it (cross-tenant purge must be a distinct, loud method like `deleteTenant`).
2. **Normalization parity**: ONE `Searchable` instance (`fts.searchable`) at write (`toWords`) and query (`toQueryGroups`) time; the same explicit PG config on both sides (generated column and `to_tsquery($cfg::regconfig, ...)`). Never normalize differently on one side. NOTE: PG's text-search parser is a SECOND tokenizer running after searchable on BOTH sides — `to_tsquery` re-parses even quoted lexemes (compounds like `pump_carb` become adjacency phrases; quoting stops operator injection, not re-tokenization). Parity holds only because both sides share the same two-tokenizer chain; semantics are pinned by `tests/parity-compound.test.ts`, human-facing detail in API.md → "Normalization parity".
3. **Safe tsquery**: lexemes quoted (`'` doubled) in `_tsquery.ts`; the assembled string + config are BOUND as params. Zero-lexeme queries short-circuit to an empty result (`to_tsquery('')` throws).
4. **Language whitelist**: `lang` is validated against configured `languages` keys before touching SQL — `tsv_<lang>` is spliced, never from raw input. Same for `tableName`/fields/configs (validated identifiers; DDL has no bind params).
5. **`prefix` mode only on `simple` configs**: PG stems before applying `:*`, so prefix on a stemmed column silently misses — `search()` rejects that combination; `exact` works on stemmed.
6. **tsvector ~1MB byte cap** (SQLSTATE 54000, driven by distinct-lexeme count): budgets truncate up-front; writes catch 54000 and halve-and-retry (`onOversize:"truncate"`) or throw. Inside a transaction, each retry attempt MUST be wrapped in `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` (a failed statement aborts a plain tx) — see `#setOn(..., inTx)`.
7. **Fuzzy = word-similarity**: `$q <% fts_trgm` (+ `word_similarity()` rank), never whole-string `%`/`similarity()` (short queries over long docs score ~0 and miss). The threshold is a GUC — set per-transaction via `set_config('pg_trgm.word_similarity_threshold', $1, true)` on a pinned connection (`withTx`), never session-wide on a pool.
8. **kv-style pg conventions**: `db: pg.Pool | pg.Client` option; positional `$n` params; `{rows, rowCount}`; upsert = `INSERT ... ON CONFLICT ... DO UPDATE SET ..., updated_at = NOW()`; Pool detected via `totalCount`; `logger?.level?.(...)` defensive calls; tabs, lineWidth 90.
9. `fields`/`languages` are frozen into generated-column DDL at `initialize()` — changing them is a schema change, not a config tweak.

## Testing

Real PostgreSQL (no mocks). `tests/_pg.ts` reads `TEST_PG_HOST/PORT/DATABASE/USER/PASSWORD` (see `.env.example`; `deno task test` = `deno test -A --env-file`). Extensions `btree_gin` + `pg_trgm` must exist in the test DB (superuser installs once; `CREATE EXTENSION IF NOT EXISTS` then no-ops for the test role). Each test uses `withStore()` → fresh table (`destroy(true)` + `initialize()`), own `tableName`, silent logger, `db.end()` cleanup. 66 tests across `fts` (CRUD + oversize), `schema` (DDL introspection), `search`, `parity-compound` (two-tokenizer round-trips + characterized edges), `language`, `fuzzy`, `tenant` (isolation).

## Key Exports

`createFts(options)`, `Fts`, `DEFAULT_TENANT_ID`/`DEFAULT_TABLE_NAME`/`DEFAULT_LANG`/`DEFAULT_TS_CONFIG`/`DEFAULT_FIELDS`, `PgExecutor`, and types (`FtsOptions`, `FtsDoc`, `SetEntry`, `SearchOptions`, `SearchResult`, `SearchHit`, `SearchMode`, `FtsWeight`, `OnOversize`, `ResolvedFtsConfig`). Human docs: [README.md](README.md), [API.md](API.md).

## Before Making Changes

- [ ] Read the invariants above — esp. tenant isolation (1), parity (2), and the 54000/SAVEPOINT mechanics (6).
- [ ] `deno task test` against a real PG before and after.
- [ ] `deno fmt src tests && deno lint src tests`.
- [ ] New public surface → export from `src/mod.ts`, document in [API.md](API.md), keep README example-level only.
- [ ] Design rationale & measured numbers live in `tmp/implementation-plan.md` and `tmp/spike/RESULTS.md` (local only, git-ignored). Key takeaways if absent: PG18 benchmark showed the composite btree_gin resolves to a single bitmap index scan (1M-row scope, low ms); ranking cost scales with match-set size, not scope size.
