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

export { createPg };
