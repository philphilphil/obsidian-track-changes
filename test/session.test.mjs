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
  return {
    read: async () => stored,
    write: async (data) => { stored = data; },
    dump: () => stored,
  };
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
  });

  await test("load tolerates corrupt json", async () => {
    const store = await SessionStore.load(memoryPersistence("{nope"), () => true);
    assert.equal(store.has("x.md"), false);
  });

  await test("load tolerates missing file", async () => {
    const store = await SessionStore.load(memoryPersistence(null), () => true);
    assert.equal(store.has("x.md"), false);
  });
})();

console.log("done.");
