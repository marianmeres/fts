# @marianmeres/fts

[![NPM version](https://img.shields.io/npm/v/@marianmeres/fts.svg)](https://www.npmjs.com/package/@marianmeres/fts)
[![JSR version](https://jsr.io/badges/@marianmeres/fts)](https://jsr.io/@marianmeres/fts)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A standalone, PostgreSQL-backed full-text search primitive that presents as a
**tenant-scoped, searchable key-value store** — fast, ranked, predictable, and with no
third-party search engine. It's just a Postgres table.

- **Write like a KV store**: `set(tenant, scope, key, doc)` / `get` / `delete`.
- **Search like an engine**: ranked, weighted (title > body > tags), paginated;
  `prefix` (typeahead), `exact`, and opt-in `fuzzy` (typo-tolerant) modes.
- **Predictable by design**: normalization (case/accent folding, stopwords) happens
  app-side via [@marianmeres/searchable](https://github.com/marianmeres/searchable)
  — identically at write and query time — and PostgreSQL matches against generated
  `tsvector` columns backed by composite `btree_gin` indexes. PostgreSQL's parser
  does re-split compound tokens (`pump_carb`, `well-known`) on both sides; see the
  [normalization parity notes](API.md#normalization-parity-the-core-invariant) for
  the edge cases that follow.
- **Multi-tenant safe**: `tenant_id` is part of the primary key, every index, and a
  required argument of every method — no operation can cross tenants.

## Requirements

- PostgreSQL with the `btree_gin` extension (and `pg_trgm` for fuzzy mode). The store
  creates them automatically when the role has privilege; otherwise have a DBA run
  `CREATE EXTENSION btree_gin; CREATE EXTENSION pg_trgm;` once and construct the store
  with `manageExtensions: false`.
- A [pg](https://www.npmjs.com/package/pg) `Pool` or `Client`.

## Installation

```shell
deno add jsr:@marianmeres/fts
```

```shell
npm i @marianmeres/fts
```

## Usage

```typescript
import pg from "pg";
import { createFts } from "@marianmeres/fts";

const db = new pg.Pool({/* connection */});
const fts = createFts({ db });
await fts.initialize(); // idempotent: creates table + indexes

// write (KV-shaped) — tenantId, scope, key
await fts.set("_default", "articles", "a1", {
	fields: { title: "Hello World", body: "The quick brown fox..." },
	value: { id: "a1", url: "/articles/hello-world" }, // opaque payload
});

// ranked, paginated search (prefix/typeahead by default)
const { hits } = await fts.search("_default", "articles", "hel");
// [{ key: "a1", scope: "articles", value: { id: "a1", url: "..." }, rank: 1 }]

// exact, fuzzy (typo-tolerant, opt-in per query), pagination, total
await fts.search("_default", "articles", "world", { mode: "exact" });
await fts.search("_default", "articles", "helo wrld", { mode: "fuzzy" });
await fts.search("_default", "articles", "fox", {
	limit: 20,
	offset: 20,
	withTotal: true,
});
```

Field weights (`title=A, body=B, tags=C` by default) and languages are configurable
per store:

```typescript
const fts = createFts({
	db,
	fields: { name: "A", description: "B", notes: "D" },
	languages: { en: "english", sk: "simple" }, // lang key → PG text search config
	defaultLang: "sk",
});
```

> **Note on stemming:** `simple` (no stemming) is the default and keeps `prefix`
> search predictable. Stemmed configs (like `english`) are an explicit opt-in and only
> support `exact` mode — PostgreSQL stems before the prefix is applied, so
> partial-word prefixes would silently miss. See [API.md](API.md) for details.

## Hierarchical scopes ("wildcard" lookups)

`scope` is opaque text matched literally — the store imposes no structure on it. To
model a hierarchy, adopt a naming convention (dots work well), and where you'd reach
for a wildcard, pass an **array of scopes** instead — one query, hits report which
scope they came from:

```typescript
await fts.set("_default", "articles.news", "n1", {
	fields: { title: "Quantum leap" },
});
await fts.set("_default", "articles.news.tech", "t1", {
	fields: { title: "Quantum chip" },
});
await fts.set("_default", "articles.blog", "b1", {
	fields: { title: "Quantum diary" },
});

// "articles.news.*" — enumerate the subtree app-side, search it in one query
const { hits } = await fts.search(
	"_default",
	["articles.news", "articles.news.tech"],
	"quantum",
);
// one ranked list across both scopes (equal ranks tie-break by recency):
// [{ key: "t1", scope: "articles.news.tech", ... },
//  { key: "n1", scope: "articles.news", ... }]

// count works the same way
await fts.count("_default", ["articles.news", "articles.news.tech"]); // 2
```

There is no pattern matching in scopes — `%` and `*` are literal characters. Your app
defines the tree, so it can enumerate the concrete scopes it wants searched. This is
deliberate: literal `= ANY` matching rides the same composite index as single-scope
search, while SQL `LIKE` cannot use that index at all, and byte-range prefix tricks
silently return wrong rows under common collations — see the
[hierarchical scopes notes](API.md#hierarchical-scopes-the-dotted-convention) in
API.md.

## Example app

A runnable end-to-end demo — REST server + browser client searching ~2.5k movies,
exercising all three modes (with rank display and match highlighting) — lives in
[example/](example/):

```shell
deno task example
```

## API

See [API.md](API.md) for complete API documentation.

## License

[MIT](LICENSE)
