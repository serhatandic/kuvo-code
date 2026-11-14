// The scripts `kuvo-browser.js` runs in pages, in the agent's world of its own: reading a page as
// numbered elements (`snapshot`, with browser-use's buildDomTree.js), finding one again by its
// number, and acting on it. Each is the body of a function, in page/<name>.js; `/*@ <name> */` in
// one stands for another's text (`dom-tree` for buildDomTree.js's function).
// This Mac's panel still runs a copy of its own (BrowserAgent.swift's) until its agents browse in
// its box's browser (#693): change both.
import fs from "node:fs";

/** A file of this folder, without the newline that ends it. */
function read(name: string): string {
  return fs.readFileSync(new URL(name, import.meta.url), "utf8").replace(/\n$/, "");
}

/** buildDomTree.js's function, which hands each element to `onIndex` as it's numbered: the actions
 * use that very element, in a frame or a shadow root too, where the path it keeps leads nowhere or
 * elsewhere. The file itself stays as browser-use has it. */
function domTree(): string {
  // The file is one arrow function ending in ";", which can't sit inside parentheses.
  const source = read("buildDomTree.js").trim().replace(/;+$/, "");
  const numbered = "nodeData.highlightIndex = highlightIndex++;";
  if (!source.includes(numbered)) throw new Error("buildDomTree.js no longer numbers elements where onIndex hooks in.");
  return source.split(numbered).join(numbered + " if (args.onIndex) args.onIndex(nodeData.highlightIndex, node);");
}

/** page/<name>.js, with what it takes in. */
function script(name: string): string {
  return read(`page/${name}.js`).replace(/\/\*@ ([a-z-]+) \*\//g, (_, part: string) => (part === "dom-tree" ? domTree() : script(part)));
}

/** Hides what the user filled in (`data-kuvo-secret`) with a style rule of its own, in every
 * document and shadow root that holds some. */
function mask(rule: string, id: string): string {
  return `${script("secret-roots")}
for (const root of roots) {
  if (!root.querySelector('[data-kuvo-secret]') || root.getElementById('${id}')) continue;
  const doc = root.ownerDocument || root;
  const style = doc.createElement('style');
  style.id = '${id}';
  style.textContent = '[data-kuvo-secret]{${rule}}';
  (root.head || root.documentElement || root).appendChild(style);
}
return 'ok';`;
}

/** Takes `mask`'s rule away again. */
function unmask(id: string): string {
  return `${script("secret-roots")}
for (const root of roots) root.getElementById('${id}')?.remove();
return 'ok';`;
}

/** Every script, by the name `kuvo-browser.js` uses (`CONFIG.scripts`). */
export function pageScripts(): Record<string, string> {
  return {
    snapshot: script("snapshot"),
    handlers: script("handlers"),
    find: script("find"),
    click: script("click"),
    type: script("type"),
    select: script("select"),
    press: script("press"),
    fieldKind: script("field-kind"),
    fileInput: script("file-input"),
    rect: script("rect"),
    fill: script("fill"),
    // For a screenshot: what the user filled in drawn clear, and shown again.
    mask: mask("color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important", "kuvo-secret-mask"),
    unmask: unmask("kuvo-secret-mask"),
    // For a PDF, where text drawn clear is still there to copy or search: the fields left out
    // (their place stays empty). A mask of its own, so a screenshot at the same time neither
    // stands in for it nor takes it away.
    printMask: mask("visibility:hidden!important", "kuvo-secret-print-mask"),
    printUnmask: unmask("kuvo-secret-print-mask"),
  };
}
