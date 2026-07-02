import { assertEquals } from "@std/assert";
import { withStore } from "./_fts.ts";

// tenant_id is the outermost hard-isolation axis: PK (tenant_id, scope, key),
// every WHERE binds it, and no bulk op can cross tenants.

Deno.test("same (scope,key) coexists independently under two tenants", async () => {
	await withStore({ tableName: "fts_t1" }, async (fts) => {
		await fts.set("ta", "s", "k", { fields: { title: "from a" }, value: { t: "a" } });
		await fts.set("tb", "s", "k", { fields: { title: "from b" }, value: { t: "b" } });

		assertEquals(await fts.get("ta", "s", "k"), { t: "a" });
		assertEquals(await fts.get("tb", "s", "k"), { t: "b" });

		// overwrite in one tenant does not leak into the other
		await fts.set("ta", "s", "k", {
			fields: { title: "updated a" },
			value: { t: "a2" },
		});
		assertEquals(await fts.get("ta", "s", "k"), { t: "a2" });
		assertEquals(await fts.get("tb", "s", "k"), { t: "b" });
	});
});

Deno.test("delete/deleteMany are tenant-bound", async () => {
	await withStore({ tableName: "fts_t2" }, async (fts) => {
		await fts.set("ta", "s", "k", { fields: { title: "a" } });
		await fts.set("tb", "s", "k", { fields: { title: "b" } });

		assertEquals(await fts.delete("ta", "s", "k"), true);
		assertEquals(await fts.get("tb", "s", "k"), { title: "b" });

		await fts.setMany("ta", "s", [
			{ key: "x", fields: { title: "ax" } },
			{ key: "y", fields: { title: "ay" } },
		]);
		await fts.setMany("tb", "s", [
			{ key: "x", fields: { title: "bx" } },
			{ key: "y", fields: { title: "by" } },
		]);
		assertEquals(await fts.deleteMany("ta", "s", ["x", "y"]), 2);
		assertEquals(await fts.count("tb", "s"), 3); // k, x, y all intact
	});
});

Deno.test("deleteScope wipes the scope in ONE tenant only", async () => {
	await withStore({ tableName: "fts_t3" }, async (fts) => {
		await fts.setMany("ta", "s", [
			{ key: "1", fields: { title: "a1" } },
			{ key: "2", fields: { title: "a2" } },
		]);
		await fts.setMany("tb", "s", [
			{ key: "1", fields: { title: "b1" } },
			{ key: "2", fields: { title: "b2" } },
		]);

		assertEquals(await fts.deleteScope("ta", "s"), 2);
		assertEquals(await fts.count("ta", "s"), 0);
		assertEquals(await fts.count("tb", "s"), 2);
	});
});

Deno.test("deleteTenant wipes all scopes of ONE tenant only", async () => {
	await withStore({ tableName: "fts_t4" }, async (fts) => {
		await fts.set("ta", "s1", "k", { fields: { title: "a" } });
		await fts.set("ta", "s2", "k", { fields: { title: "a" } });
		await fts.set("tb", "s1", "k", { fields: { title: "b" } });

		assertEquals(await fts.deleteTenant("ta"), 2);
		assertEquals(await fts.count("ta"), 0);
		assertEquals(await fts.count("tb"), 1);
	});
});

Deno.test("count: per tenant and per (tenant, scope)", async () => {
	await withStore({ tableName: "fts_t5" }, async (fts) => {
		await fts.set("ta", "s1", "k1", { fields: { title: "x" } });
		await fts.set("ta", "s1", "k2", { fields: { title: "x" } });
		await fts.set("ta", "s2", "k1", { fields: { title: "x" } });
		await fts.set("tb", "s1", "k1", { fields: { title: "x" } });

		assertEquals(await fts.count("ta"), 3);
		assertEquals(await fts.count("ta", "s1"), 2);
		assertEquals(await fts.count("ta", "s2"), 1);
		assertEquals(await fts.count("tb"), 1);
		assertEquals(await fts.count("tc"), 0);
	});
});
