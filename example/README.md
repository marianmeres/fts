# Example — movie search playground

A small end-to-end demo of `@marianmeres/fts` on real-world data: a
[demino](https://github.com/marianmeres/demino) server with a trivial REST api and a
[@marianmeres/vanilla](https://github.com/marianmeres/vanilla) single-page client.

On first boot the server seeds ~2.5k movies (title, tagline, overview, people, genres)
into the `fts_movies` database; subsequent boots detect the data and skip the seed. The
client is a search-as-you-type playground exercising all three search modes (`prefix`,
`exact`, `fuzzy` incl. the word-similarity threshold), rank display and paging.

## Prerequisites

1. A running PostgreSQL reachable via the `EXAMPLE_PG_*` env vars (see
   [`.env.example`](../.env.example) — copy to `.env` and fill in if you haven't).
2. The configured database — `fts_movies` by default (it is NOT auto-created):

   ```sh
   psql -h localhost -U dbuser -d postgres -c 'CREATE DATABASE fts_movies'
   ```

   The `btree_gin` + `pg_trgm` extensions must be creatable in it (or pre-provisioned
   by a superuser, same as for tests).

The movie dump ships with the example ([movies.json](./movies.json), originally from
[@marianmeres/searchable](https://github.com/marianmeres/searchable)); point the
`MOVIES_JSON` env var at a different file to seed something else.

## Run

```sh
deno task example
```

Then open http://localhost:8000 (override the port with `PORT`).

## REST api

| Endpoint                                                                        | Description                                                                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /api/search?q=…&mode=prefix\|exact\|fuzzy&limit=10&offset=0&threshold=0.6` | Ranked search (`threshold` applies to `fuzzy` only). Returns `{ hits, total, limit, offset, elapsedMs }`. |
| `GET /api/movies/:id`                                                           | The stored opaque `value` (full movie object) — `fts.get()`.                                              |
| `GET /api/stats`                                                                | Document count + resolved field/weight config.                                                            |

## Search modes

- **prefix** (default) — typeahead matching: every query word matches as a word
  prefix (`kni` finds "Knight"), multiple words are AND-ed. Index-backed; only
  sound on non-stemmed (`simple`) language configs.
- **exact** — whole-word matching: `alien` matches, `alie` does not. Useful when
  prefix matching is too eager.
- **fuzzy** — `pg_trgm` word-similarity: typo-tolerant and substring-capable, so
  `harison frod` still finds Harrison Ford. The threshold sets how loose a match
  may be (lower = looser, more results).

## Things to try

- **prefix** (default): `dark kni`, `tarant` — typeahead behavior, multi-word AND.
- **exact**: `alien` vs `alie` — whole words only.
- **fuzzy**: `harison frod`, `scorcese` — typo tolerance; lower the threshold and
  watch the match set grow (and the rank order change).
- Weights: `comedy` ranks title hits (weight A) above genre hits (weight D).
