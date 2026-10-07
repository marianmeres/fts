// deno-lint-ignore-file no-explicit-any

/**
 * @module
 *
 * Driver-agnostic PostgreSQL seam. Works under any `pg.Pool` / `pg.Client` (and any
 * driver exposing the same minimal `query(sql, params)` surface).
 *
 * It also owns the store's TRANSACTION POLICY, which differs by what the caller handed in:
 *
 * - A `pg.Pool` hands out private connections, so the store may open and close its own
 *   transactions freely on a checked-out client.
 * - A `pg.Client` is ONE connection that the caller owns — and may have an open
 *   transaction on (joining an outer transaction is the usual reason to pass a Client).
 *   The store must never `COMMIT` or `ROLLBACK` a transaction it did not open: a bare
 *   `BEGIN` inside an open transaction is only a warning, and the matching `COMMIT`
 *   then commits the CALLER's work. So on a Client the store first asks PostgreSQL
 *   whether a transaction block is open ({@link inTransaction}) and, if so, nests with
 *   SAVEPOINTs instead.
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

/** Custom GUC used only by {@link inTransaction}; never read anywhere else. */
const TX_PROBE = "marianmeres_fts.tx_probe";

/**
 * Is a transaction block currently open on this connection?
 *
 * PostgreSQL has no function for this and node-postgres keeps the protocol's
 * transaction status private, so it is derived from documented GUC semantics: a
 * transaction-local setting (`set_config(..., true)`) survives into the NEXT statement
 * only when both statements share a transaction block; outside one, the first
 * statement's implicit transaction ends and the setting is gone. Deterministic, raises
 * nothing (unlike probing with `SAVEPOINT`, which errors — and logs — when idle), at
 * the cost of two round trips.
 *
 * Throws when the open transaction is already aborted (SQLSTATE 25P02) — correct: no
 * statement can run there until the caller rolls back.
 */
export async function inTransaction(exec: PgExecutor): Promise<boolean> {
	await exec.query(`SELECT set_config('${TX_PROBE}', '1', true)`);
	const { rows } = await exec.query(
		`SELECT current_setting('${TX_PROBE}', true) AS v`,
	);
	return rows[0]?.v === "1";
}

/** Tail of the unit queue per caller-supplied connection (see {@link serialize}). */
const queues = new WeakMap<object, Promise<void>>();

/**
 * Run `fn` as one uninterrupted unit on a caller-supplied connection.
 *
 * A single connection executes statements strictly in arrival order, so two concurrent
 * multi-statement units would interleave: one unit's probe would observe the other's
 * `BEGIN`, and one fuzzy search's threshold would apply to another's query. Units are
 * therefore queued per connection (shared by every store on it). This orders the
 * store's own units only — statements the caller issues directly on the same
 * connection are not covered. NOT re-entrant: never call from inside `fn`.
 */
function serialize<T>(conn: object, fn: () => Promise<T>): Promise<T> {
	const run = (queues.get(conn) ?? Promise.resolve()).then(fn);
	queues.set(conn, run.then(() => {}, () => {}));
	return run;
}

/**
 * Run `fn` under a SAVEPOINT (requires an open transaction). On failure the savepoint
 * is rolled back — which also un-aborts the surrounding transaction — and the original
 * error is re-thrown.
 */
export async function withSavepoint<T>(
	exec: PgExecutor,
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	await exec.query(`SAVEPOINT ${name}`);
	let out: T;
	try {
		out = await fn();
	} catch (e) {
		try {
			await exec.query(`ROLLBACK TO SAVEPOINT ${name}`);
			await exec.query(`RELEASE SAVEPOINT ${name}`);
		} catch {
			// ignore — the original error is the interesting one
		}
		throw e;
	}
	await exec.query(`RELEASE SAVEPOINT ${name}`);
	return out;
}

/** `BEGIN` / `fn` / `COMMIT` on a connection known to have no transaction open. */
async function runTx<T>(
	client: PgExecutor,
	fn: (client: PgExecutor) => Promise<T>,
): Promise<T> {
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
	}
}

/**
 * Hand `fn` an executor together with whether a caller-managed transaction is open on
 * it — for single statements that may fail and be retried (a failed statement aborts a
 * surrounding transaction unless it ran under a savepoint).
 *
 * A `pg.Pool` autocommits every statement on some connection, so `inTx` is `false`
 * without asking. A `pg.Client` is probed, and the unit is serialized.
 */
export function withTxState<T>(
	db: pg.Pool | pg.Client,
	fn: (exec: PgExecutor, inTx: boolean) => Promise<T>,
): Promise<T> {
	if (isPool(db)) return fn(db as unknown as PgExecutor, false);
	const client = db as unknown as PgExecutor;
	return serialize(db, async () => fn(client, await inTransaction(client)));
}

/**
 * Run `fn` atomically on one pinned connection.
 *
 * - `pg.Pool`: checks out a client so `BEGIN` / queries / `COMMIT` share a session
 *   (`pool.query("BEGIN")` alone is a no-op — pg returns the connection immediately).
 * - `pg.Client`, idle: opens and closes its own transaction on it.
 * - `pg.Client`, inside the caller's transaction: nests under a SAVEPOINT. On success
 *   the work stays pending in the caller's transaction; on failure only this unit is
 *   rolled back. The caller's transaction is never committed or rolled back here.
 *
 * Rolls back its own unit and re-throws on error.
 */
export async function withTx<T>(
	db: pg.Pool | pg.Client,
	fn: (client: PgExecutor) => Promise<T>,
): Promise<T> {
	if (isPool(db)) {
		const client = await db.connect();
		try {
			return await runTx(client as unknown as PgExecutor, fn);
		} finally {
			client.release();
		}
	}
	const client = db as unknown as PgExecutor;
	return serialize(
		db,
		async () =>
			(await inTransaction(client))
				? withSavepoint(client, "fts_tx", () => fn(client))
				: runTx(client, fn),
	);
}

/**
 * Run `fn` with a PostgreSQL setting (GUC) in effect for exactly its statements.
 *
 * Needed for operators whose behavior is driven by a GUC rather than an argument
 * (`pg_trgm`'s `<%`). The setting never outlives the unit:
 *
 * - `pg.Pool`: transaction-local on a pinned connection — reverted by `COMMIT`.
 * - `pg.Client`: set, run, then restored to the previous value — transaction-local
 *   when the caller has a transaction open, session-level otherwise. No transaction is
 *   opened or closed, so a read can never commit or roll back anything. When the
 *   setting already has the wanted value nothing is touched at all.
 */
export function withLocalSetting<T>(
	db: pg.Pool | pg.Client,
	name: string,
	value: string,
	fn: (client: PgExecutor) => Promise<T>,
): Promise<T> {
	if (isPool(db)) {
		return withTx(db, async (c) => {
			await c.query(`SELECT set_config($1, $2, true)`, [name, value]);
			return await fn(c);
		});
	}
	const client = db as unknown as PgExecutor;
	return serialize(db, async () => {
		// `missing_ok`: an extension's GUC is undefined until its library first loads in
		// the session; NULL then means "at its default", and restoring NULL resets it.
		const { rows } = await client.query(
			`SELECT current_setting($1, true) AS v`,
			[name],
		);
		const prev: string | null = rows[0]?.v ?? null;
		if (prev === value) return await fn(client);

		const local = await inTransaction(client);
		await client.query(`SELECT set_config($1, $2, $3)`, [name, value, local]);
		try {
			return await fn(client);
		} finally {
			try {
				await client.query(`SELECT set_config($1, $2, $3)`, [name, prev, local]);
			} catch {
				// only reachable when `fn` aborted the caller's transaction — whose
				// rollback reverts the setting anyway
			}
		}
	});
}
