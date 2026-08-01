import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [resolve(__dirname, "../src/session.ts")],
  bundle: false,
  format: "esm",
  target: "es2018",
  write: false,
  platform: "node",
});
const code = out.outputFiles[0].text;
const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const { SessionStore } = mod;

async function test(name, fn) {
  try {
    await fn();
    console.log("  ok  -", name);
  } catch (err) {
    console.error("  FAIL -", name);
    console.error(err);
    process.exitCode = 1;
  }
}

function memoryPersistence(initial = null) {
  let stored = initial;
  const p = {
    read: async () => stored,
    write: async (data) => { stored = data; p.writes++; },
    dump: () => stored,
    writes: 0,
  };
  return p;
}

console.log("session store:");

await (async () => {
  const p = memoryPersistence();
  const store = await SessionStore.load(p, () => true);

  await test("empty store has no session", () => {
    assert.equal(store.has("a.md"), false);
    assert.equal(store.get("a.md"), null);
  });

  await store.start("a.md", "baseline text", "2026-07-24T10:00:00Z");

  await test("start persists and is retrievable", () => {
    assert.equal(store.has("a.md"), true);
    assert.deepEqual(store.get("a.md"), { baseline: "baseline text", startedAt: "2026-07-24T10:00:00Z" });
    const onDisk = JSON.parse(p.dump());
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.sessions["a.md"].baseline, "baseline text");
  });

  await store.rename("a.md", "b.md");
  await test("rename re-keys", () => {
    assert.equal(store.has("a.md"), false);
    assert.equal(store.has("b.md"), true);
  });

  await store.end("b.md");
  await test("end removes and persists", () => {
    assert.equal(store.has("b.md"), false);
    assert.deepEqual(JSON.parse(p.dump()).sessions, {});
  });

  const writesBeforeNoopEnd = p.writes;
  await store.end("never-started.md");
  await test("end on a never-started path is a no-op (no write)", () => {
    assert.equal(store.has("never-started.md"), false);
    assert.equal(p.writes, writesBeforeNoopEnd);
  });

  const writesBeforeNoopRename = p.writes;
  await store.rename("never-started.md", "also-never.md");
  await test("rename of a never-started path is a no-op (no write)", () => {
    assert.equal(store.has("never-started.md"), false);
    assert.equal(store.has("also-never.md"), false);
    assert.equal(p.writes, writesBeforeNoopRename);
  });
})();

await (async () => {
  await test("load restores persisted sessions", async () => {
    const p = memoryPersistence(JSON.stringify({ version: 1, sessions: { "x.md": { baseline: "b", startedAt: "t" } } }));
    const store = await SessionStore.load(p, () => true);
    assert.equal(store.has("x.md"), true);
  });

  await test("load drops sessions whose file is gone", async () => {
    const p = memoryPersistence(JSON.stringify({ version: 1, sessions: { "gone.md": { baseline: "b", startedAt: "t" } } }));
    const store = await SessionStore.load(p, () => false);
    assert.equal(store.has("gone.md"), false);
    assert.ok(p.writes > 0);
    assert.deepEqual(JSON.parse(p.dump()).sessions, {});
  });

  await test("load keeps the surviving session and drops the dead one from a mixed set", async () => {
    const p = memoryPersistence(JSON.stringify({
      version: 1,
      sessions: {
        "alive.md": { baseline: "b1", startedAt: "t1" },
        "dead.md": { baseline: "b2", startedAt: "t2" },
      },
    }));
    const store = await SessionStore.load(p, (path) => path === "alive.md");
    assert.equal(store.has("alive.md"), true);
    assert.equal(store.has("dead.md"), false);
    assert.ok(p.writes > 0);
    assert.equal(JSON.parse(p.dump()).sessions["dead.md"], undefined);
  });

  await test("load tolerates corrupt json", async () => {
    const p = memoryPersistence("{nope");
    const store = await SessionStore.load(p, () => true);
    assert.equal(store.has("x.md"), false);
    assert.equal(p.writes, 0);
  });

  await test("load tolerates missing file", async () => {
    const p = memoryPersistence(null);
    const store = await SessionStore.load(p, () => true);
    assert.equal(store.has("x.md"), false);
    assert.equal(p.writes, 0);
  });
})();

console.log("done.");
