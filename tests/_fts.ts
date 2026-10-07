// deno-lint-ignore-file no-explicit-any

import type { Logger } from "@marianmeres/clog";
import { createFts, type Fts, type FtsOptions } from "../src/mod.ts";
import { createPg } from "./_pg.ts";

/** A silent logger so test output stays clean. */
export const noopLogger = new Proxy({}, {
	get: () => () => {},
}) as unknown as Logger;

/**
 * Build a store on a fresh connection with a silent logger. Extensions are assumed
 * pre-provisioned in the test DB (mirroring a least-privilege deployment), so the
 * default `manageExtensions:true` still works because `CREATE EXTENSION IF NOT EXISTS`
 * is a no-op when the extension already exists.
 */
export function makeFts(db: any, opts: Partial<FtsOptions> = {}): Fts {
	return createFts({ db, logger: noopLogger, ...opts });
}

/** Create a store and hard-reset it (drop + initialize) so each test starts clean. */
export async function freshStore(db: any, opts: Partial<FtsOptions> = {}): Promise<Fts> {
	const fts = makeFts(db, opts);
	await fts.destroy(true);
	await fts.initialize();
	return fts;
}

/** Run `fn` against a freshly-provisioned store, always cleaning up (table + pool). */
export async function withStore(
	opts: Partial<FtsOptions>,
	fn: (fts: Fts, db: any) => Promise<void>,
): Promise<void> {
	const db = createPg();
	try {
		const fts = await freshStore(db, opts);
		try {
			await fn(fts, db);
		} finally {
			await fts.destroy(true);
		}
	} finally {
		await db.end();
	}
}

/** Everything a `pg.Client`-mode test needs — see {@link withClientStore}. */
export interface ClientStoreCtx {
	/** Pool-backed store on the same table: the "other connection" view of the data. */
	fts: Fts;
	/** Store bound to ONE caller-owned connection (`client`). */
	clientFts: Fts;
	/** That connection — the test drives `BEGIN`/`COMMIT`/`ROLLBACK` on it itself. */
	client: any;
	db: any;
}

/**
 * Like {@link withStore}, plus a second store bound to a single checked-out connection
 * — the way an app joins the store to its own transaction. Whatever transaction a
 * failed test leaves open is rolled back before cleanup.
 */
export async function withClientStore(
	opts: Partial<FtsOptions>,
	fn: (ctx: ClientStoreCtx) => Promise<void>,
): Promise<void> {
	await withStore(opts, async (fts, db) => {
		const client = await db.connect();
		try {
			const clientFts = makeFts(client, opts);
			await clientFts.initialize();
			await fn({ fts, clientFts, client, db });
		} finally {
			await client.query("ROLLBACK").catch(() => {});
			client.release();
		}
	});
}

/** A logger that records `warn` messages and swallows the rest. */
export function warnSpy(): { logger: Logger; warns: string[] } {
	const warns: string[] = [];
	const logger = new Proxy({}, {
		get: (_t, level) =>
			level === "warn" ? (m: unknown) => warns.push(String(m)) : () => {},
	}) as unknown as Logger;
	return { logger, warns };
}

/** ~150k distinct short tokens — well over the ~1MB tsvector byte cap (PG18-verified
 * shape: byte size is driven by distinct-lexeme count, not char count). */
export function oversizedText(): string {
	return Array.from({ length: 150_000 }, (_, i) => `t${i}`).join(" ");
}

/** Budgets loose enough that only the database's own byte cap stops a document. */
export const HUGE_BUDGETS = { maxIndexedLexemes: 1_000_000, maxIndexedChars: 10_000_000 };

export { createPg };
