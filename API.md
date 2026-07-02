# API

Complete API reference for `@marianmeres/fts`.

- [Factory & class](#factory--class)
  - [`createFts(options)`](#createftsoptions)
  - [`Fts`](#fts)
- [Lifecycle](#lifecycle)
  - [`initialize()`](#initialize)
  - [`destroy(hard?)`](#destroyhard)
- [Write](#write)
  - [`set(tenantId, scope, key, doc)`](#settenantid-scope-key-doc)
  - [`setMany(tenantId, scope, entries)`](#setmanytenantid-scope-entries)
  - [`delete(tenantId, scope, key)`](#deletetenantid-scope-key)
  - [`deleteMany(tenantId, scope, keys)`](#deletemanytenantid-scope-keys)
  - [`deleteScope(tenantId, scope)`](#deletescopetenantid-scope)
  - [`deleteTenant(tenantId)`](#deletetenanttenantid)
- [Read](#read)
  - [`get(tenantId, scope, key)`](#gettenantid-scope-key)
  - [`search(tenantId, scope, query, opts?)`](#searchtenantid-scope-query-opts)
  - [`count(tenantId, scope?)`](#counttenantid-scope)
- [Types](#types)
- [Constants](#constants)
- [Behavior notes](#behavior-notes)

---

## Factory & class

### `createFts(options)`

Creates an [`Fts`](#fts) store. Call [`initialize()`](#initialize) once before use.

**Parameters** (`FtsOptions`):

| Option | Type | Default | Description |
|---|---|---|---|
| `db` | `pg.Pool \| pg.Client` | — (required) | PostgreSQL connection. |
| `tableName` | `string` | `"__fts"` | Table name; may carry one `schema.` prefix (e.g. `"public.__fts"`). Word characters only. |
| `logger` | `Logger` | `createClog("fts")` | [@marianmeres/clog](https://github.com/marianmeres/clog)-compatible logger. |
| `fields` | `Record<string, "A"\|"B"\|"C"\|"D">` | `{ title:"A", body:"B", tags:"C" }` | Field → rank-weight map. **Baked into the generated-column DDL at `initialize()`** — changing it later is a schema change. Only listed fields are indexed. |
| `languages` | `Record<string, string>` | `{ default: "simple" }` | Language key → PostgreSQL text search config. Each key gets its own generated `tsv_<key>` column and composite index. |
| `defaultLang` | `string` | first key of `languages` | Language used when `set`/`search` omit `lang`. |
| `fuzzy` | `boolean` | `true` | Provision the `pg_trgm` column + index for fuzzy mode. |
| `manageExtensions` | `boolean` | `true` | Run `CREATE EXTENSION IF NOT EXISTS btree_gin` (+ `pg_trgm` when `fuzzy`) in `initialize()`. Set `false` when a DBA pre-provisions extensions (a least-privilege role cannot create missing extensions). |
| `maxIndexedChars` | `number` | `1_000_000` | Coarse per-document character budget for indexed text. |
| `maxIndexedLexemes` | `number` | `10_000` | Per-field cap on distinct indexed tokens — the actual driver of tsvector byte size. |
| `onOversize` | `"truncate" \| "throw"` | `"truncate"` | Behavior when a document still overflows PostgreSQL's ~1MB tsvector byte cap (see [Behavior notes](#behavior-notes)). |
| `searchable` | `Searchable \| Partial<SearchableOptions>` | `new Searchable()` | The normalization brain ([@marianmeres/searchable](https://github.com/marianmeres/searchable)); used identically at write and query time. |

**Returns:** `Fts`

**Example:**

```typescript
import pg from "pg";
import { createFts } from "@marianmeres/fts";

const fts = createFts({ db: new pg.Pool({ /* ... */ }) });
await fts.initialize();
```

### `Fts`

The store class. Public readonly members:

- `config: ResolvedFtsConfig` — the fully-resolved, frozen configuration.
- `searchable: Searchable` — the shared normalization instance.
- `initialized: boolean` — whether `initialize()` has completed.

Every data method takes **`tenantId` as a required first argument** — `tenant_id` is
part of the primary key `(tenant_id, scope, key)`, every index, and every `WHERE`
clause, so no operation can cross tenants. It is a plain `VARCHAR(255)` (not a foreign
key); single-tenant apps just pass [`DEFAULT_TENANT_ID`](#constants).

---

## Lifecycle

### `initialize()`

Provisions the schema idempotently (`CREATE TABLE/INDEX IF NOT EXISTS`): the table,
one generated weighted `tsv_<lang>` tsvector column per configured language, a
composite `gin (tenant_id, scope, tsv_<lang>)` index per language (via `btree_gin`),
and — when `fuzzy` — a generated `fts_trgm` text column with a composite
`gin_trgm_ops` index.

**Returns:** `Promise<void>`

Throws a descriptive error when `manageExtensions` is on and the role cannot create a
missing extension (remedy: superuser installs it once, then `manageExtensions: false`).

### `destroy(hard?)`

Resets lifecycle state. `destroy(true)` drops the table (and its indexes).

**Parameters:** `hard` (boolean, default `false`)

**Returns:** `Promise<void>`

---

## Write

### `set(tenantId, scope, key, doc)`

Upserts one document.

**Parameters:**

- `tenantId` (string) — tenant, non-empty.
- `scope` (string) — logical bucket within the tenant (namespace/type).
- `key` (string) — identity within the scope.
- `doc` ([`FtsDoc`](#types)):
  - `fields` (Record<string, string>) — raw text per field. Only fields configured in
    `fields` are indexed (normalized app-side into the `content` column); anything else
    is preserved in `value` only.
  - `value` (unknown, optional) — opaque payload returned by `get`/`search`.
    **Defaults to `fields`** when omitted.
  - `lang` (string, optional) — whitelisted language key; defaults to `defaultLang`.

**Returns:** `Promise<void>`

**Example:**

```typescript
await fts.set("_default", "products", "p1", {
	fields: { title: "Cordless Drill", body: "18V, two batteries included" },
	value: { sku: "p1", price: 129 },
});
```

### `setMany(tenantId, scope, entries)`

Upserts many documents in one statement — **atomic** (all land or none). Duplicate
keys within `entries` are deduplicated last-wins. If one oversized entry trips the
tsvector byte cap, the batch falls back to per-row writes (each with truncate-retry)
inside a single transaction — one bad entry can never silently drop the batch.

**Parameters:** `entries` ([`SetEntry[]`](#types) — `FtsDoc` + `key`)

**Returns:** `Promise<void>`

### `delete(tenantId, scope, key)`

**Returns:** `Promise<boolean>` — `true` when a row was actually deleted.

### `deleteMany(tenantId, scope, keys)`

**Returns:** `Promise<number>` — count of rows actually deleted.

### `deleteScope(tenantId, scope)`

Deletes a whole scope **within one tenant** (the same scope name under other tenants
is untouched).

**Returns:** `Promise<number>`

### `deleteTenant(tenantId)`

Deletes **everything** belonging to one tenant, across all its scopes. Deliberately
loud — this is the only tenant-wide bulk operation.

**Returns:** `Promise<number>`

---

## Read

### `get(tenantId, scope, key)`

**Returns:** `Promise<unknown | null>` — the stored `value`, or `null` when absent.

### `search(tenantId, scope, query, opts?)`

Ranked, paginated full-text search within one `(tenantId, scope)`.

**Parameters** (`SearchOptions`):

| Option | Type | Default | Description |
|---|---|---|---|
| `lang` | `string` | store `defaultLang` | Whitelisted language key — selects the `tsv_<lang>` column. |
| `mode` | `"prefix" \| "exact" \| "fuzzy"` | `"prefix"` | See modes below. |
| `limit` | `number` | `20` | Page size. |
| `offset` | `number` | `0` | Page offset. |
| `withTotal` | `boolean` | `false` | Also compute the total match count (extra `COUNT(*)`). |
| `rankFn` | `"ts_rank" \| "ts_rank_cd"` | `"ts_rank_cd"` | Ranking function (`_cd` = cover-density, proximity-aware). |
| `weights` | `[number, number, number, number]` | `[0.1, 0.2, 0.4, 1.0]` | Rank weights in PostgreSQL's **`{D, C, B, A}`** order. |
| `trgmThreshold` | `number` | `0.6` | Fuzzy only: `pg_trgm` word-similarity threshold in `(0, 1]`, applied per query. |

**Modes:**

- **`prefix`** (default) — index-backed typeahead: every query word matches as a
  prefix (`'wor':*`). Multi-word queries are AND-ed; `normalizeWord` expansions from
  `searchable` are OR-ed within their group. Only sound on `simple`-config languages —
  **rejected with an error on stemmed configs** (PostgreSQL stems *before* the prefix
  applies: stored `universities` becomes lexeme `univers`, so `universit:*` would
  silently miss).
- **`exact`** — whole-word matching; works on any config, including stemmed ones
  (`runs` matches stored `running` on an `english` column).
- **`fuzzy`** — `pg_trgm` **word-similarity** (`query <% document`): typo-tolerant and
  substring-capable; a short query matches a long document. Requires the store's
  `fuzzy` option. Never the default.

**Returns:** `Promise<SearchResult>`:

```typescript
{
	hits: { key: string; value: unknown; rank: number }[],
	total?: number,   // only when withTotal
	limit: number,
	offset: number,
}
```

Order: `rank DESC, updated_at DESC, key ASC` (deterministic tiebreak).

A query that normalizes to zero lexemes (empty, whitespace-only, all-stopwords)
returns an empty result — never a full-scope dump, never an error.

**Example:**

```typescript
const r = await fts.search("_default", "products", "drill", {
	mode: "exact",
	withTotal: true,
});
// { hits: [{ key: "p1", value: {...}, rank: 0.6 }], total: 1, limit: 20, offset: 0 }
```

### `count(tenantId, scope?)`

**Returns:** `Promise<number>` — rows in the tenant, optionally narrowed to a scope.

---

## Types

```typescript
type FtsWeight = "A" | "B" | "C" | "D"; // A strongest

interface FtsDoc {
	fields: Record<string, string>; // raw text; normalized app-side
	value?: unknown;                // opaque payload; defaults to `fields`
	lang?: string;                  // whitelisted; defaults to store defaultLang
}

interface SetEntry extends FtsDoc {
	key: string;
}

type SearchMode = "prefix" | "exact" | "fuzzy";

interface SearchHit {
	key: string;
	value: unknown;
	rank: number;
}

interface SearchResult {
	hits: SearchHit[];
	total?: number; // only when withTotal
	limit: number;
	offset: number;
}

type OnOversize = "truncate" | "throw";

/** Minimal executor seam — any driver exposing this works. */
type PgExecutor = {
	query: (
		sql: string,
		params?: any[],
	) => Promise<{ rows: any[]; rowCount: number | null }>;
};
```

See [`FtsOptions`](#createftsoptions) above; `ResolvedFtsConfig` is the frozen,
validated form of it exposed as `fts.config`.

---

## Constants

| Constant | Value | Description |
|---|---|---|
| `DEFAULT_TENANT_ID` | `"_default"` | The `tenant_id` column default; pass it explicitly in single-tenant apps. |
| `DEFAULT_TABLE_NAME` | `"__fts"` | Default table name. |
| `DEFAULT_LANG` | `"default"` | Default language key. |
| `DEFAULT_TS_CONFIG` | `"simple"` | Default text search config (no stemming/stopwords). |
| `DEFAULT_FIELDS` | `{ title:"A", body:"B", tags:"C" }` | Default field→weight map. |

---

## Behavior notes

### Normalization parity (the core invariant)

The same `Searchable` instance normalizes text at write time (`content` column) and
query time (tsquery), and both sides use the same explicit PostgreSQL config — so
write and query lexemes always agree *within PostgreSQL*. Nuance: PostgreSQL's parser
re-splits compound tokens that searchable's `nonWordCharWhitelist` (`"@-"`) keeps
whole — `well-known` is stored as `well`, `known` **and** `well-known` — so interior
sub-token queries (`known`) match in fts even though standalone searchable would not.
This is more permissive, not less.

### tsvector byte cap (~1MB)

PostgreSQL hard-errors when a row's tsvector exceeds 1,048,575 bytes; the size is
driven by **distinct-lexeme count**, not character count. Protection is layered:
`maxIndexedChars` + `maxIndexedLexemes` budgets truncate the indexed text up front
(the full `value` is always preserved untouched), and if a write still overflows,
`onOversize: "truncate"` (default) halves the budgets and retries until it fits, while
`"throw"` surfaces a clear error. Truncations are logged via `logger.warn`.

### Performance shape

`WHERE tenant_id = $1 AND scope = $2 AND tsv @@ query` is answered by a **single
bitmap index scan** on the composite `btree_gin` index (measured on PostgreSQL 18 with
1M rows in one scope: low single-digit ms for selective queries). Ranking cost scales
with the *match-set* size, not the scope size — a query matching tens of thousands of
rows must rank them all before `LIMIT` applies (GIN stores no positions). Prefer
selective queries; `LIMIT/OFFSET` pagination is not stable across concurrent writes to
the same scope.

### Changing `fields` / `languages` later

Both are baked into generated-column DDL at `initialize()`. To change them on an
existing table you must migrate the schema (in development, `destroy(true)` +
`initialize()`).
