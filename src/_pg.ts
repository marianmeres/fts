// deno-lint-ignore-file no-explicit-any

/**
 * @module
 *
 * Driver-agnostic PostgreSQL seam. Works under any `pg.Pool` / `pg.Client` (and any
 * driver exposing the same minimal `query(sql, params)` surface).
 */

import type pg from "pg";

/** Minimal subset of `pg.ClientBase` used by this package. */
export type PgExecutor = {
	query: (
		sql: string,
		params?: any[],
	) => Promise<{ rows: any[]; rowCount: number | null }>;
};

/**
 * Type guard distinguishing a `pg.Pool` from a `pg.Client`.
 *
 * A `pg.Pool` exposes `totalCount` (and a `connect()` that hands out a `PoolClient`
 * requiring `release()`); a `pg.Client` does not.
 */
export function isPool(db: pg.Pool | pg.Client): db is pg.Pool {
	return (
		typeof (db as any).totalCount === "number" &&
		typeof (db as any).connect === "function"
	);
}

/**
 * Acquire a single pinned connection. For a `pg.Pool` this checks out one client
 * (so multi-statement work runs on the same physical session); for a `pg.Client`
 * it returns the client itself. Always call `release()` when done.
 */
export async function acquireClient(
	db: pg.Pool | pg.Client,
): Promise<{ client: PgExecutor; release: () => void }> {
	if (isPool(db)) {
		const client = await db.connect();
		return {
			client: client as unknown as PgExecutor,
			release: () => client.release(),
		};
	}
	return { client: db as unknown as PgExecutor, release: () => {} };
}

/**
 * Run `fn` inside a single transaction on one pinned connection.
 *
 * Crucially, when `db` is a `pg.Pool` this pins one underlying connection so
 * `BEGIN` / queries / `COMMIT` share a session (`pool.query("BEGIN")` alone is a
 * no-op — pg returns the connection to the pool immediately). Rolls back and
 * re-throws on error.
 */
export async function withTx<T>(
	db: pg.Pool | pg.Client,
	fn: (client: PgExecutor) => Promise<T>,
): Promise<T> {
	const { client, release } = await acquireClient(db);
	try {
		await client.query("BEGIN");
		const out = await fn(client);
		await client.query("COMMIT");
		return out;
	} catch (e) {
		try {
			await client.query("ROLLBACK");
		} catch {
			// ignore — the original error is the interesting one
		}
		throw e;
	} finally {
		release();
	}
}
