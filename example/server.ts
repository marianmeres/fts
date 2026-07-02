/**
 * @module
 *
 * Example server for `@marianmeres/fts` — a movie search playground.
 *
 * On boot it connects to the `fts_movies` database (credentials come from the
 * same `TEST_PG_*` env vars the tests use), provisions the fts schema, seeds it
 * once from a movies JSON dump (~2.5k movies) and serves a tiny REST api plus
 * the static vanilla-js client from `./public`.
 *
 * Run from the repo root:
 *
 * ```sh
 * deno task example
 * ```
 *
 * The database itself is NOT auto-created — see example/README.md.
 */

import { createClog } from "@marianmeres/clog";
import { demino, logListenInfo } from "@marianmeres/demino";
import { fromFileUrl } from "@std/path";
import pg from "pg";
import {
	createFts,
	DEFAULT_TENANT_ID,
	type SearchMode,
	type SetEntry,
} from "../src/mod.ts";

const clog = createClog("fts-example");

const DB_NAME = "fts_movies";
const SCOPE = "movies";
const PORT = parseInt(Deno.env.get("PORT") || "8000", 10);
const PUBLIC_DIR = fromFileUrl(new URL("./public", import.meta.url));

// The bundled movie dump (originally from @marianmeres/searchable); override via env.
const MOVIES_JSON = Deno.env.get("MOVIES_JSON") ||
	fromFileUrl(new URL("./movies.json", import.meta.url));

// Same user/password as tests (see .env.example), only the database name differs.
const db = new pg.Pool({
	host: Deno.env.get("TEST_PG_HOST") || "localhost",
	port: parseInt(Deno.env.get("TEST_PG_PORT") || "5432", 10),
	user: Deno.env.get("TEST_PG_USER"),
	password: Deno.env.get("TEST_PG_PASSWORD"),
	database: DB_NAME,
});

const fts = createFts({
	db,
	fields: {
		title: "A",
		tagline: "B",
		overview: "C",
		people: "C", // directors + actors + characters
		genres: "D",
	},
});

interface Movie {
	title?: string;
	tagline?: string;
	overview?: string;
	year?: number;
	genres?: string[];
	directors?: string[];
	actors?: string[];
	characters?: string[];
}

async function initialize() {
	try {
		await fts.initialize();
	} catch (e) {
		clog.error(String(e));
		clog.error(
			`Is PostgreSQL running and does the "${DB_NAME}" database exist? If not:`,
			`\n  psql -h localhost -U ${Deno.env.get("TEST_PG_USER")} -d postgres`,
			`-c 'CREATE DATABASE ${DB_NAME}'`,
		);
		Deno.exit(1);
	}
}

async function seed() {
	const count = await fts.count(DEFAULT_TENANT_ID, SCOPE);
	if (count > 0) {
		clog(`Found ${count} movies, skipping seed.`);
		return;
	}

	clog(`Seeding from ${MOVIES_JSON} ...`);
	const movies: Record<string, Movie> = JSON.parse(
		await Deno.readTextFile(MOVIES_JSON),
	);

	const entries: SetEntry[] = Object.entries(movies).map(([id, m]) => ({
		key: id,
		fields: {
			title: m.title ?? "",
			tagline: m.tagline ?? "",
			overview: m.overview ?? "",
			people: [m.directors, m.actors, m.characters].flat().filter(Boolean).join(
				", ",
			),
			genres: (m.genres ?? []).join(", "),
		},
		value: { id, ...m },
	}));

	const batchSize = 500;
	for (let i = 0; i < entries.length; i += batchSize) {
		await fts.setMany(DEFAULT_TENANT_ID, SCOPE, entries.slice(i, i + batchSize));
		clog(`Seeded ${Math.min(i + batchSize, entries.length)}/${entries.length}`);
	}
}

//
// REST api
//

const app = demino();

app.error((_req, _info, ctx) => ({ error: String(ctx.error?.message ?? ctx.error) }));

const clamp = (n: number, min: number, max: number) =>
	Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;

// GET /api/search?q=...&mode=prefix|exact|fuzzy&limit=10&offset=0&threshold=0.6
app.get("/api/search", async (_req, _info, ctx) => {
	const sp = ctx.url.searchParams;

	const q = sp.get("q") ?? "";
	const mode = (sp.get("mode") || "prefix") as SearchMode;
	if (!["prefix", "exact", "fuzzy"].includes(mode)) {
		ctx.status = 400;
		return { error: `Invalid mode "${mode}" (expected prefix|exact|fuzzy)` };
	}

	const started = performance.now();
	const result = await fts.search(DEFAULT_TENANT_ID, SCOPE, q, {
		mode,
		limit: clamp(parseInt(sp.get("limit") || "10", 10), 1, 100),
		offset: clamp(parseInt(sp.get("offset") || "0", 10), 0, 1_000_000),
		trgmThreshold: clamp(parseFloat(sp.get("threshold") || "0.6"), 0.05, 1),
		withTotal: true,
	});

	return { ...result, elapsedMs: Math.round((performance.now() - started) * 10) / 10 };
});

// GET /api/movies/[id] — the stored opaque `value`
app.get("/api/movies/[id]", async (_req, _info, ctx) => {
	const value = await fts.get(DEFAULT_TENANT_ID, SCOPE, ctx.params.id);
	if (value === null) {
		ctx.status = 404;
		return { error: `Movie "${ctx.params.id}" not found` };
	}
	return value;
});

// GET /api/stats
app.get("/api/stats", async () => ({
	count: await fts.count(DEFAULT_TENANT_ID, SCOPE),
	scope: SCOPE,
	table: fts.config.tableName,
	fields: fts.config.fields,
	modes: ["prefix", "exact", "fuzzy"],
}));

// the vanilla client
app.static("/", PUBLIC_DIR);

//
// boot
//

await initialize();
await seed();
Deno.serve({ port: PORT, onListen: logListenInfo }, app);
