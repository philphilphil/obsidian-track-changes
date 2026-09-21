// Exercise the source with two mocked Obsidian windows; no copied plugin logic.
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

class FileView {}
class MarkdownView extends FileView {}
class ItemView {
  constructor(leaf) {
    this.app = leaf.app;
    this.containerEl = leaf.view.containerEl;
    this.contentEl = { addClass() {} };
  }
  registerEvent() {}
}
const obsidian = {
  FileView, MarkdownView, ItemView,
  Plugin: class {}, Modal: class {}, PluginSettingTab: class {},
  TFile: class {}, Notice: class {},
  debounce: (fn) => fn,
};
const out = await build({
  stdin: {
    contents: 'export { default as Plugin } from "./src/main"; export { ReviewPanelView, REVIEW_VIEW_TYPE } from "./src/panel/view";',
    resolveDir: new URL("..", import.meta.url).pathname,
    loader: "ts",
  },
  bundle: true, format: "cjs", platform: "node", write: false,
  external: ["obsidian", "@codemirror/*"],
});
const module = { exports: {} };
const require = createRequire(import.meta.url);
runInNewContext(out.outputFiles[0].text, {
  module, exports: module.exports,
  require: (id) => id === "obsidian" ? obsidian : require(id),
});
const { Plugin, REVIEW_VIEW_TYPE } = module.exports;
const fileA = { path: "a.md", extension: "md" };
const fileB = { path: "b.md", extension: "md" };

function fixture() {
  const mainDocument = {}, popDocument = {};
  const rootSplit = { containerEl: { ownerDocument: mainDocument } };
  const popRoot = {};
  const leaves = [], events = new Map(), calls = [];
  const workspace = {
    rootSplit, activeLeaf: null,
    getLeavesOfType: (type) => leaves.filter((leaf) => leaf.type === type),
    on: (event, fn) => { events.set(event, [...(events.get(event) ?? []), fn]); },
    revealLeaf: async (leaf) => {
      calls.push(["reveal", leaf, leaf.view.getCurrentFile()]);
      workspace.activeLeaf = leaf;
      for (const fn of events.get("active-leaf-change") ?? []) fn(leaf);
    },
    getRightLeaf: (split) => {
      assert.equal(split, false);
      calls.push(["sidebar"]);
      return newLeaf(mainDocument);
    },
    createLeafBySplit: (target, direction) => {
      calls.push(["split", target, direction]);
      return newLeaf(target.view.containerEl.ownerDocument);
    },
    updateOptions() {},
  };
  const plugin = new Plugin();
  plugin.app = { workspace, vault: { on() {}, process: async (_file, fn) => fn("{++x++}") } };
  plugin.settings = {};
  function newLeaf(document, file) {
    const view = file ? new MarkdownView() : {};
    Object.assign(view, { containerEl: { ownerDocument: document }, file });
    const leaf = {
      app: plugin.app, view, type: file ? "markdown" : "empty",
      getRoot: () => document === mainDocument ? rootSplit : popRoot,
      setViewState: async ({ type }) => {
        leaf.type = type;
        leaf.view = plugin.makeReviewView(leaf);
        leaf.view.refresh = (...args) => { leaf.refreshes.push(args); };
        await leaf.view.onOpen();
      },
      refreshes: [],
    };
    leaves.push(leaf);
    return leaf;
  }
  const main = newLeaf(mainDocument, fileA), pop = newLeaf(popDocument, fileB);
  workspace.activeLeaf = main;
  return { plugin, workspace, main, pop, newLeaf, leaves, calls, events };
}

async function test(name, fn) {
  try {
    await fn();
    console.log("  ok  -", name);
  } catch (error) {
    console.error("  FAIL -", name, error);
    process.exitCode = 1;
  }
}

await test("main sidebar and pop-out split each reuse only their own panel", async () => {
  const f = fixture();
  await f.plugin.openReviewPanel(f.main);
  const mainPanel = f.plugin.getReviewView(f.main);
  await f.plugin.openReviewPanel(f.pop);
  const popPanel = f.plugin.getReviewView(f.pop);
  assert.notEqual(mainPanel, popPanel);
  assert.equal(mainPanel.getCurrentFile(), fileA);
  assert.equal(popPanel.getCurrentFile(), fileB);
  await f.plugin.openReviewPanel(f.pop);
  assert.equal(f.workspace.getLeavesOfType(REVIEW_VIEW_TYPE).length, 2);
  assert.deepEqual(f.calls.filter(([kind]) => kind === "split"), [["split", f.pop, "vertical"]]);
  assert.equal(f.calls.filter(([kind]) => kind === "sidebar").length, 1);
  assert.deepEqual(f.calls.filter(([kind]) => kind === "reveal").map((call) => call[2]), [fileA, fileB, fileB]);
  const absentWindow = f.newLeaf({}, fileA);
  assert.equal(f.plugin.getReviewView(absentWindow), mainPanel);
  assert.equal(f.plugin.getReviewView(null), mainPanel);
});

await test("no active leaf and main-window sidebar origins use the main sidebar", async () => {
  const f = fixture();
  f.workspace.activeLeaf = null;
  await f.plugin.openReviewPanel();
  const panel = f.plugin.getReviewView(null);
  assert.ok(panel);
  const g = fixture();
  g.main.getRoot = () => ({}); // A main-window sidebar has a different root.
  await g.plugin.openReviewPanel(g.main);
  assert.equal(g.calls[0][0], "sidebar");
});

await test("file tracking ignores other windows and retains the current local file", async () => {
  const f = fixture();
  const second = f.newLeaf(f.pop.view.containerEl.ownerDocument, fileA);
  await f.plugin.openReviewPanel(second);
  const panel = f.plugin.getReviewView(second);
  assert.equal(panel.host.getActiveFile(), fileA); // Focus is now the panel.
  const panelLeaf = f.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
  const refreshCount = panelLeaf.refreshes.length;
  f.workspace.activeLeaf = f.main;
  for (const fn of f.events.get("active-leaf-change")) fn(f.main);
  assert.equal(panelLeaf.refreshes.length, refreshCount);
  assert.equal(panel.getCurrentFile(), fileA);
  assert.equal(panel.host.getActiveFile(), fileA);
  f.workspace.activeLeaf = f.pop;
  for (const fn of f.events.get("active-leaf-change")) fn(f.pop);
  assert.equal(panel.getCurrentFile(), fileB);
  f.leaves.splice(f.leaves.indexOf(second), 1);
  assert.equal(panel.host.isFileOpen(fileA), false); // Still open in main.
  assert.equal(panel.host.isFileOpen(fileB), true);
  for (const fn of f.events.get("active-leaf-change")) fn(null);
  assert.equal(panel.getCurrentFile(), fileB);
});

await test("source and reveal prefer the panel's editor with cross-window fallback", async () => {
  const f = fixture();
  f.pop.view.file = fileA;
  f.main.view.editor = { getValue: () => "main" };
  f.pop.view.editor = { getValue: () => "pop" };
  await f.plugin.openReviewPanel(f.pop);
  const panel = f.plugin.getReviewView(f.pop);
  f.workspace.activeLeaf = f.main;
  assert.equal(panel.host.getCurrentSource(fileA), "pop");
  let scrolled;
  f.plugin.scrollEditor = (editor) => { scrolled = editor; };
  panel.host.revealOffset(fileA, 0, 1);
  assert.equal(scrolled, f.pop.view.editor);
  f.leaves.splice(f.leaves.indexOf(f.pop), 1);
  assert.equal(panel.host.getCurrentSource(fileA), "main");
  panel.host.revealOffset(fileA, 0, 1);
  assert.equal(scrolled, f.main.view.editor);
});

await test("reveal keeps its target window while waiting for a closed file to open", async () => {
  const f = fixture();
  f.leaves.splice(0, 2);
  let scrolled;
  f.plugin.scrollEditor = (editor) => { scrolled = editor; };
  const localEditor = {}, otherEditor = {};
  f.workspace.openLinkText = async () => {
    f.newLeaf(f.main.view.containerEl.ownerDocument, fileA).view.editor = otherEditor;
    f.newLeaf(f.pop.view.containerEl.ownerDocument, fileA).view.editor = localEditor;
    f.workspace.activeLeaf = f.main;
  };
  f.plugin.revealOffsetInEditor(fileA, 0, 1, false, f.pop);
  await Promise.resolve();
  assert.equal(scrolled, localEditor);
});

await test("inline clicks retain the originating file and window across focus changes", async () => {
  const f = fixture();
  await f.plugin.openReviewPanel(f.main);
  await f.plugin.openReviewPanel(f.pop);
  const panel = f.plugin.getReviewView(f.pop);
  const focused = new Promise((resolve) => { panel.focusOffset = (...args) => resolve(args); });
  const reveal = f.workspace.revealLeaf;
  f.workspace.revealLeaf = async (leaf) => {
    await reveal(leaf);
    f.workspace.activeLeaf = f.main;
  };
  f.workspace.activeLeaf = f.pop;
  f.plugin.handleInlineClick(12);
  assert.deepEqual(await focused, [fileB, 12]);
});

for (const mode of ["cm", "plain", "vault"]) {
  await test(`${mode} edits refresh every panel and prefer the originating editor`, async () => {
    const f = fixture();
    f.pop.view.file = fileA;
    let source = "{++x++}";
    if (mode !== "vault") {
      f.main.view.editor = { getValue: () => "{++main++}" };
      f.pop.view.editor = mode === "cm" ? {
        cm: {
          state: { doc: { toString: () => source } },
          dispatch: ({ changes }) => {
            for (const c of changes) source = source.slice(0, c.from) + c.insert + source.slice(c.to);
          },
        },
      } : { getValue: () => source, setValue: (next) => { source = next; } };
    }
    await f.plugin.openReviewPanel(f.main);
    await f.plugin.openReviewPanel(f.pop);
    if (mode === "vault") f.leaves.splice(0, 2);
    const panels = f.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
    for (const leaf of panels) leaf.refreshes.length = 0;
    f.workspace.activeLeaf = f.main;
    await f.plugin.getReviewView(f.pop).host.applyEdits(fileA, [
      { from: 0, to: 7, expected: "{++x++}", insert: "x" },
    ]);
    for (const leaf of panels) assert.equal(leaf.refreshes.at(-1)[0], "x");
    if (mode !== "vault") assert.equal(source, "x");
  });
}

await test("both settings refresh paths rebuild every panel", async () => {
  const f = fixture();
  await f.plugin.openReviewPanel(f.main);
  await f.plugin.openReviewPanel(f.pop);
  const panels = f.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
  for (const leaf of panels) leaf.refreshes.length = 0;
  f.plugin.makeDecorationExtension = () => ({});
  f.plugin.refreshCharHighlighting();
  f.plugin.refreshAfterSettingsChange();
  for (const leaf of panels) {
    assert.equal(leaf.refreshes.length, 2);
    for (const args of leaf.refreshes) assert.equal(args[1], true);
  }
});
