// kuvo-browser 7444ec990e32aa90
// Built from Packages/Box/src/browser by scripts/build-browser.sh: change those, then run it. Never edit this file.
// Kuvo Code's browser on a machine: a Chromium kept running there, which the agent browses with
// and the app shows live in its panel. The engine's own runtime runs it, so the machine needs
// nothing else:
//
//   BUN_BE_BUN=1 opencode kuvo-browser.js mcp       the agent's browser tools, for the engine
//   BUN_BE_BUN=1 opencode kuvo-browser.js connect   the app's live view, over SSH
//   BUN_BE_BUN=1 opencode kuvo-browser.js host      the keeper, started by either of the others
//
// The keeper drives Chromium over a pipe, never a port, and lets the others in through a socket
// in ~/.kuvo-code/run, a folder only this user can open. It relays Chrome's DevTools protocol to
// each, and keeps which page is in use, so the agent and the app follow each other. It stops
// Chromium after a while with nobody connected.
//
// scripts/build-browser.sh builds this into KuvoCode/Resources/kuvo-browser.js, the file every box
// runs: with the scripts it runs in pages (page.ts), the agent's tools (tools.ts) and what agents are
// told of them (instructions.ts) filled in below, and the keeper's version (KEEPER).

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONFIG = {"instructions":"You work inside Kuvo Code, the Mac app the user talks to you in: sessions in projects, a side panel with changes, files, terminals and a browser, bots, group chats and remote machines. When the user asks how to do something in Kuvo Code itself (a setting, a button, bots, wake-ups, machines, a shortcut), read its documentation with webfetch rather than guessing, starting at https://www.kuvo.run/code/docs/ (pages at https://www.kuvo.run/code/docs/<page>/: sessions, changes, panel, browsing, machines, bots, integrations, customize, settings, usage, shortcuts, privacy, troubleshooting), and answer briefly from it, saying where in the app to find it. A service the user connected as an integration (Notion, Linear, GitHub, Slack, their mail or calendar…) has regular tools named after it (notion_notion-search, linear_list_issues…), which you call directly, not through execute (they aren't in its catalog; if Code Mode says a namespace such as notion is no longer available, the regular tools are still there). Use those: they reach the user's account directly, signed in as them, so never open that service's website instead, nor tell the user you'll use the browser for it. If one of those tools fails or says it needs signing in, say so and ask the user to sign in under Settings › Integrations. Use the browser for services you have no tools for, or when the user asks for a website itself: they're signed in to sites there, or can sign in when you ask. To show the user a file or folder (one they ask to see or open, or what you made), use show_in_panel; to put a file in the conversation itself (a picture, a chart, a PDF), show_file. When the user's message ends with a <from-phone> block, they're on their iPhone, where file paths and the side panel don't reach: show files with show_file, and keep replies short. show_widget draws your HTML live in the conversation, for when seeing or trying something (a chart of real numbers, options side by side, a value to tune) beats reading it; ask a plain choice with your question tool, and draw a diagram as a ```mermaid block in your reply. You're one of the user's agents: list_agents lists their bots and other sessions, on their Mac and machines; send_message writes to one (to hand off work, ask what it knows, or report back), and read_conversation reads one's conversation without interrupting it. A message from one says who it's from. When the user names one with & (like &Mira), their message ends with who that is and its address: read its conversation when they ask about its work, and write to it when they want something from it. When the user asks for another session (a separate or parallel one they can follow and talk to), start it with start_session; a subagent is only for work you hand off and get back yourself, out of view. For sessions you start: list_sessions, answer_ask (only what you could do yourself), stop_session, compact_session (when one's context is getting full) and list_models; make_project makes a project (the user is asked first), list_projects lists them. To come back to this conversation later, even while the user is away, use schedule_wake_up (once, or again and again with every), or watch_for_change to wake only when something you watch changes, so don't keep checking or sleep in a command; list_wake_ups and cancel_wake_up manage them. Never say you can't come back later or run on a timer. For work that's to go on for good (every morning, every week), suggest a bot (the + beside Bots in the sidebar), or hand it to a bot whose job it fits with send_message. Don't look for another way to schedule anything.\n\nYou browse in the browser on this machine, which the user can watch in Kuvo Code's panel. localhost is this machine, so you can open servers you run here. Start with browser_navigate, read pages with browser_snapshot, and act on elements by their number. To sign in, and whenever a page you open asks you to (even if the user didn't mention signing in), call browser_sign_in right away rather than asking in the chat whether to; for a one-time code, use browser_ask_code, and for anything only the user can do (a CAPTCHA, approving on their phone), browser_ask_user. These ask the user in a card in Kuvo Code, where they can also say no, so never ask for a password or a code in the chat. For a \"Continue with Google\" (or Apple) sign-in, click it and sign in on the page it opens the same way; if that page won't let you, use browser_ask_user.","scripts":{"click":"const element = find(index);\nif (!element) return missing(index);\ndocument.getElementById('playwright-highlight-container')?.remove();\nelement.scrollIntoView({ block: 'center', inline: 'nearest' });\nconst view = viewOf(element);\nconst rect = element.getBoundingClientRect();\nconst options = { bubbles: true, cancelable: true, composed: true, view, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };\nfor (const type of ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {\n  element.dispatchEvent(type.startsWith('pointer') ? new view.PointerEvent(type, options) : new view.MouseEvent(type, options));\n}\nif (typeof element.focus === 'function') element.focus();\nelement.click();\nreturn 'ok';","fieldKind":"const element = find(index);\nif (!element) return 'missing';\nreturn kindOf(element);","fileInput":"const element = find(index);\nif (!element) return 'missing';\nconst isFile = (node) => !!node && node.localName === 'input' && node.type === 'file';\nlet input = isFile(element) ? element : element.querySelector && element.querySelector('input[type=file]');\nconst label = element.closest && element.closest('label');\nif (!input && label && isFile(label.control)) input = label.control;\nfor (let around = element.parentElement, level = 0; !input && around && level < 3; around = around.parentElement, level++) {\n  const inside = around.querySelectorAll('input[type=file]');\n  if (inside.length === 1) input = inside[0];\n}\nfor (const root of new Set([element.getRootNode(), element.ownerDocument])) {\n  if (input || !root.querySelectorAll) continue;\n  const all = [...root.querySelectorAll('input[type=file]')];\n  if (all.length === 1) input = all[0];\n}\nreturn input || 'none';","fill":"const element = find(index);\nif (!element) return missing(index);\n// Only into a page of the site the user was asked about: its address may already show the\n// next site while this document is still the last one's.\nconst where = element.ownerDocument.location;\nconst here = where.protocol === 'file:' ? 'a file on this Mac' : where.protocol === 'http:' ? 'http://' + where.hostname : where.hostname;\nif (typeof site === 'string' && here !== site) {\n  return `The page isn't on ${site} now, so nothing was filled in. Take a fresh browser_snapshot and ask again.`;\n}\nconst kind = kindOf(element);\nif (wanted === 'password' ? kind !== 'password' : wanted === 'code' ? kind === 'other' : kind !== 'text') {\n  return wanted === 'password'\n    ? `[${index}] isn't a password field now: a password only goes into one. Nothing was filled in. Take a fresh browser_snapshot and ask again.`\n    : `[${index}] isn't a field for that now. Nothing was filled in. Take a fresh browser_snapshot and ask again.`;\n}\nelement.scrollIntoView({ block: 'center' });\nelement.focus();\nconst view = viewOf(element);\nconst prototype = element.localName === 'textarea' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;\nObject.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);\nelement.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));\nelement.dispatchEvent(new view.Event('change', { bubbles: true }));\nelement.setAttribute('data-kuvo-secret', '');\nreturn 'ok';","find":"const fingerprint = (element) => {\n  let text = '';\n  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);\n  while (text.length < 200 && walker.nextNode()) text += walker.currentNode.data + ' ';\n  const attribute = (name) => element.getAttribute(name) || '';\n  return [element.localName, attribute('type'), attribute('name'), attribute('role'), attribute('href'),\n    text.replace(/\\s+/g, ' ').trim().slice(0, 80).replace(/\\d+/g, '#')].join('|');\n};\n\nlet lost = 'none';\n// On the page now: in its document, and that document still in its frame, out to the page's own.\nconst attached = (element) => {\n  for (let node = element; node;) {\n    if (!node.isConnected) return false;\n    const doc = node.ownerDocument;\n    if (doc === document) return true;\n    const frame = doc.defaultView && doc.defaultView.frameElement;\n    if (!frame || frame.contentDocument !== doc) return false;\n    node = frame;\n  }\n  return false;\n};\nconst find = (number) => {\n  const map = window.__kuvoIndex;\n  const entry = map && map.elements ? map.elements[number] : null;\n  if (!entry) { lost = 'none'; return null; }\n  if (typeof kuvoSnapshot === 'string' && map.snapshot !== kuvoSnapshot) { lost = 'other'; return null; }\n  if (!attached(entry.element) || fingerprint(entry.element) !== entry.print) { lost = 'changed'; return null; }\n  return entry.element;\n};\nconst missing = (number) => lost === 'changed'\n  ? `The page changed since the snapshot: [${number}] is gone or isn't what it was. Take a fresh browser_snapshot.`\n  : lost === 'other'\n    ? `[${number}] is from a snapshot of another page or tab. Take a fresh browser_snapshot of this one.`\n    : `There's no element [${number}] on the page now. Take a fresh browser_snapshot.`;\n// The window an element is in (its frame's), whose events and types it takes.\nconst viewOf = (element) => element.ownerDocument.defaultView || window;\n// What kind of field an element is: \"password\", \"text\" (a username, an email, a code) or \"other\".\nconst kindOf = (element) => {\n  if (element.localName === 'input') {\n    const type = (element.type || 'text').toLowerCase();\n    if (type === 'password') return 'password';\n    return ['text', 'email', 'tel', 'number', 'search', 'url'].includes(type) ? 'text' : 'other';\n  }\n  return element.localName === 'textarea' ? 'text' : 'other';\n};\n","handlers":"const everyElement = (visit) => {\n  let place = 0;\n  (function walk(root) {\n    for (const element of root.querySelectorAll('*')) {\n      visit(element, place++);\n      if (element.shadowRoot) walk(element.shadowRoot);\n      if (element.localName === 'iframe' || element.localName === 'frame') {\n        try { if (element.contentDocument) walk(element.contentDocument); } catch {}\n      }\n    }\n  })(document);\n};\n\nconst names = ['onclick', 'onmousedown', 'onmouseup', 'ondblclick'];\nconst found = [];\neveryElement((element, place) => {\n  const set = names.filter((name) => typeof element[name] === 'function' && !element.hasAttribute(name));\n  if (set.length) found.push([place, element.localName, set]);\n});\nreturn found;","mask":"const roots = [];\n(function collect(root) {\n  roots.push(root);\n  for (const element of root.querySelectorAll('*')) {\n    if (element.shadowRoot) collect(element.shadowRoot);\n    if (element.localName === 'iframe' || element.localName === 'frame') {\n      try { if (element.contentDocument) collect(element.contentDocument); } catch {}\n    }\n  }\n})(document);\n\nfor (const root of roots) {\n  if (!root.querySelector('[data-kuvo-secret]') || root.getElementById('kuvo-secret-mask')) continue;\n  const doc = root.ownerDocument || root;\n  const style = doc.createElement('style');\n  style.id = 'kuvo-secret-mask';\n  style.textContent = '[data-kuvo-secret]{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}';\n  (root.head || root.documentElement || root).appendChild(style);\n}\nreturn 'ok';","press":"let target = document.activeElement || document.body;\nfor (;;) {\n  const frame = (target.localName === 'iframe' || target.localName === 'frame') && target.contentDocument;\n  const inner = target.shadowRoot ? target.shadowRoot.activeElement : frame ? frame.activeElement : null;\n  if (!inner || inner === target) break;\n  target = inner;\n}\nconst view = target.ownerDocument.defaultView || window;\nconst codes = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32 };\nconst init = { key: key, code: key, keyCode: codes[key] || 0, which: codes[key] || 0, bubbles: true, cancelable: true, composed: true };\nconst proceed = target.dispatchEvent(new view.KeyboardEvent('keydown', init));\nif (key === 'Enter') target.dispatchEvent(new view.KeyboardEvent('keypress', init));\ntarget.dispatchEvent(new view.KeyboardEvent('keyup', init));\nif (key === 'Enter' && proceed && target.form) target.form.requestSubmit ? target.form.requestSubmit() : target.form.submit();\nif (key === 'Escape' && typeof target.blur === 'function') target.blur();\nreturn 'ok';","printMask":"const roots = [];\n(function collect(root) {\n  roots.push(root);\n  for (const element of root.querySelectorAll('*')) {\n    if (element.shadowRoot) collect(element.shadowRoot);\n    if (element.localName === 'iframe' || element.localName === 'frame') {\n      try { if (element.contentDocument) collect(element.contentDocument); } catch {}\n    }\n  }\n})(document);\n\nfor (const root of roots) {\n  if (!root.querySelector('[data-kuvo-secret]') || root.getElementById('kuvo-secret-print-mask')) continue;\n  const doc = root.ownerDocument || root;\n  const style = doc.createElement('style');\n  style.id = 'kuvo-secret-print-mask';\n  style.textContent = '[data-kuvo-secret]{visibility:hidden!important}';\n  (root.head || root.documentElement || root).appendChild(style);\n}\nreturn 'ok';","printUnmask":"const roots = [];\n(function collect(root) {\n  roots.push(root);\n  for (const element of root.querySelectorAll('*')) {\n    if (element.shadowRoot) collect(element.shadowRoot);\n    if (element.localName === 'iframe' || element.localName === 'frame') {\n      try { if (element.contentDocument) collect(element.contentDocument); } catch {}\n    }\n  }\n})(document);\n\nfor (const root of roots) root.getElementById('kuvo-secret-print-mask')?.remove();\nreturn 'ok';","rect":"const element = find(index);\nif (!element) return '';\nelement.scrollIntoView({ block: 'center', inline: 'nearest' });\nconst r = element.getBoundingClientRect();\nlet x = r.left, y = r.top;\n// In a frame: plus where the frame's content is, out to the page's own window.\nfor (let view = viewOf(element); view !== window && view.frameElement; view = view.parent) {\n  const frame = view.frameElement, box = frame.getBoundingClientRect(), style = view.parent.getComputedStyle(frame);\n  x += box.left + frame.clientLeft + (parseFloat(style.paddingLeft) || 0);\n  y += box.top + frame.clientTop + (parseFloat(style.paddingTop) || 0);\n}\nreturn JSON.stringify({ x, y, width: r.width, height: r.height });","select":"const element = find(index);\nif (!element) return missing(index);\nif (element.localName !== 'select') return `[${index}] isn't a list to select from.`;\nconst view = viewOf(element);\nconst wanted = option.toLowerCase();\nconst match = Array.from(element.options).find((item) => item.text.trim().toLowerCase() === wanted || item.value.toLowerCase() === wanted);\nif (!match) return `No option “${option}” in [${index}]. Options: ` + Array.from(element.options).map((item) => item.text.trim()).join(', ');\nelement.value = match.value;\nelement.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));\nelement.dispatchEvent(new view.Event('change', { bubbles: true }));\nreturn 'ok';","snapshot":"document.getElementById('playwright-highlight-container')?.remove();\nconst numbered = {};\nconst everyElement = (visit) => {\n  let place = 0;\n  (function walk(root) {\n    for (const element of root.querySelectorAll('*')) {\n      visit(element, place++);\n      if (element.shadowRoot) walk(element.shadowRoot);\n      if (element.localName === 'iframe' || element.localName === 'frame') {\n        try { if (element.contentDocument) walk(element.contentDocument); } catch {}\n      }\n    }\n  })(document);\n};\n\nconst lent = [];\nif (typeof kuvoHandlers === 'object' && kuvoHandlers && kuvoHandlers.length) {\n  const handlers = new Map(kuvoHandlers.map((entry) => [entry[0], entry]));\n  everyElement((element, place) => {\n    const entry = handlers.get(place);\n    if (!entry || entry[1] !== element.localName) return;\n    for (const name of entry[2]) {\n      Object.defineProperty(element, name, { value: () => {}, configurable: true });\n      lent.push([element, name]);\n    }\n  });\n}\nlet result;\ntry {\n  result = ((\n  args = {\n    doHighlightElements: true,\n    focusHighlightIndex: -1,\n    viewportExpansion: 0,\n    debugMode: false,\n  }\n) => {\n  const { doHighlightElements, focusHighlightIndex, viewportExpansion, debugMode } = args;\n  let highlightIndex = 0; // Reset highlight index\n\n  // Add timing stack to handle recursion\n  const TIMING_STACK = {\n    nodeProcessing: [],\n    treeTraversal: [],\n    highlighting: [],\n    current: null\n  };\n\n  function pushTiming(type) {\n    TIMING_STACK[type] = TIMING_STACK[type] || [];\n    TIMING_STACK[type].push(performance.now());\n  }\n\n  function popTiming(type) {\n    const start = TIMING_STACK[type].pop();\n    const duration = performance.now() - start;\n    return duration;\n  }\n\n  // Only initialize performance tracking if in debug mode\n  const PERF_METRICS = debugMode ? {\n    buildDomTreeCalls: 0,\n    timings: {\n      buildDomTree: 0,\n      highlightElement: 0,\n      isInteractiveElement: 0,\n      isElementVisible: 0,\n      isTopElement: 0,\n      isInExpandedViewport: 0,\n      isTextNodeVisible: 0,\n      getEffectiveScroll: 0,\n    },\n    cacheMetrics: {\n      boundingRectCacheHits: 0,\n      boundingRectCacheMisses: 0,\n      computedStyleCacheHits: 0,\n      computedStyleCacheMisses: 0,\n      getBoundingClientRectTime: 0,\n      getComputedStyleTime: 0,\n      boundingRectHitRate: 0,\n      computedStyleHitRate: 0,\n      overallHitRate: 0,\n      clientRectsCacheHits: 0,\n      clientRectsCacheMisses: 0,\n    },\n    nodeMetrics: {\n      totalNodes: 0,\n      processedNodes: 0,\n      skippedNodes: 0,\n    },\n    buildDomTreeBreakdown: {\n      totalTime: 0,\n      totalSelfTime: 0,\n      buildDomTreeCalls: 0,\n      domOperations: {\n        getBoundingClientRect: 0,\n        getComputedStyle: 0,\n      },\n      domOperationCounts: {\n        getBoundingClientRect: 0,\n        getComputedStyle: 0,\n      }\n    }\n  } : null;\n\n  // Simple timing helper that only runs in debug mode\n  function measureTime(fn) {\n    if (!debugMode) return fn;\n    return function (...args) {\n      const start = performance.now();\n      const result = fn.apply(this, args);\n      const duration = performance.now() - start;\n      return result;\n    };\n  }\n\n  // Helper to measure DOM operations\n  function measureDomOperation(operation, name) {\n    if (!debugMode) return operation();\n\n    const start = performance.now();\n    const result = operation();\n    const duration = performance.now() - start;\n\n    if (PERF_METRICS && name in PERF_METRICS.buildDomTreeBreakdown.domOperations) {\n      PERF_METRICS.buildDomTreeBreakdown.domOperations[name] += duration;\n      PERF_METRICS.buildDomTreeBreakdown.domOperationCounts[name]++;\n    }\n\n    return result;\n  }\n\n  // Add caching mechanisms at the top level\n  const DOM_CACHE = {\n    boundingRects: new WeakMap(),\n    clientRects: new WeakMap(),\n    computedStyles: new WeakMap(),\n    clearCache: () => {\n      DOM_CACHE.boundingRects = new WeakMap();\n      DOM_CACHE.clientRects = new WeakMap();\n      DOM_CACHE.computedStyles = new WeakMap();\n    }\n  };\n\n  // Cache helper functions\n  function getCachedBoundingRect(element) {\n    if (!element) return null;\n\n    if (DOM_CACHE.boundingRects.has(element)) {\n      if (debugMode && PERF_METRICS) {\n        PERF_METRICS.cacheMetrics.boundingRectCacheHits++;\n      }\n      return DOM_CACHE.boundingRects.get(element);\n    }\n\n    if (debugMode && PERF_METRICS) {\n      PERF_METRICS.cacheMetrics.boundingRectCacheMisses++;\n    }\n\n    let rect;\n    if (debugMode) {\n      const start = performance.now();\n      rect = element.getBoundingClientRect();\n      const duration = performance.now() - start;\n      if (PERF_METRICS) {\n        PERF_METRICS.buildDomTreeBreakdown.domOperations.getBoundingClientRect += duration;\n        PERF_METRICS.buildDomTreeBreakdown.domOperationCounts.getBoundingClientRect++;\n      }\n    } else {\n      rect = element.getBoundingClientRect();\n    }\n\n    if (rect) {\n      DOM_CACHE.boundingRects.set(element, rect);\n    }\n    return rect;\n  }\n\n  function getCachedComputedStyle(element) {\n    if (!element) return null;\n\n    if (DOM_CACHE.computedStyles.has(element)) {\n      if (debugMode && PERF_METRICS) {\n        PERF_METRICS.cacheMetrics.computedStyleCacheHits++;\n      }\n      return DOM_CACHE.computedStyles.get(element);\n    }\n\n    if (debugMode && PERF_METRICS) {\n      PERF_METRICS.cacheMetrics.computedStyleCacheMisses++;\n    }\n\n    let style;\n    if (debugMode) {\n      const start = performance.now();\n      style = window.getComputedStyle(element);\n      const duration = performance.now() - start;\n      if (PERF_METRICS) {\n        PERF_METRICS.buildDomTreeBreakdown.domOperations.getComputedStyle += duration;\n        PERF_METRICS.buildDomTreeBreakdown.domOperationCounts.getComputedStyle++;\n      }\n    } else {\n      style = window.getComputedStyle(element);\n    }\n\n    if (style) {\n      DOM_CACHE.computedStyles.set(element, style);\n    }\n    return style;\n  }\n\n  // Add a new function to get cached client rects\n  function getCachedClientRects(element) {\n    if (!element) return null;\n    \n    if (DOM_CACHE.clientRects.has(element)) {\n      if (debugMode && PERF_METRICS) {\n        PERF_METRICS.cacheMetrics.clientRectsCacheHits++;\n      }\n      return DOM_CACHE.clientRects.get(element);\n    }\n    \n    if (debugMode && PERF_METRICS) {\n      PERF_METRICS.cacheMetrics.clientRectsCacheMisses++;\n    }\n    \n    const rects = element.getClientRects();\n    \n    if (rects) {\n      DOM_CACHE.clientRects.set(element, rects);\n    }\n    return rects;\n  }\n\n  /**\n   * Hash map of DOM nodes indexed by their highlight index.\n   *\n   * @type {Object<string, any>}\n   */\n  const DOM_HASH_MAP = {};\n\n  const ID = { current: 0 };\n\n  const HIGHLIGHT_CONTAINER_ID = \"playwright-highlight-container\";\n\n  // Add a WeakMap cache for XPath strings\n  const xpathCache = new WeakMap();\n\n  // Initialize once and reuse\n  const viewportObserver = new IntersectionObserver(\n    (entries) => {\n      entries.forEach(entry => {\n        elementVisibilityMap.set(entry.target, entry.isIntersecting);\n      });\n    },\n    { rootMargin: `${viewportExpansion}px` }\n  );\n\n  /**\n   * Highlights an element in the DOM and returns the index of the next element.\n   */\n  function highlightElement(element, index, parentIframe = null) {\n    pushTiming('highlighting');\n    \n    if (!element) return index;\n\n    // Store overlays and the single label for updating\n    const overlays = [];\n    let label = null;\n    let labelWidth = 20;\n    let labelHeight = 16;\n    let cleanupFn = null;\n\n    try {\n      // Create or get highlight container\n      let container = document.getElementById(HIGHLIGHT_CONTAINER_ID);\n      if (!container) {\n        container = document.createElement(\"div\");\n        container.id = HIGHLIGHT_CONTAINER_ID;\n        container.style.position = \"fixed\";\n        container.style.pointerEvents = \"none\";\n        container.style.top = \"0\";\n        container.style.left = \"0\";\n        container.style.width = \"100%\";\n        container.style.height = \"100%\";\n        container.style.zIndex = \"2147483640\";\n        container.style.backgroundColor = 'transparent';\n        document.body.appendChild(container);\n      }\n\n      // Get element client rects\n      const rects = element.getClientRects(); // Use getClientRects()\n\n      if (!rects || rects.length === 0) return index; // Exit if no rects\n\n      // Generate a color based on the index\n      const colors = [\n        \"#FF0000\",\n        \"#00FF00\",\n        \"#0000FF\",\n        \"#FFA500\",\n        \"#800080\",\n        \"#008080\",\n        \"#FF69B4\",\n        \"#4B0082\",\n        \"#FF4500\",\n        \"#2E8B57\",\n        \"#DC143C\",\n        \"#4682B4\",\n      ];\n      const colorIndex = index % colors.length;\n      const baseColor = colors[colorIndex];\n      const backgroundColor = baseColor + \"1A\"; // 10% opacity version of the color\n\n      // Get iframe offset if necessary\n      let iframeOffset = { x: 0, y: 0 };\n      if (parentIframe) {\n        const iframeRect = parentIframe.getBoundingClientRect(); // Keep getBoundingClientRect for iframe offset\n        iframeOffset.x = iframeRect.left;\n        iframeOffset.y = iframeRect.top;\n      }\n\n      // Create fragment to hold overlay elements\n      const fragment = document.createDocumentFragment();\n\n      // Create highlight overlays for each client rect\n      for (const rect of rects) {\n        if (rect.width === 0 || rect.height === 0) continue; // Skip empty rects\n\n        const overlay = document.createElement(\"div\");\n        overlay.style.position = \"fixed\";\n        overlay.style.border = `2px solid ${baseColor}`;\n        overlay.style.backgroundColor = backgroundColor;\n        overlay.style.pointerEvents = \"none\";\n        overlay.style.boxSizing = \"border-box\";\n\n        const top = rect.top + iframeOffset.y;\n        const left = rect.left + iframeOffset.x;\n\n        overlay.style.top = `${top}px`;\n        overlay.style.left = `${left}px`;\n        overlay.style.width = `${rect.width}px`;\n        overlay.style.height = `${rect.height}px`;\n\n        fragment.appendChild(overlay);\n        overlays.push({ element: overlay, initialRect: rect }); // Store overlay and its rect\n      }\n\n      // Create and position a single label relative to the first rect\n      const firstRect = rects[0];\n      label = document.createElement(\"div\");\n      label.className = \"playwright-highlight-label\";\n      label.style.position = \"fixed\";\n      label.style.background = baseColor;\n      label.style.color = \"white\";\n      label.style.padding = \"1px 4px\";\n      label.style.borderRadius = \"4px\";\n      label.style.fontSize = `${Math.min(12, Math.max(8, firstRect.height / 2))}px`;\n      label.textContent = index;\n\n      labelWidth = label.offsetWidth > 0 ? label.offsetWidth : labelWidth; // Update actual width if possible\n      labelHeight = label.offsetHeight > 0 ? label.offsetHeight : labelHeight; // Update actual height if possible\n\n      const firstRectTop = firstRect.top + iframeOffset.y;\n      const firstRectLeft = firstRect.left + iframeOffset.x;\n\n      let labelTop = firstRectTop + 2;\n      let labelLeft = firstRectLeft + firstRect.width - labelWidth - 2;\n\n      // Adjust label position if first rect is too small\n      if (firstRect.width < labelWidth + 4 || firstRect.height < labelHeight + 4) {\n        labelTop = firstRectTop - labelHeight - 2;\n        labelLeft = firstRectLeft + firstRect.width - labelWidth; // Align with right edge\n        if (labelLeft < iframeOffset.x) labelLeft = firstRectLeft; // Prevent going off-left\n      }\n\n      // Ensure label stays within viewport bounds slightly better\n      labelTop = Math.max(0, Math.min(labelTop, window.innerHeight - labelHeight));\n      labelLeft = Math.max(0, Math.min(labelLeft, window.innerWidth - labelWidth));\n\n\n      label.style.top = `${labelTop}px`;\n      label.style.left = `${labelLeft}px`;\n\n      fragment.appendChild(label);\n\n      // Update positions on scroll/resize\n      const updatePositions = () => {\n        const newRects = element.getClientRects(); // Get fresh rects\n        let newIframeOffset = { x: 0, y: 0 };\n\n        if (parentIframe) {\n          const iframeRect = parentIframe.getBoundingClientRect(); // Keep getBoundingClientRect for iframe\n          newIframeOffset.x = iframeRect.left;\n          newIframeOffset.y = iframeRect.top;\n        }\n\n        // Update each overlay\n        overlays.forEach((overlayData, i) => {\n          if (i < newRects.length) { // Check if rect still exists\n            const newRect = newRects[i];\n            const newTop = newRect.top + newIframeOffset.y;\n            const newLeft = newRect.left + newIframeOffset.x;\n\n            overlayData.element.style.top = `${newTop}px`;\n            overlayData.element.style.left = `${newLeft}px`;\n            overlayData.element.style.width = `${newRect.width}px`;\n            overlayData.element.style.height = `${newRect.height}px`;\n            overlayData.element.style.display = (newRect.width === 0 || newRect.height === 0) ? 'none' : 'block';\n          } else {\n            // If fewer rects now, hide extra overlays\n            overlayData.element.style.display = 'none';\n          }\n        });\n\n        // If there are fewer new rects than overlays, hide the extras\n        if (newRects.length < overlays.length) {\n          for (let i = newRects.length; i < overlays.length; i++) {\n            overlays[i].element.style.display = 'none';\n          }\n        }\n\n        // Update label position based on the first new rect\n        if (label && newRects.length > 0) {\n          const firstNewRect = newRects[0];\n          const firstNewRectTop = firstNewRect.top + newIframeOffset.y;\n          const firstNewRectLeft = firstNewRect.left + newIframeOffset.x;\n\n          let newLabelTop = firstNewRectTop + 2;\n          let newLabelLeft = firstNewRectLeft + firstNewRect.width - labelWidth - 2;\n\n          if (firstNewRect.width < labelWidth + 4 || firstNewRect.height < labelHeight + 4) {\n            newLabelTop = firstNewRectTop - labelHeight - 2;\n            newLabelLeft = firstNewRectLeft + firstNewRect.width - labelWidth;\n            if (newLabelLeft < newIframeOffset.x) newLabelLeft = firstNewRectLeft;\n          }\n\n          // Ensure label stays within viewport bounds\n          newLabelTop = Math.max(0, Math.min(newLabelTop, window.innerHeight - labelHeight));\n          newLabelLeft = Math.max(0, Math.min(newLabelLeft, window.innerWidth - labelWidth));\n\n          label.style.top = `${newLabelTop}px`;\n          label.style.left = `${newLabelLeft}px`;\n          label.style.display = 'block';\n        } else if (label) {\n          // Hide label if element has no rects anymore\n          label.style.display = 'none';\n        }\n      };\n\n      const throttleFunction = (func, delay) => {\n        let lastCall = 0;\n        return (...args) => {\n          const now = performance.now();\n          if (now - lastCall < delay) return;\n          lastCall = now;\n          return func(...args);\n        };\n      };\n\n      const throttledUpdatePositions = throttleFunction(updatePositions, 16); // ~60fps\n      window.addEventListener('scroll', throttledUpdatePositions, true);\n      window.addEventListener('resize', throttledUpdatePositions);\n      \n      // Add cleanup function\n      cleanupFn = () => {\n        window.removeEventListener('scroll', throttledUpdatePositions, true);\n        window.removeEventListener('resize', throttledUpdatePositions);\n        // Remove overlay elements if needed\n        overlays.forEach(overlay => overlay.element.remove());\n        if (label) label.remove();\n      };\n      \n      // Then add fragment to container in one operation\n      container.appendChild(fragment);\n      \n      return index + 1;\n    } finally {\n      popTiming('highlighting');\n      // Store cleanup function for later use\n      if (cleanupFn) {\n        // Keep a reference to cleanup functions in a global array\n        (window._highlightCleanupFunctions = window._highlightCleanupFunctions || []).push(cleanupFn);\n      }\n    }\n  }\n\n  // Add this function to perform cleanup when needed\n  function cleanupHighlights() {\n    if (window._highlightCleanupFunctions && window._highlightCleanupFunctions.length) {\n      window._highlightCleanupFunctions.forEach(fn => fn());\n      window._highlightCleanupFunctions = [];\n    }\n    \n    // Also remove the container\n    const container = document.getElementById(HIGHLIGHT_CONTAINER_ID);\n    if (container) container.remove();\n  }\n\n  function getElementPosition(currentElement) {\n    if (!currentElement.parentElement) {\n      return 0; // No parent means no siblings\n    }\n  \n    const tagName = currentElement.nodeName.toLowerCase();\n  \n    const siblings = Array.from(currentElement.parentElement.children)\n      .filter((sib) => sib.nodeName.toLowerCase() === tagName);\n  \n    if (siblings.length === 1) {\n      return 0; // Only element of its type\n    }\n  \n    const index = siblings.indexOf(currentElement) + 1; // 1-based index\n    return index;\n  }\n\n  /**\n   * Returns an XPath tree string for an element.\n   */\n  function getXPathTree(element, stopAtBoundary = true) {\n    if (xpathCache.has(element)) return xpathCache.get(element);\n    \n    const segments = [];\n    let currentElement = element;\n\n    while (currentElement && currentElement.nodeType === Node.ELEMENT_NODE) {\n      // Stop if we hit a shadow root or iframe\n      if (\n        stopAtBoundary &&\n        (currentElement.parentNode instanceof ShadowRoot ||\n          currentElement.parentNode instanceof HTMLIFrameElement)\n      ) {\n        break;\n      }\n\n      const position = getElementPosition(currentElement);\n      const tagName = currentElement.nodeName.toLowerCase();\n      const xpathIndex = position > 0 ? `[${position}]` : \"\";\n      segments.unshift(`${tagName}${xpathIndex}`);\n\n      currentElement = currentElement.parentNode;\n    }\n\n    const result = segments.join(\"/\");\n    xpathCache.set(element, result);\n    return result;\n  }\n\n  /**\n   * Checks if a text node is visible.\n   */\n  function isTextNodeVisible(textNode) {\n    try {\n      // Special case: when viewportExpansion is -1, consider all text nodes as visible\n      if (viewportExpansion === -1) {\n        // Still check parent visibility for basic filtering\n        const parentElement = textNode.parentElement;\n        if (!parentElement) return false;\n\n        try {\n          return parentElement.checkVisibility({\n            checkOpacity: true,\n            checkVisibilityCSS: true,\n          });\n        } catch (e) {\n          // Fallback if checkVisibility is not supported\n          const style = window.getComputedStyle(parentElement);\n          return style.display !== 'none' &&\n            style.visibility !== 'hidden' &&\n            style.opacity !== '0';\n        }\n      }\n      \n      const range = document.createRange();\n      range.selectNodeContents(textNode);\n      const rects = range.getClientRects(); // Use getClientRects for Range\n\n      if (!rects || rects.length === 0) {\n        return false;\n      }\n\n      let isAnyRectVisible = false;\n      let isAnyRectInViewport = false;\n\n      for (const rect of rects) {\n        // Check size\n        if (rect.width > 0 && rect.height > 0) {\n          isAnyRectVisible = true;\n\n          // Viewport check for this rect\n          if (!(\n            rect.bottom < -viewportExpansion ||\n            rect.top > window.innerHeight + viewportExpansion ||\n            rect.right < -viewportExpansion ||\n            rect.left > window.innerWidth + viewportExpansion\n          )) {\n            isAnyRectInViewport = true;\n            break; // Found a visible rect in viewport, no need to check others\n          }\n        }\n      }\n\n      if (!isAnyRectVisible || !isAnyRectInViewport) {\n        return false;\n      }\n\n      // Check parent visibility\n      const parentElement = textNode.parentElement;\n      if (!parentElement) return false;\n\n      try {\n        return parentElement.checkVisibility({\n          checkOpacity: true,\n          checkVisibilityCSS: true,\n        });\n      } catch (e) {\n        // Fallback if checkVisibility is not supported\n        const style = window.getComputedStyle(parentElement);\n        return style.display !== 'none' &&\n          style.visibility !== 'hidden' &&\n          style.opacity !== '0';\n      }\n    } catch (e) {\n      console.warn('Error checking text node visibility:', e);\n      return false;\n    }\n  }\n\n  // Helper function to check if element is accepted\n  function isElementAccepted(element) {\n    if (!element || !element.tagName) return false;\n\n    // Always accept body and common container elements\n    const alwaysAccept = new Set([\n      \"body\", \"div\", \"main\", \"article\", \"section\", \"nav\", \"header\", \"footer\"\n    ]);\n    const tagName = element.tagName.toLowerCase();\n\n    if (alwaysAccept.has(tagName)) return true;\n\n    const leafElementDenyList = new Set([\n      \"svg\",\n      \"script\",\n      \"style\",\n      \"link\",\n      \"meta\",\n      \"noscript\",\n      \"template\",\n    ]);\n\n    return !leafElementDenyList.has(tagName);\n  }\n\n  /**\n   * Checks if an element is visible.\n   */\n  function isElementVisible(element) {\n    const style = getCachedComputedStyle(element);\n    return (\n      element.offsetWidth > 0 &&\n      element.offsetHeight > 0 &&\n      style.visibility !== \"hidden\" &&\n      style.display !== \"none\"\n    );\n  }\n\n  /**\n   * Checks if an element is interactive.\n   * \n   * lots of comments, and uncommented code - to show the logic of what we already tried\n   * \n   * One of the things we tried at the beginning was also to use event listeners, and other fancy class, style stuff -> what actually worked best was just combining most things with computed cursor style :)\n   */\n  function isInteractiveElement(element) {\n    if (!element || element.nodeType !== Node.ELEMENT_NODE) {\n      return false;\n    }\n\n    // Cache the tagName and style lookups\n    const tagName = element.tagName.toLowerCase();\n    const style = getCachedComputedStyle(element);\n\n    // Define interactive cursors\n    const interactiveCursors = new Set([\n      'pointer',    // Link/clickable elements\n      'move',       // Movable elements\n      'text',       // Text selection\n      'grab',       // Grabbable elements\n      'grabbing',   // Currently grabbing\n      'cell',       // Table cell selection\n      'copy',       // Copy operation\n      'alias',      // Alias creation\n      'all-scroll', // Scrollable content\n      'col-resize', // Column resize\n      'context-menu', // Context menu available\n      'crosshair',  // Precise selection\n      'e-resize',   // East resize\n      'ew-resize',  // East-west resize\n      'help',       // Help available\n      'n-resize',   // North resize\n      'ne-resize',  // Northeast resize\n      'nesw-resize', // Northeast-southwest resize\n      'ns-resize',  // North-south resize\n      'nw-resize',  // Northwest resize\n      'nwse-resize', // Northwest-southeast resize\n      'row-resize', // Row resize\n      's-resize',   // South resize\n      'se-resize',  // Southeast resize\n      'sw-resize',  // Southwest resize\n      'vertical-text', // Vertical text selection\n      'w-resize',   // West resize\n      'zoom-in',    // Zoom in\n      'zoom-out'    // Zoom out\n    ]);\n\n    // Define non-interactive cursors\n    const nonInteractiveCursors = new Set([\n      'not-allowed', // Action not allowed\n      'no-drop',     // Drop not allowed\n      'wait',        // Processing\n      'progress',    // In progress\n      'initial',     // Initial value\n      'inherit'      // Inherited value\n      //? Let's just include all potentially clickable elements that are not specifically blocked\n      // 'none',        // No cursor\n      // 'default',     // Default cursor \n      // 'auto',        // Browser default\n    ]);\n\n    function doesElementHaveInteractivePointer(element) {\n      if (element.tagName.toLowerCase() === \"html\") return false;\n\n      if (interactiveCursors.has(style.cursor)) return true;\n\n      return false;\n    }\n\n    let isInteractiveCursor = doesElementHaveInteractivePointer(element);\n\n    // Genius fix for almost all interactive elements\n    if (isInteractiveCursor) {\n      return true;\n    }\n\n    const interactiveElements = new Set([\n      \"a\",          // Links\n      \"button\",     // Buttons\n      \"input\",      // All input types (text, checkbox, radio, etc.)\n      \"select\",     // Dropdown menus\n      \"textarea\",   // Text areas\n      \"details\",    // Expandable details\n      \"summary\",    // Summary element (clickable part of details)\n      \"label\",      // Form labels (often clickable)\n      \"option\",     // Select options\n      \"optgroup\",   // Option groups\n      \"fieldset\",   // Form fieldsets (can be interactive with legend)\n      \"legend\",     // Fieldset legends\n    ]);\n\n    // Define explicit disable attributes and properties\n    const explicitDisableTags = new Set([\n      'disabled',           // Standard disabled attribute\n      // 'aria-disabled',      // ARIA disabled state\n      'readonly',          // Read-only state\n      // 'aria-readonly',     // ARIA read-only state\n      // 'aria-hidden',       // Hidden from accessibility\n      // 'hidden',            // Hidden attribute\n      // 'inert',             // Inert attribute\n      // 'aria-inert',        // ARIA inert state\n      // 'tabindex=\"-1\"',     // Removed from tab order\n      // 'aria-hidden=\"true\"' // Hidden from screen readers\n    ]);\n\n    // handle inputs, select, checkbox, radio, textarea, button and make sure they are not cursor style disabled/not-allowed\n    if (interactiveElements.has(tagName)) {\n      // Check for non-interactive cursor\n      if (nonInteractiveCursors.has(style.cursor)) {\n        return false;\n      }\n\n      // Check for explicit disable attributes\n      for (const disableTag of explicitDisableTags) {\n        if (element.hasAttribute(disableTag) ||\n          element.getAttribute(disableTag) === 'true' ||\n          element.getAttribute(disableTag) === '') {\n          return false;\n        }\n      }\n\n      // Check for disabled property on form elements\n      if (element.disabled) {\n        return false;\n      }\n\n      // Check for readonly property on form elements\n      if (element.readOnly) {\n        return false;\n      }\n\n      // Check for inert property\n      if (element.inert) {\n        return false;\n      }\n\n      return true;\n    }\n\n    const role = element.getAttribute(\"role\");\n    const ariaRole = element.getAttribute(\"aria-role\");\n\n    // Check for contenteditable attribute\n    if (element.getAttribute(\"contenteditable\") === \"true\" || element.isContentEditable) {\n      return true;\n    }\n    \n    // Added enhancement to capture dropdown interactive elements\n    if (element.classList && (\n      element.classList.contains(\"button\") ||\n      element.classList.contains('dropdown-toggle') ||\n      element.getAttribute('data-index') ||\n      element.getAttribute('data-toggle') === 'dropdown' ||\n      element.getAttribute('aria-haspopup') === 'true'\n    )) {\n      return true;\n    }\n\n    const interactiveRoles = new Set([\n      'button',           // Directly clickable element\n      // 'link',            // Clickable link\n      // 'menuitem',        // Clickable menu item\n      'menuitemradio',   // Radio-style menu item (selectable)\n      'menuitemcheckbox', // Checkbox-style menu item (toggleable)\n      'radio',           // Radio button (selectable)\n      'checkbox',        // Checkbox (toggleable)\n      'tab',             // Tab (clickable to switch content)\n      'switch',          // Toggle switch (clickable to change state)\n      'slider',          // Slider control (draggable)\n      'spinbutton',      // Number input with up/down controls\n      'combobox',        // Dropdown with text input\n      'searchbox',       // Search input field\n      'textbox',         // Text input field\n      // 'listbox',         // Selectable list\n      'option',          // Selectable option in a list\n      'scrollbar'        // Scrollable control\n    ]);\n\n    // Basic role/attribute checks\n    const hasInteractiveRole =\n      interactiveElements.has(tagName) ||\n      interactiveRoles.has(role) ||\n      interactiveRoles.has(ariaRole);\n\n    if (hasInteractiveRole) return true;\n\n    // check whether element has event listeners by window.getEventListeners\n    try {\n      if (typeof getEventListeners === 'function') {\n        const listeners = getEventListeners(element);\n        const mouseEvents = ['click', 'mousedown', 'mouseup', 'dblclick'];\n        for (const eventType of mouseEvents) {\n          if (listeners[eventType] && listeners[eventType].length > 0) {\n            return true; // Found a mouse interaction listener\n          }\n        }\n      }\n\n      const getEventListenersForNode = element?.ownerDocument?.defaultView?.getEventListenersForNode || window.getEventListenersForNode;\n      if (typeof getEventListenersForNode === 'function') {\n        const listeners = getEventListenersForNode(element);\n          const interactionEvents = ['click', 'mousedown', 'mouseup', 'keydown', 'keyup', 'submit', 'change', 'input', 'focus', 'blur'];\n          for (const eventType of interactionEvents) {\n            for (const listener of listeners) {\n              if (listener.type === eventType) {\n                 return true; // Found a common interaction listener\n              }\n            }\n          }\n      }\n      // Fallback: Check common event attributes if getEventListeners is not available (getEventListeners doesn't work in page.evaluate context)\n        const commonMouseAttrs = ['onclick', 'onmousedown', 'onmouseup', 'ondblclick'];\n        for (const attr of commonMouseAttrs) {\n          if (element.hasAttribute(attr) || typeof element[attr] === 'function') {\n            return true;\n          }\n        }\n    } catch (e) {\n      // console.warn(`Could not check event listeners for ${element.tagName}:`, e);\n      // If checking listeners fails, rely on other checks\n    }\n\n    return false\n  }\n\n\n  /**\n   * Checks if an element is the topmost element at its position.\n   */\n  function isTopElement(element) {\n    // Special case: when viewportExpansion is -1, consider all elements as \"top\" elements\n    if (viewportExpansion === -1) {\n      return true;\n    }\n    \n    const rects = getCachedClientRects(element); // Replace element.getClientRects()\n\n    if (!rects || rects.length === 0) {\n      return false; // No geometry, cannot be top\n    }\n\n    let isAnyRectInViewport = false;\n    for (const rect of rects) {\n      // Use the same logic as isInExpandedViewport check\n      if (rect.width > 0 && rect.height > 0 && !( // Only check non-empty rects\n        rect.bottom < -viewportExpansion ||\n        rect.top > window.innerHeight + viewportExpansion ||\n        rect.right < -viewportExpansion ||\n        rect.left > window.innerWidth + viewportExpansion\n      )) {\n        isAnyRectInViewport = true;\n        break;\n      }\n    }\n\n    if (!isAnyRectInViewport) {\n      return false; // All rects are outside the viewport area\n    }\n\n\n    // Find the correct document context and root element\n    let doc = element.ownerDocument;\n\n    // If we're in an iframe, elements are considered top by default\n    if (doc !== window.document) {\n      return true;\n    }\n\n    // For shadow DOM, we need to check within its own root context\n    const shadowRoot = element.getRootNode();\n    if (shadowRoot instanceof ShadowRoot) {\n      const centerX = rects[Math.floor(rects.length / 2)].left + rects[Math.floor(rects.length / 2)].width / 2;\n      const centerY = rects[Math.floor(rects.length / 2)].top + rects[Math.floor(rects.length / 2)].height / 2;\n\n      try {\n        const topEl = measureDomOperation(\n          () => shadowRoot.elementFromPoint(centerX, centerY),\n          'elementFromPoint'\n        );\n        if (!topEl) return false;\n\n        let current = topEl;\n        while (current && current !== shadowRoot) {\n          if (current === element) return true;\n          current = current.parentElement;\n        }\n        return false;\n      } catch (e) {\n        return true;\n      }\n    }\n\n    // For elements in viewport, check if they're topmost\n    const centerX = rects[Math.floor(rects.length / 2)].left + rects[Math.floor(rects.length / 2)].width / 2;\n    const centerY = rects[Math.floor(rects.length / 2)].top + rects[Math.floor(rects.length / 2)].height / 2;\n\n    try {\n      const topEl = document.elementFromPoint(centerX, centerY);\n      if (!topEl) return false;\n\n      let current = topEl;\n      while (current && current !== document.documentElement) {\n        if (current === element) return true;\n        current = current.parentElement;\n      }\n      return false;\n    } catch (e) {\n      return true;\n    }\n  }\n\n  /**\n   * Checks if an element is within the expanded viewport.\n   */\n  function isInExpandedViewport(element, viewportExpansion) {\n    if (viewportExpansion === -1) {\n      return true;\n    }\n\n    const rects = element.getClientRects(); // Use getClientRects\n\n    if (!rects || rects.length === 0) {\n      // Fallback to getBoundingClientRect if getClientRects is empty,\n      // useful for elements like <svg> that might not have client rects but have a bounding box.\n      const boundingRect = getCachedBoundingRect(element);\n      if (!boundingRect || boundingRect.width === 0 || boundingRect.height === 0) {\n        return false;\n      }\n      return !(\n        boundingRect.bottom < -viewportExpansion ||\n        boundingRect.top > window.innerHeight + viewportExpansion ||\n        boundingRect.right < -viewportExpansion ||\n        boundingRect.left > window.innerWidth + viewportExpansion\n      );\n    }\n\n    // Check if *any* client rect is within the viewport\n    for (const rect of rects) {\n      if (rect.width === 0 || rect.height === 0) continue; // Skip empty rects\n\n      if (!(\n        rect.bottom < -viewportExpansion ||\n        rect.top > window.innerHeight + viewportExpansion ||\n        rect.right < -viewportExpansion ||\n        rect.left > window.innerWidth + viewportExpansion\n      )) {\n        return true; // Found at least one rect in the viewport\n      }\n    }\n\n    return false; // No rects were found in the viewport\n  }\n\n  // Add this new helper function\n  function getEffectiveScroll(element) {\n    let currentEl = element;\n    let scrollX = 0;\n    let scrollY = 0;\n\n    return measureDomOperation(() => {\n      while (currentEl && currentEl !== document.documentElement) {\n        if (currentEl.scrollLeft || currentEl.scrollTop) {\n          scrollX += currentEl.scrollLeft;\n          scrollY += currentEl.scrollTop;\n        }\n        currentEl = currentEl.parentElement;\n      }\n\n      scrollX += window.scrollX;\n      scrollY += window.scrollY;\n\n      return { scrollX, scrollY };\n    }, 'scrollOperations');\n  }\n\n  // Add these helper functions at the top level\n  function isInteractiveCandidate(element) {\n    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;\n\n    const tagName = element.tagName.toLowerCase();\n\n    // Fast-path for common interactive elements\n    const interactiveElements = new Set([\n      \"a\", \"button\", \"input\", \"select\", \"textarea\", \"details\", \"summary\", \"label\"\n    ]);\n\n    if (interactiveElements.has(tagName)) return true;\n\n    // Quick attribute checks without getting full lists\n    const hasQuickInteractiveAttr = element.hasAttribute(\"onclick\") ||\n      element.hasAttribute(\"role\") ||\n      element.hasAttribute(\"tabindex\") ||\n      element.hasAttribute(\"aria-\") ||\n      element.hasAttribute(\"data-action\") ||\n      element.getAttribute(\"contenteditable\") === \"true\";\n\n    return hasQuickInteractiveAttr;\n  }\n\n  // --- Define constants for distinct interaction check ---\n  const DISTINCT_INTERACTIVE_TAGS = new Set([\n    'a', 'button', 'input', 'select', 'textarea', 'summary', 'details', 'label', 'option'\n  ]);\n  const INTERACTIVE_ROLES = new Set([\n    'button', 'link', 'menuitem', 'menuitemradio', 'menuitemcheckbox',\n    'radio', 'checkbox', 'tab', 'switch', 'slider', 'spinbutton',\n    'combobox', 'searchbox', 'textbox', 'listbox', 'option', 'scrollbar'\n  ]);\n\n  /**\n   * Heuristically determines if an element should be considered as independently interactive,\n   * even if it's nested inside another interactive container.\n   *\n   * This function helps detect deeply nested actionable elements (e.g., menu items within a button)\n   * that may not be picked up by strict interactivity checks.\n   */\n  function isHeuristicallyInteractive(element) {\n    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;\n\n    // Skip non-visible elements early for performance\n    if (!isElementVisible(element)) return false;\n\n    // Check for common attributes that often indicate interactivity\n    const hasInteractiveAttributes =\n      element.hasAttribute('role') ||\n      element.hasAttribute('tabindex') ||\n      element.hasAttribute('onclick') ||\n      typeof element.onclick === 'function';\n\n    // Check for semantic class names suggesting interactivity\n    const hasInteractiveClass = /\\b(btn|clickable|menu|item|entry|link)\\b/i.test(element.className || '');\n\n    // Determine whether the element is inside a known interactive container\n    const isInKnownContainer = Boolean(\n      element.closest('button,a,[role=\"button\"],.menu,.dropdown,.list,.toolbar')\n    );\n\n    // Ensure the element has at least one visible child (to avoid marking empty wrappers)\n    const hasVisibleChildren = [...element.children].some(isElementVisible);\n\n    // Avoid highlighting elements whose parent is <body> (top-level wrappers)\n    const isParentBody = element.parentElement && element.parentElement.isSameNode(document.body);\n\n    return (\n      (isInteractiveElement(element) || hasInteractiveAttributes || hasInteractiveClass) &&\n      hasVisibleChildren &&\n      isInKnownContainer &&\n      !isParentBody\n    );\n  }\n\n  /**\n   * Checks if an element likely represents a distinct interaction\n   * separate from its parent (if the parent is also interactive).\n   */\n  function isElementDistinctInteraction(element) {\n    if (!element || element.nodeType !== Node.ELEMENT_NODE) {\n      return false;\n    }\n\n    const tagName = element.tagName.toLowerCase();\n    const role = element.getAttribute('role');\n\n    // Check if it's an iframe - always distinct boundary\n    if (tagName === 'iframe') {\n      return true;\n    }\n\n    // Check tag name\n    if (DISTINCT_INTERACTIVE_TAGS.has(tagName)) {\n      return true;\n    }\n    // Check interactive roles\n    if (role && INTERACTIVE_ROLES.has(role)) {\n      return true;\n    }\n    // Check contenteditable\n    if (element.isContentEditable || element.getAttribute('contenteditable') === 'true') {\n      return true;\n    }\n    // Check for common testing/automation attributes\n    if (element.hasAttribute('data-testid') || element.hasAttribute('data-cy') || element.hasAttribute('data-test')) {\n      return true;\n    }\n    // Check for explicit onclick handler (attribute or property)\n    if (element.hasAttribute('onclick') || typeof element.onclick === 'function') {\n      return true;\n    }\n    \n    // Check for other common interaction event listeners\n    try {\n      const getEventListenersForNode = element?.ownerDocument?.defaultView?.getEventListenersForNode || window.getEventListenersForNode;\n      if (typeof getEventListenersForNode === 'function') {\n        const listeners = getEventListenersForNode(element);\n        const interactionEvents = ['click', 'mousedown', 'mouseup', 'keydown', 'keyup', 'submit', 'change', 'input', 'focus', 'blur'];\n        for (const eventType of interactionEvents) {\n          for (const listener of listeners) {\n            if (listener.type === eventType) {\n               return true; // Found a common interaction listener\n            }\n          }\n        }\n      }\n      // Fallback: Check common event attributes if getEventListeners is not available (getEventListenersForNode doesn't work in page.evaluate context)\n        const commonEventAttrs = ['onmousedown', 'onmouseup', 'onkeydown', 'onkeyup', 'onsubmit', 'onchange', 'oninput', 'onfocus', 'onblur'];\n        if (commonEventAttrs.some(attr => element.hasAttribute(attr))) {\n          return true;\n        }\n    } catch (e) {\n      // console.warn(`Could not check event listeners for ${element.tagName}:`, e);\n      // If checking listeners fails, rely on other checks\n    }\n\n    // if the element is not strictly interactive but appears clickable based on heuristic signals\n    if (isHeuristicallyInteractive(element)) {\n      return true;\n    }\n\n    // Default to false: if it's interactive but doesn't match above,\n    // assume it triggers the same action as the parent.\n    return false;\n  }\n  // --- End distinct interaction check ---\n\n  /**\n   * Handles the logic for deciding whether to highlight an element and performing the highlight.\n   */\n  function handleHighlighting(nodeData, node, parentIframe, isParentHighlighted) {\n    if (!nodeData.isInteractive) return false; // Not interactive, definitely don't highlight\n\n    let shouldHighlight = false;\n    if (!isParentHighlighted) {\n      // Parent wasn't highlighted, this interactive node can be highlighted.\n      shouldHighlight = true;\n    } else {\n      // Parent *was* highlighted. Only highlight this node if it represents a distinct interaction.\n      if (isElementDistinctInteraction(node)) {\n        shouldHighlight = true;\n      } else {\n        // console.log(`Skipping highlight for ${nodeData.tagName} (parent highlighted)`);\n        shouldHighlight = false;\n      }\n    }\n\n    if (shouldHighlight) {\n      // Check viewport status before assigning index and highlighting\n      nodeData.isInViewport = isInExpandedViewport(node, viewportExpansion);\n      \n      // When viewportExpansion is -1, all interactive elements should get a highlight index\n      // regardless of viewport status\n      if (nodeData.isInViewport || viewportExpansion === -1) {\n        nodeData.highlightIndex = highlightIndex++; if (args.onIndex) args.onIndex(nodeData.highlightIndex, node);\n\n        if (doHighlightElements) {\n          if (focusHighlightIndex >= 0) {\n            if (focusHighlightIndex === nodeData.highlightIndex) {\n              highlightElement(node, nodeData.highlightIndex, parentIframe);\n            }\n          } else {\n            highlightElement(node, nodeData.highlightIndex, parentIframe);\n          }\n          return true; // Successfully highlighted\n        }\n      } else {\n        // console.log(`Skipping highlight for ${nodeData.tagName} (outside viewport)`);\n      }\n    }\n\n    return false; // Did not highlight\n  }\n\n  /**\n   * Creates a node data object for a given node and its descendants.\n   */\n  function buildDomTree(node, parentIframe = null, isParentHighlighted = false) {\n    // Fast rejection checks first\n    if (!node || node.id === HIGHLIGHT_CONTAINER_ID || \n        (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE)) {\n      if (debugMode) PERF_METRICS.nodeMetrics.skippedNodes++;\n      return null;\n    }\n\n    if (debugMode) PERF_METRICS.nodeMetrics.totalNodes++;\n\n    if (!node || node.id === HIGHLIGHT_CONTAINER_ID) {\n      if (debugMode) PERF_METRICS.nodeMetrics.skippedNodes++;\n      return null;\n    }\n\n    // Special handling for root node (body)\n    if (node === document.body) {\n      const nodeData = {\n        tagName: 'body',\n        attributes: {},\n        xpath: '/body',\n        children: [],\n      };\n\n      // Process children of body\n      for (const child of node.childNodes) {\n        const domElement = buildDomTree(child, parentIframe, false); // Body's children have no highlighted parent initially\n        if (domElement) nodeData.children.push(domElement);\n      }\n\n      const id = `${ID.current++}`;\n      DOM_HASH_MAP[id] = nodeData;\n      if (debugMode) PERF_METRICS.nodeMetrics.processedNodes++;\n      return id;\n    }\n\n    // Early bailout for non-element nodes except text\n    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) {\n      if (debugMode) PERF_METRICS.nodeMetrics.skippedNodes++;\n      return null;\n    }\n\n    // Process text nodes\n    if (node.nodeType === Node.TEXT_NODE) {\n      const textContent = node.textContent.trim();\n      if (!textContent) {\n        if (debugMode) PERF_METRICS.nodeMetrics.skippedNodes++;\n        return null;\n      }\n\n      // Only check visibility for text nodes that might be visible\n      const parentElement = node.parentElement;\n      if (!parentElement || parentElement.tagName.toLowerCase() === 'script') {\n        if (debugMode) PERF_METRICS.nodeMetrics.skippedNodes++;\n        return null;\n      }\n\n      const id = `${ID.current++}`;\n      DOM_HASH_MAP[id] = {\n        type: \"TEXT_NODE\",\n        text: textContent,\n        isVisible: isTextNodeVisible(node),\n      };\n      if (debugMode) PERF_METRICS.nodeMetrics.processedNodes++;\n      return id;\n    }\n\n    // Quick checks for element nodes\n    if (node.nodeType === Node.ELEMENT_NODE && !isElementAccepted(node)) {\n      if (debugMode) PERF_METRICS.nodeMetrics.skippedNodes++;\n      return null;\n    }\n\n    // Early viewport check - only filter out elements clearly outside viewport\n    if (viewportExpansion !== -1) {\n      const rect = getCachedBoundingRect(node); // Keep for initial quick check\n      const style = getCachedComputedStyle(node);\n\n      // Skip viewport check for fixed/sticky elements as they may appear anywhere\n      const isFixedOrSticky = style && (style.position === 'fixed' || style.position === 'sticky');\n\n      // Check if element has actual dimensions using offsetWidth/Height (quick check)\n      const hasSize = node.offsetWidth > 0 || node.offsetHeight > 0;\n\n      // Use getBoundingClientRect for the quick OUTSIDE check.\n      // isInExpandedViewport will do the more accurate check later if needed.\n      if (!rect || (!isFixedOrSticky && !hasSize && (\n        rect.bottom < -viewportExpansion ||\n        rect.top > window.innerHeight + viewportExpansion ||\n        rect.right < -viewportExpansion ||\n        rect.left > window.innerWidth + viewportExpansion\n      ))) {\n        // console.log(\"Skipping node outside viewport (quick check):\", node.tagName, rect);\n        if (debugMode) PERF_METRICS.nodeMetrics.skippedNodes++;\n        return null;\n      }\n    }\n\n    // Process element node\n    const nodeData = {\n      tagName: node.tagName.toLowerCase(),\n      attributes: {},\n      xpath: getXPathTree(node, true),\n      children: [],\n    };\n\n    // Get attributes for interactive elements or potential text containers\n    if (isInteractiveCandidate(node) || node.tagName.toLowerCase() === 'iframe' || node.tagName.toLowerCase() === 'body') {\n      const attributeNames = node.getAttributeNames?.() || [];\n      for (const name of attributeNames) {\n        nodeData.attributes[name] = node.getAttribute(name);\n      }\n    }\n\n    let nodeWasHighlighted = false;\n    // Perform visibility, interactivity, and highlighting checks\n    if (node.nodeType === Node.ELEMENT_NODE) {\n      nodeData.isVisible = isElementVisible(node); // isElementVisible uses offsetWidth/Height, which is fine\n      if (nodeData.isVisible) {\n        nodeData.isTopElement = isTopElement(node);\n        if (nodeData.isTopElement) {\n          nodeData.isInteractive = isInteractiveElement(node);\n          // Call the dedicated highlighting function\n          nodeWasHighlighted = handleHighlighting(nodeData, node, parentIframe, isParentHighlighted);\n        }\n      }\n    }\n\n    // Process children, with special handling for iframes and rich text editors\n    if (node.tagName) {\n      const tagName = node.tagName.toLowerCase();\n\n      // Handle iframes\n      if (tagName === \"iframe\") {\n        try {\n          const iframeDoc = node.contentDocument || node.contentWindow?.document;\n          if (iframeDoc) {\n            for (const child of iframeDoc.childNodes) {\n              const domElement = buildDomTree(child, node, false);\n              if (domElement) nodeData.children.push(domElement);\n            }\n          }\n        } catch (e) {\n          console.warn(\"Unable to access iframe:\", e);\n        }\n      }\n      // Handle rich text editors and contenteditable elements\n      else if (\n        node.isContentEditable ||\n        node.getAttribute(\"contenteditable\") === \"true\" ||\n        node.id === \"tinymce\" ||\n        node.classList.contains(\"mce-content-body\") ||\n        (tagName === \"body\" && node.getAttribute(\"data-id\")?.startsWith(\"mce_\"))\n      ) {\n        // Process all child nodes to capture formatted text\n        for (const child of node.childNodes) {\n          const domElement = buildDomTree(child, parentIframe, nodeWasHighlighted);\n          if (domElement) nodeData.children.push(domElement);\n        }\n      }\n      else {\n        // Handle shadow DOM\n        if (node.shadowRoot) {\n          nodeData.shadowRoot = true;\n          for (const child of node.shadowRoot.childNodes) {\n            const domElement = buildDomTree(child, parentIframe, nodeWasHighlighted);\n            if (domElement) nodeData.children.push(domElement);\n          }\n        }\n        // Handle regular elements\n        for (const child of node.childNodes) {\n          // Pass the highlighted status of the *current* node to its children\n          const passHighlightStatusToChild = nodeWasHighlighted || isParentHighlighted;\n          const domElement = buildDomTree(child, parentIframe, passHighlightStatusToChild);\n          if (domElement) nodeData.children.push(domElement);\n        }\n      }\n    }\n\n    // Skip empty anchor tags only if they have no dimensions and no children\n    if (nodeData.tagName === 'a' && nodeData.children.length === 0 && !nodeData.attributes.href) {\n      // Check if the anchor has actual dimensions\n      const rect = getCachedBoundingRect(node);\n      const hasSize = (rect && rect.width > 0 && rect.height > 0) || (node.offsetWidth > 0 || node.offsetHeight > 0);\n      \n      if (!hasSize) {\n        if (debugMode) PERF_METRICS.nodeMetrics.skippedNodes++;\n        return null;\n      }\n    }\n\n    const id = `${ID.current++}`;\n    DOM_HASH_MAP[id] = nodeData;\n    if (debugMode) PERF_METRICS.nodeMetrics.processedNodes++;\n    return id;\n  }\n\n  // After all functions are defined, wrap them with performance measurement\n  // Remove buildDomTree from here as we measure it separately\n  highlightElement = measureTime(highlightElement);\n  isInteractiveElement = measureTime(isInteractiveElement);\n  isElementVisible = measureTime(isElementVisible);\n  isTopElement = measureTime(isTopElement);\n  isInExpandedViewport = measureTime(isInExpandedViewport);\n  isTextNodeVisible = measureTime(isTextNodeVisible);\n  getEffectiveScroll = measureTime(getEffectiveScroll);\n\n  const rootId = buildDomTree(document.body);\n\n  // Clear the cache before starting\n  DOM_CACHE.clearCache();\n\n  // Only process metrics in debug mode\n  if (debugMode && PERF_METRICS) {\n    // Convert timings to seconds and add useful derived metrics\n    Object.keys(PERF_METRICS.timings).forEach(key => {\n      PERF_METRICS.timings[key] = PERF_METRICS.timings[key] / 1000;\n    });\n\n    Object.keys(PERF_METRICS.buildDomTreeBreakdown).forEach(key => {\n      if (typeof PERF_METRICS.buildDomTreeBreakdown[key] === 'number') {\n        PERF_METRICS.buildDomTreeBreakdown[key] = PERF_METRICS.buildDomTreeBreakdown[key] / 1000;\n      }\n    });\n\n    // Add some useful derived metrics\n    if (PERF_METRICS.buildDomTreeBreakdown.buildDomTreeCalls > 0) {\n      PERF_METRICS.buildDomTreeBreakdown.averageTimePerNode =\n        PERF_METRICS.buildDomTreeBreakdown.totalTime / PERF_METRICS.buildDomTreeBreakdown.buildDomTreeCalls;\n    }\n\n    PERF_METRICS.buildDomTreeBreakdown.timeInChildCalls =\n      PERF_METRICS.buildDomTreeBreakdown.totalTime - PERF_METRICS.buildDomTreeBreakdown.totalSelfTime;\n\n    // Add average time per operation to the metrics\n    Object.keys(PERF_METRICS.buildDomTreeBreakdown.domOperations).forEach(op => {\n      const time = PERF_METRICS.buildDomTreeBreakdown.domOperations[op];\n      const count = PERF_METRICS.buildDomTreeBreakdown.domOperationCounts[op];\n      if (count > 0) {\n        PERF_METRICS.buildDomTreeBreakdown.domOperations[`${op}Average`] = time / count;\n      }\n    });\n\n    // Calculate cache hit rates\n    const boundingRectTotal = PERF_METRICS.cacheMetrics.boundingRectCacheHits + PERF_METRICS.cacheMetrics.boundingRectCacheMisses;\n    const computedStyleTotal = PERF_METRICS.cacheMetrics.computedStyleCacheHits + PERF_METRICS.cacheMetrics.computedStyleCacheMisses;\n\n    if (boundingRectTotal > 0) {\n      PERF_METRICS.cacheMetrics.boundingRectHitRate = PERF_METRICS.cacheMetrics.boundingRectCacheHits / boundingRectTotal;\n    }\n\n    if (computedStyleTotal > 0) {\n      PERF_METRICS.cacheMetrics.computedStyleHitRate = PERF_METRICS.cacheMetrics.computedStyleCacheHits / computedStyleTotal;\n    }\n\n    if ((boundingRectTotal + computedStyleTotal) > 0) {\n      PERF_METRICS.cacheMetrics.overallHitRate =\n        (PERF_METRICS.cacheMetrics.boundingRectCacheHits + PERF_METRICS.cacheMetrics.computedStyleCacheHits) /\n        (boundingRectTotal + computedStyleTotal);\n    }\n  }\n\n  return debugMode ?\n    { rootId, map: DOM_HASH_MAP, perfMetrics: PERF_METRICS } :\n    { rootId, map: DOM_HASH_MAP };\n})({ doHighlightElements: false, focusHighlightIndex: -1, viewportExpansion: 0, debugMode: false, onIndex: (number, element) => { numbered[number] = element; } });\n} finally {\n  for (const [element, name] of lent) delete element[name];\n}\nconst fingerprint = (element) => {\n  let text = '';\n  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);\n  while (text.length < 200 && walker.nextNode()) text += walker.currentNode.data + ' ';\n  const attribute = (name) => element.getAttribute(name) || '';\n  return [element.localName, attribute('type'), attribute('name'), attribute('role'), attribute('href'),\n    text.replace(/\\s+/g, ' ').trim().slice(0, 80).replace(/\\d+/g, '#')].join('|');\n};\n\nconst map = result.map || {};\nconst ATTRIBUTES = ['title', 'type', 'checked', 'name', 'role', 'value', 'placeholder', 'alt', 'aria-label', 'aria-expanded', 'aria-checked', 'data-state', 'href'];\nconst index = {};\nconst lines = [];\nconst clean = (text) => text.replace(/\\s+/g, ' ').trim();\nfunction textUntilClickable(id) {\n  const parts = [];\n  (function walk(nodeID, isRoot) {\n    const node = map[nodeID];\n    if (!node) return;\n    if (node.type === 'TEXT_NODE') { if (node.isVisible !== false) parts.push(node.text); return; }\n    if (!isRoot && node.highlightIndex !== undefined && node.highlightIndex !== null) return;\n    (node.children || []).forEach((child) => walk(child, false));\n  })(id, true);\n  return clean(parts.join(' '));\n}\n(function walk(nodeID, insideClickable) {\n  const node = map[nodeID];\n  if (!node) return;\n  if (node.type === 'TEXT_NODE') {\n    if (!insideClickable && node.isVisible !== false && clean(node.text)) lines.push(clean(node.text));\n    return;\n  }\n  let inside = insideClickable;\n  if (node.highlightIndex !== undefined && node.highlightIndex !== null) {\n    const element = numbered[node.highlightIndex];\n    if (element) index[node.highlightIndex] = { element, print: fingerprint(element) };\n    const attributes = ATTRIBUTES\n      .filter((name) => node.attributes && node.attributes[name])\n      // A password field's value never goes to the model.\n      .filter((name) => !(name === 'value' && String(node.attributes.type).toLowerCase() === 'password'))\n      // Nor what the user filled in through Kuvo Code.\n      .filter((name) => !(name === 'value' && node.attributes['data-kuvo-secret'] !== undefined))\n      .map((name) => `${name}=\"${String(node.attributes[name]).slice(0, 100)}\"`)\n      .join(' ');\n    const tag = node.tagName || 'element';\n    lines.push(`[${node.highlightIndex}]<${tag}${attributes ? ' ' + attributes : ''}>${textUntilClickable(nodeID).slice(0, 150)}</${tag}>`);\n    inside = true;\n  }\n  (node.children || []).forEach((child) => walk(child, inside));\n})(result.rootId, false);\n// In the agent's world (`BrowserAgent.world`, and a machine's), out of the page's reach.\nwindow.__kuvoIndex = { snapshot: typeof kuvoSnapshot === 'string' ? kuvoSnapshot : null, elements: index };\n// A page that asks to sign in (or for a one-time code) says what to do about it, where the\n// agent reads it: ask the user in Kuvo Code, not in the chat.\nconst shown = (field) => !field.disabled && field.getClientRects().length > 0 && getComputedStyle(field).visibility !== 'hidden';\nconst fields = [...document.querySelectorAll('input')].filter(shown);\nconst filled = fields.some((field) => field.hasAttribute('data-kuvo-secret'));\nconst autocomplete = (pattern) => fields.some((field) => pattern.test(field.autocomplete || ''));\nif (!filled && autocomplete(/one-time-code/)) {\n  lines.unshift('(This page asks for a one-time code: call browser_ask_code with its field now, unless the user already said no. The user types it in Kuvo Code; never ask for it in the chat.)', '');\n} else if (!filled && (fields.some((field) => field.type === 'password') || autocomplete(/\\busername\\b|current-password/))) {\n  lines.unshift('(This page asks to sign in: call browser_sign_in with its fields now, unless the user already said no. The user answers in Kuvo Code, where they can also say Not Now; do not ask in the chat whether to sign in, or for their password.)', '');\n}\nconst scrollHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);\nreturn {\n  text: lines.join('\\n'),\n  title: document.title,\n  url: location.href,\n  above: Math.round(window.scrollY),\n  below: Math.max(0, Math.round(scrollHeight - window.scrollY - window.innerHeight)),\n};","type":"const element = find(index);\nif (!element) return missing(index);\ndocument.getElementById('playwright-highlight-container')?.remove();\nelement.scrollIntoView({ block: 'center' });\nelement.focus();\nconst view = viewOf(element);\nif (element.isContentEditable) {\n  const doc = element.ownerDocument;\n  if (clear) { doc.execCommand('selectAll', false); doc.execCommand('delete', false); }\n  doc.execCommand('insertText', false, text);\n} else if (element.localName === 'input' || element.localName === 'textarea') {\n  const prototype = element.localName === 'textarea' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;\n  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;\n  setter.call(element, (clear ? '' : element.value) + text);\n  element.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));\n  element.dispatchEvent(new view.Event('change', { bubbles: true }));\n} else {\n  return `[${index}] doesn't take text. Click it first, or pick an input.`;\n}\nif (submit) {\n  const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };\n  const proceed = element.dispatchEvent(new view.KeyboardEvent('keydown', init));\n  element.dispatchEvent(new view.KeyboardEvent('keypress', init));\n  element.dispatchEvent(new view.KeyboardEvent('keyup', init));\n  if (proceed && element.form) element.form.requestSubmit ? element.form.requestSubmit() : element.form.submit();\n}\nreturn 'ok';","unmask":"const roots = [];\n(function collect(root) {\n  roots.push(root);\n  for (const element of root.querySelectorAll('*')) {\n    if (element.shadowRoot) collect(element.shadowRoot);\n    if (element.localName === 'iframe' || element.localName === 'frame') {\n      try { if (element.contentDocument) collect(element.contentDocument); } catch {}\n    }\n  }\n})(document);\n\nfor (const root of roots) root.getElementById('kuvo-secret-mask')?.remove();\nreturn 'ok';"},"searchEngines":[{"id":"google","title":"Google","url":"https://www.google.com/search?q=%s"},{"id":"duckDuckGo","title":"DuckDuckGo","url":"https://duckduckgo.com/?q=%s"},{"id":"bing","title":"Bing","url":"https://www.bing.com/search?q=%s"},{"id":"brave","title":"Brave Search","url":"https://search.brave.com/search?q=%s"},{"id":"kagi","title":"Kagi","url":"https://kagi.com/search?q=%s"},{"id":"ecosia","title":"Ecosia","url":"https://www.ecosia.org/search?q=%s"}],"tools":[{"description":"Open an address, or search for words, in the browser panel the user sees. Returns the page as numbered elements.","inputSchema":{"properties":{"url":{"description":"An address like example.com, or words to search for.","type":"string"}},"required":["url"],"type":"object"},"name":"browser_navigate"},{"description":"Read the current page: title, address, scroll position, and its interactive elements numbered like [3], with visible text.","inputSchema":{"properties":{},"type":"object"},"name":"browser_snapshot"},{"description":"Click the element with this number from the latest snapshot.","inputSchema":{"properties":{"accept_dialog":{"description":"Accept a confirmation or prompt it opens (declined otherwise).","type":"boolean"},"index":{"type":"integer"}},"required":["index"],"type":"object"},"name":"browser_click"},{"description":"Type text into the input with this number, replacing what's there unless clear is false.","inputSchema":{"properties":{"clear":{"type":"boolean"},"index":{"type":"integer"},"submit":{"description":"Press Enter afterwards.","type":"boolean"},"text":{"type":"string"}},"required":["index","text"],"type":"object"},"name":"browser_type"},{"description":"Choose an option, by its text or value, in the drop-down with this number.","inputSchema":{"properties":{"index":{"type":"integer"},"option":{"type":"string"}},"required":["index","option"],"type":"object"},"name":"browser_select"},{"description":"Scroll the page up or down by screens (1 by default).","inputSchema":{"properties":{"direction":{"enum":["up","down"],"type":"string"},"pages":{"type":"number"}},"required":["direction"],"type":"object"},"name":"browser_scroll"},{"description":"Press a key on the focused element: Enter, Escape, Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight or Backspace. Type text with browser_type.","inputSchema":{"properties":{"accept_dialog":{"description":"Accept a confirmation or prompt it opens (declined otherwise).","type":"boolean"},"key":{"type":"string"}},"required":["key"],"type":"object"},"name":"browser_press"},{"description":"Go back a page.","inputSchema":{"properties":{},"type":"object"},"name":"browser_back"},{"description":"Go forward a page.","inputSchema":{"properties":{},"type":"object"},"name":"browser_forward"},{"description":"Read all of the page's text at once (an article, docs, a list or a table), without scrolling.","inputSchema":{"properties":{},"type":"object"},"name":"browser_text"},{"description":"See the visible part of the page as an image (for models that take images). With show, the user sees it too, in this conversation: use it whenever they ask to see the page or for a screenshot.","inputSchema":{"properties":{"show":{"type":"boolean"}},"type":"object"},"name":"browser_screenshot"},{"description":"Save the page as a PDF, in pages as printing would, with its colors. To make a document to share (a report, an invoice), write it as an HTML file, open it with browser_navigate (file:///…), then save it here.","inputSchema":{"properties":{"path":{"description":"A full path ending in .pdf.","type":"string"}},"required":["path"],"type":"object"},"name":"browser_save_pdf"},{"description":"Wait for the page, then read it again: until a text shows on it (up to 30 seconds), or for some seconds (up to 10).","inputSchema":{"properties":{"seconds":{"type":"number"},"text":{"type":"string"}},"type":"object"},"name":"browser_wait"},{"description":"Move the pointer over the element with this number, for menus and tips that open on hover.","inputSchema":{"properties":{"index":{"type":"integer"}},"required":["index"],"type":"object"},"name":"browser_hover"},{"description":"Open a new browser tab in the panel, optionally at an address.","inputSchema":{"properties":{"url":{"type":"string"}},"type":"object"},"name":"browser_new_tab"},{"description":"Attach files to the file input with this number (or its upload button), as choosing them in the file picker would.","inputSchema":{"properties":{"files":{"description":"Their full paths.","items":{"type":"string"},"type":"array"},"index":{"type":"integer"}},"required":["index","files"],"type":"object"},"name":"browser_upload"},{"description":"List the browser's tabs (numbered, the one in use marked), switch to one to work in it, or close one.","inputSchema":{"properties":{"action":{"description":"list by default.","enum":["list","switch","close"],"type":"string"},"tab":{"description":"Its number, to switch to or close.","type":"integer"}},"type":"object"},"name":"browser_tabs"},{"description":"Sign in with the user's own username and password: from their vault where this conversation may use one of its sign-ins on this site (it fills on its own), or else they type or pick one in Kuvo Code. They go straight into the fields you name; you never see them. Use it for every sign-in. Whenever a page you open asks to sign in, call it right away, even if the user didn't mention signing in: its card asks them, and they can say Not Now there, so never ask in the chat whether to sign in, nor for a password. Name the fields the page has now (where the username and the password are on pages of their own, call it on each; the user answers once). Then submit the form yourself.","inputSchema":{"properties":{"item":{"description":"A sign-in from vault_items, by name, when more than one could do. It's filled only on its own site.","type":"string"},"password":{"description":"The password field's number, if the page has one.","type":"integer"},"username":{"description":"The username or email field's number, if the page has one.","type":"integer"}},"type":"object"},"name":"browser_sign_in"},{"description":"Fill one field from the user's vault: a sign-in's username or password, or a key's or a note's field, by the item's name from vault_items. It's filled only on the item's own sites, and you never see it.","inputSchema":{"properties":{"field":{"description":"Which of its fields, when it has more than one (vault_items lists them).","type":"string"},"index":{"description":"The field's number.","type":"integer"},"item":{"type":"string"},"why":{"description":"Why you need it, in one sentence the user reads.","type":"string"}},"required":["index","item"],"type":"object"},"name":"browser_fill"},{"description":"Ask the user for a one-time code (from a text message, an email or an authenticator app), which goes straight into the field with this number; you never see it. Then submit it if the page doesn't on its own.","inputSchema":{"properties":{"index":{"type":"integer"},"prompt":{"description":"What to tell the user, like \"Enter the 6-digit code texted to your phone\".","type":"string"}},"required":["index"],"type":"object"},"name":"browser_ask_code"},{"description":"Ask the user to do something on the page themselves: a CAPTCHA, approving the sign-in on their phone, anything you can't do. Waits until they say it's done (up to 15 minutes), then reads the page again. Not for a question or a choice: ask those with your question tool, or in your reply.","inputSchema":{"properties":{"instruction":{"description":"What they should do, in a sentence.","type":"string"}},"required":["instruction"],"type":"object"},"name":"browser_ask_user"},{"description":"Show the user a file or folder in Kuvo Code's side panel, beside this conversation: a folder in the Files tab, a file in a tab of its own (code, Markdown, pictures and PDFs show as they are). Use it whenever the user asks to see, open or find something, and to point them to what you made or found.","inputSchema":{"properties":{"path":{"description":"Its full path.","type":"string"}},"required":["path"],"type":"object"},"name":"show_in_panel"},{"description":"Put a file in this conversation, where the user reads your replies: a picture shows large, any other file (a PDF, a document, a spreadsheet) as a card they open. Use it to show what you made or found when seeing it helps, and always when the user is on their phone (their message ends with a <from-phone> block), where file paths and the side panel don't reach them.","inputSchema":{"properties":{"caption":{"description":"A line shown under it.","type":"string"},"path":{"description":"Its full path.","type":"string"}},"required":["path"],"type":"object"},"name":"show_file"},{"description":"Mark a file you made as final once it's ready for the user (a report, a document, a picture): it's kept at the top of what you made, where they find it with every version.","inputSchema":{"properties":{"note":{"description":"A few words on it, like who it's for.","type":"string"},"path":{"description":"Its full path.","type":"string"}},"required":["path"],"type":"object"},"name":"mark_final"},{"description":"Show the user something to look at or play with, live in this conversation where this call is. Make one only when it does a job words can't: a chart of numbers you measured, options to see side by side with a choice to click, a value to tune with an instant preview, or a table to sort or filter. Not for a plain choice between named options (ask with your question tool, if you have one), a diagram (write a ```mermaid code block in your reply; a widget only when it needs something to click), what a sentence or a short list says, code (use a code block), or decoration. Keep it to one view with a control or two, built from the data you actually have (never invented numbers); don't repeat it in your reply, but add a line on what to do with it. It can't be opened larger: design it for the reply's width, and narrow enough for a phone (360 points). It's as tall as its content, up to about 760 points (less on a phone), then it scrolls. It has no frame: don't put the whole of it in a card or box of its own. Write the HTML (a fragment or a whole page) with its CSS and JavaScript inline; libraries only from cdnjs.cloudflare.com, cdn.jsdelivr.net or unpkg.com (Chart.js, D3, Mermaid, Three.js, Leaflet with its map tiles); pictures from anywhere. It can't fetch data or send anything, so put the data in the page. It starts in Kuvo Code's look, light and dark: transparent, with buttons (class primary for the main one), fields, tables and headings styled, the classes kuvo-card, kuvo-chip and kuvo-row, and colors by name: var(--kuvo-accent), var(--kuvo-1) to var(--kuvo-6) for a chart's series, var(--kuvo-good) and var(--kuvo-bad), var(--kuvo-secondary) for quieter text, var(--kuvo-line) and var(--kuvo-fill). Use those rather than a palette of your own, and make anything you style yourself work in light and dark (prefers-color-scheme). Anything your script draws (Chart.js, D3, a canvas) takes its colors from those variables, read with getComputedStyle(document.documentElement).getPropertyValue('--kuvo-1') (and --kuvo-text, --kuvo-secondary, --kuvo-line for labels and grid), and draws again when matchMedia('(prefers-color-scheme: dark)') changes; otherwise it's loaded again in the new look, losing what the user did in it. To hear back, call kuvo.send(text) from a click in it: the text comes to you as the user's message, ending with a <from-widget> block that names the widget by its title, so give each a title of its own.","inputSchema":{"properties":{"html":{"type":"string"},"title":{"description":"A short name for it, shown while you make it, if it can't show, and on what the user sends from it. Write it before the HTML.","type":"string"}},"required":["html"],"type":"object"},"name":"show_widget"},{"description":"List the agents you can write to with send_message, or read with read_conversation: the user's bots and their other recent sessions, on their Mac and their machines, each with its name, where it runs and its address.","inputSchema":{"properties":{},"type":"object"},"name":"list_agents"},{"description":"Read another agent's conversation (from list_agents, or one the user names with &): what was written to it, its replies, and a line for each step it took, oldest first. Use it to learn what it did, decided or found, to pick up where it left off, or to follow it, without interrupting it. A long one gives its start and its latest part; with query, the parts that mention it.","inputSchema":{"properties":{"of":{"description":"Its name or address.","type":"string"},"query":{"description":"A word or phrase to find in it.","type":"string"}},"required":["of"],"type":"object"},"name":"read_conversation"},{"description":"Write to another agent (from list_agents), to hand off work, ask for help or information, coordinate, or report back: it reaches that conversation as a message from you, and its agent takes it up. With wait, its answer comes back here (up to ten minutes); without, it can answer with send_message later. A message from another agent reaches you the same way, saying who it's from.","inputSchema":{"properties":{"text":{"description":"What to say: all it needs to know, as it hasn't seen this conversation.","type":"string"},"to":{"description":"Its name or address.","type":"string"},"wait":{"type":"boolean"}},"required":["to","text"],"type":"object"},"name":"send_message"},{"description":"Come back to this conversation later, even while the user is away: at `when`, it gets your note as a message starting with \"[Wake-up]\", and you carry on from it. With every, it comes back again and again until it's canceled. Never say you can't come back later or run on a timer: schedule a wake-up instead.","inputSchema":{"properties":{"every":{"description":"30m, 2h, 1d, 1w (at least 5m), or weekdays. Days, weeks and weekdays keep its time of day. When it's due now too, also do the first round now.","type":"string"},"note":{"description":"What to do then, as a note to yourself, starting with what to do. It comes to this conversation, in its folder, so leave those out.","type":"string"},"summary":{"description":"One short line the user sees for it, like \"Check whether CI passed\".","type":"string"},"when":{"description":"+20m, +2h, +1d, or a time like 2026-10-21T09:00 on the user's clock; at least a minute from now.","type":"string"}},"required":["when","note"],"type":"object"},"name":"schedule_wake_up"},{"description":"Wait for something to change without checking yourself (CI finishing, a deploy, a status page, a price, a file): every so often its check, a shell command, runs in this conversation's folder for at most a minute, and this conversation wakes with your note and the new output only when what it prints changes (not the first time). Make it print just what you watch, like gh run list --limit 1 --json status,conclusion -q '.[0] | .status + \" \" + .conclusion' or curl -s <url> | grep -o '<the part that matters>', so a clock or an ad on the page doesn't count as a change. Only what it prints counts, and printing nothing counts too. A run is skipped when a curl, wget or gh in it fails, or when it prints nothing and exits 2 or more. To watch whether a site is up, print its status code: curl -s -o /dev/null -w '%{http_code}' <url>.","inputSchema":{"properties":{"check":{"type":"string"},"every":{"description":"How often: 5m or more, 2h, 1d.","type":"string"},"note":{"description":"What to do when it changes.","type":"string"},"summary":{"description":"One short line the user sees for it, like \"Check whether CI passed\".","type":"string"}},"required":["every","check","note"],"type":"object"},"name":"watch_for_change"},{"description":"List this conversation's wake-ups and watches, with their ids. Check it before adding one: never keep two for the same thing.","inputSchema":{"properties":{},"type":"object"},"name":"list_wake_ups"},{"description":"Cancel one of this conversation's wake-ups or watches by its id from list_wake_ups (or the one schedule_wake_up or watch_for_change gave). To change one, cancel it and set the new one.","inputSchema":{"properties":{"id":{"type":"string"}},"required":["id"],"type":"object"},"name":"cancel_wake_up"},{"description":"Keep your job, as one of the user's bots. Call it whenever the user gives you a job or changes it, before anything else, with the whole job as it is now: it replaces the one you had. Only a bot keeps a job.","inputSchema":{"properties":{"clear":{"description":"true to clear the job.","type":"boolean"},"details":{"description":"Only what the user asked for, as close to their words as you can: what to do, watch or make, when, and any rule or limit they gave. Never how you'll work, who does the work, or a rule or limit they didn't give.","type":"string"},"job":{"description":"Alternative to summary.","type":"string"},"summary":{"description":"What you do, in a few words, like \"Keeps the build green\" (shown under your name).","type":"string"}},"type":"object"},"name":"set_job"},{"description":"Start a new session: another agent with a conversation of its own, working alongside you (a separate task, a second opinion, one part of a bigger job). It gets the task as a message from you, so it knows who to report to, and the user finds it under this conversation in their sidebar, to follow and talk to. You get its address to write to it with send_message; it can write back the same way. A bot is woken when its sessions finish or ask (wake), so it never checks on them. With computer, it starts on another of the user's computers, as if you lived there.","inputSchema":{"properties":{"approval":{"description":"askFirst asks before it edits or runs commands, acceptEdits edits on its own and asks before commands, auto works on its own inside the sandbox, fullAccess asks nothing. Yours by default, and never more than yours.","enum":["askFirst","acceptEdits","auto","fullAccess"],"type":"string"},"chat":{"description":"Start it as a chat, in no project.","type":"boolean"},"computer":{"description":"Another of the user's computers, by its name in list_agents: this one by default. Its project from list_projects there.","type":"string"},"effort":{"description":"One of the efforts list_models gives for the model.","type":"string"},"folder":{"description":"A full path: this conversation's folder by default. With project: a folder in it or one of its worktrees, else it's refused.","type":"string"},"mode":{"description":"plan: it plans first and changes nothing until it's told to go on. build by default.","enum":["build","plan"],"type":"string"},"model":{"description":"provider/model from list_models: yours by default.","type":"string"},"project":{"description":"One of the user's projects, by name or folder.","type":"string"},"review":{"description":"A bot's session is told to review its work with reviewer subagents before its report: false for a task that needs no review, told only to report. true by default.","type":"boolean"},"step":{"description":"For your goal: the step it works on, by number, so that step's track follows it.","type":"integer"},"task":{"description":"What it's to do: all it needs to know, as it hasn't seen this conversation.","type":"string"},"title":{"description":"A short name, like \"Write the tests\".","type":"string"},"wait":{"description":"Wait for its first answer (up to ten minutes).","type":"boolean"},"wake":{"description":"What you're woken with: when it finishes, when it asks, both (a bot's default), or none (a session's default).","enum":["finished","asks","both","none"],"type":"string"},"worktree":{"description":"In a worktree of its project, on a branch of its own, out of other sessions' way.","type":"boolean"}},"required":["task"],"type":"object"},"name":"start_session"},{"description":"List the sessions you started (and the ones they started), latest first: whether each is working, asking for something (what, with the ask's id), finished, failed or stopped; its model, its tokens in context now and in total, and the first lines of its last reply.","inputSchema":{"properties":{},"type":"object"},"name":"list_sessions"},{"description":"Stop a session you started, by its address from list_sessions; with archive, also put it away once its work is reported. Only your own: for another, ask the user.","inputSchema":{"properties":{"archive":{"type":"boolean"},"session":{"type":"string"}},"required":["session"],"type":"object"},"name":"stop_session"},{"description":"Summarize the conversation of a session you started, to free up its context, as the user's /compact does: now, or when its turn ends. Nothing is lost from what the user sees. Only your own: for another, ask the user. Some coding agents can't be asked, and it says so.","inputSchema":{"properties":{"session":{"type":"string"}},"required":["session"],"type":"object"},"name":"compact_session"},{"description":"Answer what one of your sessions asks: a permission (allow or deny), or a question (in words). You may allow what your own conversation could do without asking, in its mode and with its rules, but never in a session that is in Ask First: the user answers all of those. What it would have to ask about comes to the user, as answer_ask tells you: tell them in a line, and they answer it on the session. You can always deny, saying why. The user sees your answer and reason on the session.","inputSchema":{"properties":{"answer":{"description":"For a question.","type":"string"},"ask":{"description":"The ask's id, from the [Session asks] message or list_sessions.","type":"string"},"decision":{"description":"For a permission.","enum":["allow","deny"],"type":"string"},"reason":{"description":"Why, in a line the user sees.","type":"string"},"session":{"description":"The session's address.","type":"string"}},"required":["session","ask","reason"],"type":"object"},"name":"answer_ask"},{"description":"List the models sessions can start on here or on another computer (computer), the ones the user has an account for, as provider/model, with their efforts.","inputSchema":{"properties":{"computer":{"type":"string"}},"type":"object"},"name":"list_models"},{"description":"Make a new project: a folder named after it, in the folder the user picked for projects (or one they named for it), with a new git repository (or a clone), added to Kuvo Code's sidebar. Make every new project with it, never with mkdir or git init. The user is asked first (once for a bot, if they say Always; not for a project in the goal they started); if they haven't answered in ten minutes it stays asked, and you're told when they answer. Then start sessions in it with start_session.","inputSchema":{"properties":{"clone":{"description":"A repository to clone into it instead: an https or ssh address.","type":"string"},"folder":{"description":"Only where the user named one: its full path (~/Desktop/tidepool).","type":"string"},"git":{"description":"false for a plain folder, without git.","type":"boolean"},"name":{"description":"The project's name, like Tidepool.","type":"string"}},"required":["name"],"type":"object"},"name":"make_project"},{"description":"List the user's projects here or on another computer (computer): each one's folder, whether it's a git repository, and who made it, and where new projects go.","inputSchema":{"properties":{"computer":{"type":"string"}},"type":"object"},"name":"list_projects"},{"description":"Read the user's plan limits on this computer: for each account of each coding agent (Claude Code, Codex…), how much of each window (5-hour, weekly, a model's own) is used, when it resets, and as of when. Use it to pace long work, or to pick an account with room before starting sessions. It changes nothing.","inputSchema":{"properties":{},"type":"object"},"name":"plan_limits"},{"description":"Use one of an account's rate-limit resets (Codex's reset credits, Claude's reset grants) to refill its limits now, when work can't wait for the limit to start over. Only for an account plan_limits lists with resets. The user approves each use on a card in this conversation (unless they chose Always Allow for that account); if they haven't answered in ten minutes it stays asked, and you're told when they answer. It answers with the account's limits after.","inputSchema":{"properties":{"account":{"description":"The account, as plan_limits names it (its account id, or its name like Codex).","type":"string"}},"required":["account"],"type":"object"},"name":"use_limit_reset"},{"description":"For a bot, when the user's message is a goal of many steps (hours, days or weeks of work), or was sent with /goal: plan it, check what it needs, and put its plan to them on one card. Never for a small or quick request. The user starts it from the card, or says not now; you're told [Goal started] when they start it, and never start before. Proposing again replaces the card.","inputSchema":{"properties":{"checks":{"description":"What you checked the goal needs: tools, keys, sign-ins, services, and what only the user can do (pay on their own account, sign in, make an account, hand over a key). Never a check to approve your work or to make a choice your research can settle: Start approves the plan.","items":{"properties":{"button":{"description":"The button's word for that page, like Add or Open Stripe.","type":"string"},"detail":{"description":"A few words more, like what it's for.","type":"string"},"ok":{"description":"true when it's ready; leave it out for what the user must do.","type":"boolean"},"site":{"description":"The service's site, when there's no url.","type":"string"},"text":{"description":"What's checked, like \"Stripe key works\", or what the user must do, like \"Add a Cloudflare API token\".","type":"string"},"url":{"description":"An https page where the user does it.","type":"string"}},"required":["text"],"type":"object"},"type":"array"},"digest":{"description":"How often the user hears how it goes: by the plan's size unless they said.","enum":["day","week","none"],"type":"string"},"ends":{"description":"An end the user named, as a date and time (2026-11-30T18:00); leave it out otherwise.","type":"string"},"goal":{"description":"The goal, in the user's words.","type":"string"},"projects":{"description":"New projects the plan makes, by name, or by the folder the user named for one, as a full path: made with make_project, without asking, once the goal starts.","items":{"type":"string"},"type":"array"},"spend":{"description":"What you'd spend yourself, each with a cap. Nothing else may be spent. What the user pays for themselves (a membership they join, a fee on their own account) is a check for them instead, its price in detail.","items":{"properties":{"cap":{"type":"number"},"currency":{"description":"USD by default.","type":"string"},"per":{"description":"goal (the whole goal) by default.","enum":["day","week","month","goal"],"type":"string"},"what":{"type":"string"}},"required":["what","cap"],"type":"object"},"type":"array"},"steps":{"description":"The plan's steps, in order, each one session's whole task with a short name of a few words, never a sentence. Steps that don't wait for each other run side by side.","items":{"anyOf":[{"type":"string"},{"properties":{"after":{"description":"The steps it waits for, by number; leave it out for one that can start now.","items":{"type":"integer"},"type":"array"},"app":{"description":"The app on the computer it's done in, by the app's own name, like Xcode or Figma; leave it out for work in the browser or the terminal.","type":"string"},"detail":{"description":"What's in it, about 30 characters at most, like \"SDK, paywall, test config\": never a sentence.","type":"string"},"site":{"description":"The site it's done at in the browser, like appstoreconnect.apple.com for submitting an app; leave it out for work on the computer (code, Xcode, a build), and never give a maker's site for its products.","type":"string"},"text":{"description":"Its short name, a few words on one line, like \"Photo scan engine\" or \"Submit for review\": never a sentence or a list of what's in it.","type":"string"}},"required":["text"],"type":"object"}]},"type":"array"},"title":{"description":"The goal's name in two to four words, like \"Landing page\": never a sentence.","type":"string"}},"required":["goal","steps"],"type":"object"},"name":"propose_goal"},{"description":"During your goal: mark its steps as they start, move and end, add steps as the plan changes, keep what only the user can fix or decide (or what's outside the plan) as waiting, keep a call you made yourself (decided), report what you spent, and say what you're still watching. It tells you whether the user is here.","inputSchema":{"properties":{"add":{"description":"New steps, as the plan changes, like propose_goal's: a short name of a few words, never a sentence; detail about 30 characters at most; site only for work in the browser, app only for work in an app on the computer.","items":{"anyOf":[{"type":"string"},{"properties":{"after":{"items":{"type":"integer"},"type":"array"},"app":{"type":"string"},"detail":{"type":"string"},"site":{"type":"string"},"text":{"type":"string"}},"required":["text"],"type":"object"}]},"type":"array"},"decided":{"description":"A call you made yourself, kept for the user to see; they may change it later.","properties":{"choice":{"description":"What you chose, in a few words.","type":"string"},"options":{"description":"The choices there were, yours among them: the user may pick another of these.","items":{"type":"string"},"type":"array"},"text":{"description":"The call, as a question, like \"Which hosting?\".","type":"string"},"why":{"description":"Why, in a few words, like \"free tier covers it\".","type":"string"}},"required":["text","choice"],"type":"object"},"spent":{"description":"What you spent, by the plan's spend line.","items":{"properties":{"amount":{"type":"number"},"what":{"type":"string"}},"required":["what","amount"],"type":"object"},"type":"array"},"steps":{"items":{"properties":{"app":{"description":"The app on the computer it's done in, by its own name, where that changed; null takes it away.","type":["string","null"]},"note":{"description":"A few words the user sees: what you counted (\"3 of 8 pages\"), or like \"looks again at 2:40\".","type":"string"},"progress":{"description":"From 0 to 1, only where you can count it, with what you counted in note (3 of 8 pages is 0.375).","type":"number"},"state":{"enum":["todo","doing","done","waiting","paused","skipped"],"type":"string"},"step":{"description":"The step's number, from 1.","type":"integer"},"until":{"description":"For a step that can only start at a time (a weekly run on Monday): that time, like 2026-11-02T09:00. Set a wake-up for it too; you aren't told to carry on before then. null takes it away.","type":"string"}},"required":["step"],"type":"object"},"type":"array"},"waiting":{"properties":{"app":{"description":"The app on the computer it's done in, by its own name.","type":"string"},"detail":{"type":"string"},"kind":{"description":"you: only the user can fix it; judgment: a call only they can make; outside: not in the plan.","enum":["you","judgment","outside"],"type":"string"},"site":{"description":"The service's site, when there's no url.","type":"string"},"step":{"description":"The step it holds up: settled once you go on with that step.","type":"integer"},"text":{"description":"What it is, like \"Finish Stripe's identity check\".","type":"string"},"url":{"description":"An https page where the user does it.","type":"string"}},"required":["kind","text"],"type":"object"},"watching":{"description":"All you're still watching, as it is now, like \"DNS for driftwood.coffee\".","items":{"type":"string"},"type":"array"}},"type":"object"},"name":"goal_progress"},{"description":"During your goal: whether a purchase fits the plan's cap for it, in its period now. Ask before every purchase.","inputSchema":{"properties":{"amount":{"type":"number"},"what":{"description":"The plan's spend line it's for.","type":"string"}},"required":["what","amount"],"type":"object"},"name":"may_spend"},{"description":"End your goal with the report: what needs the user first, then what got done and where, what it spent, and what you're still watching.","inputSchema":{"properties":{"report":{"description":"A few lines.","type":"string"},"watching":{"items":{"type":"string"},"type":"array"}},"required":["report"],"type":"object"},"name":"finish_goal"},{"description":"Send the user a notification, on their phone and their Mac, when you need them and they may not be looking: a decision only they can make, something blocked until they act, or news they asked to be told. A reply notifies them only when it answers something they asked; when you work on your own (a wake-up, a watch, another agent's message, a goal), nothing reaches them unless you use this. Not for progress or routine results: those go in your reply. A few an hour at most; the same text isn't sent twice.","inputSchema":{"properties":{"text":{"description":"One sentence, leading with what you need from the user or the news, like \"I need your Stripe key to finish the payments step.\"","type":"string"}},"required":["text"],"type":"object"},"name":"notify_user"}],"vaultInstructions":" The user's vault keeps sign-ins, keys, files and notes you may use without seeing them: vault_items lists yours, vault_ask asks for one you need, browser_fill fills a field from one, and vault_run hands values to a command (never print them)."};

const K = process.env.KUVO_HOME || path.join(os.homedir(), ".kuvo-code");
// The version of Kuvo Code this box's files are from (`bin/box-version`), for what this says it is.
const VERSION = (() => {
  try {
    return fs.readFileSync(path.join(K, "bin", "box-version"), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
})();
const RUN = path.join(K, "run");
const SOCKET = path.join(RUN, "browser.sock");
// What every connection to the keeper gives first, as to the box's vault: Kuvo Code's processes read
// it here, a command in the sandbox can't (it can connect to a socket it can't read the folder of).
// The same as the box's (`socketKey` in its home.ts).
const SOCKET_KEY_FILE = path.join(RUN, "socket.key");
const PIDFILE = path.join(RUN, "browser.pid");
// The pages open when the keeper last stopped (for an update, or with nobody around), to open
// again when it starts.
const PAGESFILE = path.join(RUN, "pages.json");
// What agents ask the user for now, for the machine's phone link, which answers it for a phone
// with the Mac closed (KuvoLink's PROTOCOL.md, "kuvo/asks"); gone while nothing is.
const ASKSFILE = path.join(RUN, "browser-asks.json");
const ERRORFILE = path.join(RUN, "browser.error");
const LOGFILE = path.join(RUN, "browser.log");
const BROWSER = path.join(K, "browser");
// The installed Chromium, with the libraries and fonts it needs.
const CURRENT = path.join(BROWSER, "current");
// Website data: cookies and sign-ins stay between starts.
const PROFILE = path.join(BROWSER, "profile");
// What pages download, under their own names; gone after a week.
const DOWNLOADS = path.join(BROWSER, "downloads");
// Each page that loads (and its site's icon), noted for the box, which keeps the history from them
// (`history.json`, in the box's link/browser/history.ts): this only adds lines.
const VISITS = path.join(BROWSER, "visits.jsonl");
// Sites whose stored data the box removed while Chrome was stopped: what's left of it, cleared as
// Chrome starts (the box's link/browser/sites.ts writes it).
const CLEAR_SITES = path.join(BROWSER, "clear-sites.json");
// Held while the box changes the profile's files with Chrome stopped: Chrome starts once it's gone.
const PROFILE_EDITING = path.join(BROWSER, ".profile-editing");
// The browser's settings, as the box keeps them (`kuvo/browser/settings`): its search engine's address.
const SETTINGS = path.join(BROWSER, "settings.json");
// Chromium's temporary files: the socket its lock answers on, and the shared memory that
// --disable-dev-shm-usage puts there. Emptied each time it starts.
const TMP = path.join(BROWSER, "tmp");
const SCRIPT = process.argv[1];
// How long Chromium keeps running with nobody connected.
const IDLE = Number(process.env.KUVO_BROWSER_IDLE || 10 * 60) * 1000;
// The languages to ask sites for: those of the Mac that started it ("en-GB,en,tr-TR,tr").
const LANGUAGES = String(process.env.KUVO_LANG || "").split(",").filter((tag) => /^[A-Za-z0-9-]+$/.test(tag));
// How long a page only agents used, and no Mac has shown, stays open once they've left it, as the
// Mac's panel keeps an agent's tab you haven't looked at (Utilities.agentTabIdle).
const TAB_IDLE = Number(process.env.KUVO_BROWSER_TAB_IDLE || 3600) * 1000;

// Which keeper this is (host mode): the first 12 hex digits of the SHA-256 of this file as its source
// has it, which scripts/build-browser.sh writes in, so it changes with every change here and no
// branch bumps it by hand. The keeper of the file that's in place now replaces a different one
// that's running (its pages close, its sign-ins stay); a process whose file has been replaced since
// it started never replaces one (`replacesKeeper`).
const KEEPER = "249bdfa16c03";
// COMPAT(0.7 keeper-number): what a keeper says it is to processes from before KEEPER was a hash. Goes 3 months after 0.8.0.
// Those compare numbers, raised by hand to 50, and replace a keeper whose number is lower than
// theirs: every keeper since says 51, so none of them replaces it.
const KEEPER_NUMBER = 51;
// Passkeys: none yet, as in the panel's browser on the Mac (Passkeys.swift, the same script).
const NO_PASSKEYS = "(() => {\n  try {\n    // Says a passkey was asked for with an event only this launch's listener, in a world of its\n    // own, knows the name of: nothing of it is left in the page's world. (Taken before the page\n    // can change them.)\n    const dispatch = EventTarget.prototype.dispatchEvent, Made = Event;\n    const tell = () => {\n      try {\n        dispatch.call(window, new Made(\"KUVO_PASSKEY_EVENT\"));\n      } catch {}\n    };\n    const none = (options) => {\n      // Asked of you, not looked for quietly as the page loads.\n      if (options.mediation !== \"conditional\") tell();\n      return Promise.reject(new DOMException(\"Passkeys can't be used in this browser.\", \"NotAllowedError\"));\n    };\n    const Container = window.CredentialsContainer;\n    if (Container && Container.prototype) {\n      const prototype = Container.prototype, get = prototype.get, create = prototype.create;\n      if (get) prototype.get = function (options) { return options && options.publicKey ? none(options) : get.call(this, options); };\n      if (create) prototype.create = function (options) { return options && options.publicKey ? none(options) : create.call(this, options); };\n    }\n    const Credential = window.PublicKeyCredential;\n    if (Credential) {\n      Credential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);\n      if (Credential.isConditionalMediationAvailable) Credential.isConditionalMediationAvailable = () => Promise.resolve(false);\n    }\n  } catch {}\n})();";
// The event it fires when a passkey is asked for (a name of this keeper's, which only the
// listener knows), the world of the keeper's own the listener runs in, and the binding it tells
// the keeper through there: nothing of them is in the page's world.
const PASSKEY_EVENT = "kuvo-" + crypto.randomUUID();
const PASSKEY_WORLD = "kuvo-passkeys";
const PASSKEY_BINDING = "kuvoPasskeyAsked";
// (The binding comes back a moment after a new page does, so it's looked for a while.)
const PASSKEY_LISTENER = `window.addEventListener(${JSON.stringify(PASSKEY_EVENT)}, () => {
  const tell = (tries) => {
    const binding = globalThis.${PASSKEY_BINDING};
    if (typeof binding === "function") binding("");
    else if (tries > 0) setTimeout(() => tell(tries - 1), 100);
  };
  tell(20);
});`;
// What the agent's look at a page says when its site asked for one (as BrowserAgent.swift's).
const PASSKEY_NOTE = "This site asked for a passkey, which this browser can't use. Don't choose its passkey option again: sign in another way (a password, a code or an email link), or ask the user.";

// Bun's own, never its settings (`bunfig.toml`, which can preload a script) or a `.env` from the
// folder it starts in (an agent's command can write them); a test's Node loads neither.
const OWN_RUNTIME = process.versions.bun ? ["--config=/dev/null", "--no-env-file"] : [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// The key for the box's sockets, made once (whole, before anyone can read it).
function socketKey() {
  const shape = /^[0-9a-f]{64}$/;
  try {
    const key = fs.readFileSync(SOCKET_KEY_FILE, "utf8").trim();
    if (shape.test(key)) return key;
  } catch {}
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const made = `${SOCKET_KEY_FILE}.${process.pid}`;
  fs.writeFileSync(made, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  // Linked into place: whoever made it first, the others take theirs. (One that isn't a key at all
  // is replaced, as it is where a folder can't link files.)
  try {
    fs.linkSync(made, SOCKET_KEY_FILE);
  } catch {
    let there = "";
    try {
      there = fs.readFileSync(SOCKET_KEY_FILE, "utf8").trim();
    } catch {}
    if (!shape.test(there)) {
      try {
        fs.renameSync(made, SOCKET_KEY_FILE);
      } catch {}
    }
  }
  fs.rmSync(made, { force: true });
  return fs.readFileSync(SOCKET_KEY_FILE, "utf8").trim();
}

/// Whether `given` is the key for the box's sockets.
function sameKey(given) {
  if (typeof given !== "string") return false;
  let key;
  try {
    key = Buffer.from(socketKey());
  } catch {
    return false;
  }
  const said = Buffer.from(given);
  return said.length === key.length && crypto.timingSafeEqual(said, key);
}

/// A connection to the keeper, the key given first.
function keeperConnection() {
  const socket = net.createConnection(SOCKET);
  socket.once("connect", () => {
    try {
      socket.write(JSON.stringify({ method: "Kuvo.key", params: { key: socketKey() } }) + "\n");
    } catch {
      socket.destroy();
    }
  });
  return socket;
}

/// Calls `handle` with each line `stream` sends; `tooLong`, with how much of a line it holds,
/// says whether it's held too much (and stops it).
function lines(stream, handle, separator = "\n", tooLong = () => false) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf(separator)) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line) handle(line);
    }
    if (tooLong(buffer.length)) buffer = "";
  });
}

/// Whether a keeper answers on the socket.
function reachable() {
  return new Promise((resolve) => {
    const socket = net.createConnection(SOCKET);
    const done = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), 1500);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/// The running keeper's version, from its greeting: its `number` (1 before keepers said), and its
/// `build` (KEEPER: null before it was a hash); null if it didn't answer.
function runningKeeper() {
  return new Promise((resolve) => {
    const socket = keeperConnection();
    let buffer = "";
    const done = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 2000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const params = JSON.parse(buffer.slice(0, end)).params;
        done({ number: typeof params?.keeper === "number" ? params.keeper : 1, build: typeof params?.build === "string" ? params.build : null });
      } catch {
        done({ number: 1, build: null });
      }
    });
    socket.once("error", () => done(null));
  });
}

/// Asks the running keeper to stop, and waits until it has.
async function stopKeeper() {
  await new Promise((resolve) => {
    const socket = keeperConnection();
    socket.once("connect", () => socket.end(JSON.stringify({ method: "Kuvo.stop" }) + "\n", resolve));
    socket.once("error", resolve);
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await reachable())) await sleep(200);
}

/// What the box's own script (`kuvo-link.js`) answers `args` with, as JSON: null when it can't.
function askBox(args, timeout = 30_000) {
  return new Promise((resolve) => {
    const link = path.join(K, "bin", "kuvo-link.js");
    if (!fs.existsSync(link)) return resolve(null);
    let out = "";
    const child = spawn(process.execPath, [...OWN_RUNTIME, link, ...args], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, BUN_BE_BUN: "1" }, cwd: K });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.trim().split("\n").pop()));
      } catch {
        resolve(null);
      }
    });
  });
}

/// Has the box set the browser up (PROTOCOL.md, "The browser on a machine"), in a process of its
/// own that outlives this one; after a failure it waits as the box says, unless asked `now`.
/// How it stands then, or null when the box can't say.
function startSetUp({ now = false, repair = false } = {}) {
  const flags = [...(now ? ["--now"] : []), ...(repair ? ["--repair"] : [])];
  return askBox(["browser", "start", ...flags]);
}

/// The browser, set up by the box, and followed until it's there: null once it is, else what's
/// wrong. `told` hears how it goes (each `kuvo/browser` status as it changes); `wait` is how long to
/// follow it before saying it's still under way.
async function setUp(told, { repair = false, wait = 15 * 60_000 } = {}) {
  const began = Date.now();
  let status = await startSetUp({ repair });
  let said = "";
  while (true) {
    if (!status) return { kind: "missing", message: "This machine's box can't set up the browser. Connect to the machine from Kuvo Code on your Mac." };
    const underWay = ["checking", "downloading", "installing"].includes(status.state);
    const now = JSON.stringify([status.state, status.progress]);
    if (now !== said) {
      said = now;
      told?.(status);
    }
    if (!underWay) {
      if (status.state === "ready" && browserBinary(CURRENT)) return null;
      // Failed, or waits to try again: kind "missing", so an older Kuvo Code on a Mac puts the
      // browser there itself.
      return { kind: "missing", message: status.message || "The browser isn't on this machine, and its box couldn't set it up." };
    }
    if (Date.now() - began > wait) {
      const done = status.state === "downloading" && typeof status.progress === "number" ? ` (${Math.round(status.progress * 100)}% downloaded)` : "";
      return { kind: "installing", message: `This machine is still setting up its browser${done}. Try again in a minute.` };
    }
    await sleep(1_500);
    status = await askBox(["browser", "status"]);
  }
}

/// Starts the keeper if it isn't running (or an older one is), and waits for it: nil once it
/// answers, else what's wrong. The browser isn't there: the box sets it up first (`told` hears how
/// it goes, for `wait` at most); it doesn't start: the box sets it up again, once.
async function ensure(told, wait) {
  if (await reachable()) {
    if (!replacesKeeper(await runningKeeper())) return null;
    await stopKeeper();
  }
  for (let attempt = 0; ; attempt++) {
    if (!browserBinary(CURRENT)) {
      const problem = await setUp(told, { wait });
      if (problem) return problem;
    }
    const problem = await startKeeper();
    if (problem?.kind !== "broken" || attempt > 0) return problem;
    const repaired = await setUp(told, { repair: true, wait });
    if (repaired) return repaired;
  }
}

/// Whether this process replaces the keeper that's running (`running`, as `runningKeeper` gives it:
/// null when it didn't say): only while this process's file is the one in place (one started before
/// its file was replaced leaves the keeper be, as it would only start that file's again), and then
/// one from before KEEPER was a hash, or another one.
function replacesKeeper(running) {
  if (running === null || keeperInPlace() !== KEEPER) return false;
  return running.build === null ? running.number < KEEPER_NUMBER : running.build !== KEEPER;
}

/// The KEEPER of the file this process started from as it is now: null if it can't be read.
function keeperInPlace() {
  try {
    const found = /^const KEEPER = ("[^"\n]*");$/m.exec(fs.readFileSync(SCRIPT, "utf8"));
    return found ? JSON.parse(found[1]) : null;
  } catch {
    return null;
  }
}

async function startKeeper() {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  fs.rmSync(ERRORFILE, { force: true });
  // In a session of its own, so it outlives whoever started it.
  const child = spawn(process.execPath, [...OWN_RUNTIME, SCRIPT, "host"], { detached: true, stdio: "ignore", env: { ...process.env, BUN_BE_BUN: "1" }, cwd: BROWSER });
  child.unref();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await sleep(150);
    if (await reachable()) return null;
    if (fs.existsSync(ERRORFILE)) {
      try {
        return JSON.parse(fs.readFileSync(ERRORFILE, "utf8"));
      } catch {}
    }
  }
  return { kind: "failed", message: "The browser took too long to start." };
}

// MARK: - The keeper

function alive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // (Alive and not to be asked: taken as it.)
  return commandLine(pid)?.includes("kuvo-browser") ?? true;
}

/// A process's command line: in /proc on Linux, from `ps` on a Mac; undefined if it can't be read.
function commandLine(pid) {
  try {
    if (fs.existsSync("/proc/self")) return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/// Becomes the one keeper, unless another is running. The record of who it is appears whole (a
/// link to a file already written), so another keeper never reads it half-written; one that's left
/// from a keeper that died is taken over, and if two start at that moment, the one whose record
/// stays keeps going.
async function claim() {
  const mine = `${PIDFILE}.${process.pid}`;
  fs.writeFileSync(mine, String(process.pid), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.linkSync(mine, PIDFILE);
        await sleep(100 + Math.random() * 200);
        return Number(fs.readFileSync(PIDFILE, "utf8")) === process.pid;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let holder = 0;
        try {
          holder = Number(fs.readFileSync(PIDFILE, "utf8"));
        } catch {}
        if (alive(holder)) return false;
        fs.rmSync(PIDFILE, { force: true });
      }
    }
    return false;
  } finally {
    fs.rmSync(mine, { force: true });
  }
}

function fail(kind, message) {
  fs.writeFileSync(ERRORFILE, JSON.stringify({ kind, message }), { mode: 0o600 });
  fs.rmSync(PIDFILE, { force: true });
  process.exit(1);
}

function chromiumVersion() {
  try {
    return fs.readFileSync(path.join(CURRENT, "chromium-version"), "utf8").trim();
  } catch {
    return "130.0.0.0";
  }
}

// What the browser says it is: Chromium on what it runs on (Linux, or a Mac, which every Mac's
// browser says it is on Intel's). Sites serve a reduced page, or none, to one that
// says "HeadlessChrome" (x.com answers 403), and it says so in two places: the user agent, and
// the brand hints (Sec-CH-UA) pages send and read.
function userAgent() {
  const major = chromiumVersion().split(".")[0];
  if (process.platform === "darwin") return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const platform = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `Mozilla/5.0 (X11; Linux ${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function identity() {
  const version = chromiumVersion();
  const major = version.split(".")[0];
  return {
    userAgent: userAgent(),
    ...(LANGUAGES.length ? { acceptLanguage: LANGUAGES.join(",") } : {}),
    userAgentMetadata: {
      brands: [{ brand: "Chromium", version: major }, { brand: "Not-A.Brand", version: "24" }],
      fullVersionList: [{ brand: "Chromium", version }, { brand: "Not-A.Brand", version: "24.0.0.0" }],
      platform: process.platform === "darwin" ? "macOS" : "Linux",
      platformVersion: "",
      architecture: process.arch === "arm64" ? "arm" : "x86",
      bitness: "64",
      model: "",
      mobile: false,
    },
  };
}

/// A finished download, from its temporary name to its own (numbered if that's taken). Its path,
/// or null if it's gone.
function finishDownload(guid, name) {
  // At most 200 bytes, whole characters, its extension kept (a name can't be longer than 255
  // bytes there).
  const whole = path.basename(String(name)).replace(/^\.+/, "") || "download";
  let extension = path.extname(whole);
  let stem = whole.slice(0, whole.length - extension.length);
  if (Buffer.byteLength(extension) > 20) [stem, extension] = [whole, ""];
  // 200 characters first, then fewer while they're over 200 bytes: a site's name can be very long.
  const characters = [...stem].slice(0, 200);
  while (Buffer.byteLength(characters.join("") + extension) > 200) characters.pop();
  stem = characters.join("");
  const safe = stem + extension;
  let file = path.join(DOWNLOADS, safe);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(DOWNLOADS, `${stem} ${n}${extension}`);
  try {
    fs.renameSync(path.join(DOWNLOADS, guid), file);
    return file;
  } catch {
    return null;
  }
}

/// Downloads more than a week old.
function clearOldDownloads() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  let entries = [];
  try {
    entries = fs.readdirSync(DOWNLOADS, { withFileTypes: true });
  } catch {}
  for (const entry of entries) {
    const file = path.join(DOWNLOADS, entry.name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { recursive: true, force: true });
    } catch {}
  }
}

/// The browser in a build: Chrome itself, or the headless shell an earlier build had.
function browserBinary(build) {
  for (const name of ["chrome", "chrome-headless-shell"]) {
    if (fs.existsSync(path.join(build, name))) return name;
  }
  return null;
}

/// What a Chromium that was stopped hard left of its lock somewhere else, like the machine's
/// /tmp (one from before it had a folder of its own): gone, once that Chromium is.
function removeStaleLock() {
  try {
    // "<host>-<pid>", of the Chromium that last had the profile.
    const owner = fs.readlinkSync(path.join(PROFILE, "SingletonLock"));
    const pid = Number(owner.slice(owner.lastIndexOf("-") + 1));
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        return;
      } catch (error) {
        if (error.code !== "ESRCH") return;
      }
    }
    const folder = path.dirname(fs.readlinkSync(path.join(PROFILE, "SingletonSocket")));
    if (!/^(org\.chromium\.Chromium|com\.google\.Chrome|com\.google\.chrome\.for\.testing)\.[A-Za-z0-9]+$/.test(path.basename(folder))) return;
    if (fs.lstatSync(folder).uid !== process.getuid()) return;
    fs.rmSync(folder, { recursive: true, force: true });
  } catch {}
}

/// What each editing key does on a Mac, by what clients and tools send (as on Linux: Control for ⌘,
/// Home and End for ⌘← and ⌘→). Chrome on a Mac gets these from its window's key bindings, which a
/// key sent over DevTools never reaches: without them a key sent to a field does nothing.
const MAC_MOVES = { ArrowLeft: "moveLeft", ArrowRight: "moveRight", ArrowUp: "moveUp", ArrowDown: "moveDown", Home: "moveToLeftEndOfLine", End: "moveToRightEndOfLine" };
const MAC_WORD_MOVES = { ArrowLeft: "moveWordLeft", ArrowRight: "moveWordRight", Home: "moveToBeginningOfDocument", End: "moveToEndOfDocument" };
const MAC_DELETES = { Backspace: "deleteBackward", Delete: "deleteForward" };
const MAC_WORD_DELETES = { Backspace: "deleteWordBackward", Delete: "deleteWordForward" };
const MAC_LETTERS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo" };

/// A key as Chrome here takes it: on Linux as it's sent; on a Mac with ⌘ for Control, as pages there
/// expect, and what it does named.
function keyForHere(params, platform = process.platform) {
  if (platform !== "darwin") return params;
  const CONTROL = 2, META = 4, SHIFT = 8;
  const modifiers = params.modifiers ?? 0;
  const control = (modifiers & CONTROL) !== 0, shift = (modifiers & SHIFT) !== 0;
  const mac = { ...params, modifiers: control ? (modifiers & ~CONTROL) | META : modifiers };
  if (params.type === "keyUp" || params.commands?.length) return mac;
  const key = String(params.key ?? "");
  const move = (control ? MAC_WORD_MOVES : MAC_MOVES)[key];
  let command = move ? move + (shift ? "AndModifySelection" : "") : (control ? MAC_WORD_DELETES : MAC_DELETES)[key];
  if (control && !command) command = key.toLowerCase() === "z" && shift ? "redo" : shift ? undefined : MAC_LETTERS[key.toLowerCase()];
  return command ? { ...mac, commands: [command] } : mac;
}

/// Starts Chromium and waits until it answers on its pipe.
// The icons a page names (in the keeper's own world, where the page's scripts can't change what
// this reads), for its site's in the history.
const ICON_LINKS = `[...document.querySelectorAll("link[rel][href]")].map((link) => ({ rel: String(link.rel).toLowerCase(), href: link.href, sizes: String(link.getAttribute("sizes") || ""), type: String(link.type || "").toLowerCase() })).filter((link) => /(^|\\s)(icon|apple-touch-icon)(\\s|$)/.test(link.rel)).slice(0, 20)`;
// An icon bigger than this isn't fetched (nor kept, by the box).
const ICON_LIMIT = 128 * 1024;

/// The icon to keep of those a page names: one nearest 64 pixels (an icon's own before an
/// apple-touch-icon), never an SVG; null for none.
function bestIcon(links) {
  const usable = (Array.isArray(links) ? links : []).filter((link) => typeof link?.href === "string" && !String(link.type).includes("svg") && !/\.svg([?#]|$)/i.test(link.href));
  const size = (link) => Math.max(0, ...String(link.sizes ?? "").split(/\s+/).map((each) => Number(each.split("x")[0]) || 0)) || 32;
  const icons = usable.filter((link) => /(^|\s)icon(\s|$)/.test(link.rel));
  return (icons.length ? icons : usable).sort((a, b) => Math.abs(size(a) - 64) - Math.abs(size(b) - 64))[0]?.href ?? null;
}

async function launchChrome(sandbox) {
  const binary = browserBinary(fs.realpathSync(CURRENT)) ?? "chrome-headless-shell";
  const args = [
    // Chrome itself, without a window: the browser sites see from people, where the headless
    // shell is one Google won't sign anyone in from ("This browser or app may not be secure").
    // Its passwords in its profile, not a desktop keyring the server doesn't have.
    ...(binary === "chrome" ? ["--headless", "--enable-unsafe-swiftshader", "--password-store=basic"] : []),
    // On a Mac, nobody's there to answer what it would ask: its passwords' key from the login
    // keychain, and looking for devices on the local network (casting, which nothing here uses).
    ...(process.platform === "darwin" ? ["--use-mock-keychain", "--disable-features=MediaRouter,DialMediaRouteProvider"] : []),
    // A page nobody's looking at keeps going at full speed, as a bot's work in it needs.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    // Not driven by WebDriver, so it doesn't say it is (navigator.webdriver).
    "--disable-blink-features=AutomationControlled",
    "--remote-debugging-pipe",
    `--user-data-dir=${PROFILE}`,
    "--window-size=1280,800",
    // A Retina screen's scale, so pictures of the page are as sharp as the Mac shows them: an
    // emulated scale alone lays the page out for it, but the live view still comes at half size.
    "--force-device-scale-factor=2",
    ...(LANGUAGES.length ? [`--lang=${LANGUAGES[0]}`, `--accept-lang=${LANGUAGES.join(",")}`] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--mute-audio",
    // A scroll moves the page at once: the Mac's trackpad and wheel already ease it, and
    // Chrome's own easing on top, drawn a few times a second on a server, made it lag behind.
    "--disable-smooth-scrolling",
    `--user-agent=${userAgent()}`,
    "about:blank",
  ];
  if (!sandbox) args.unshift("--no-sandbox");
  // The build's own folder rather than `current`, which an update moves: its path shows which
  // build a running browser uses, so the update leaves that one in place.
  const build = fs.realpathSync(CURRENT);
  const lib = path.join(build, "lib");
  // A home of its own, inside Kuvo Code's folder: what Chromium keeps there (its certificate store,
  // caches, downloads) never lands in the user's.
  const home = path.join(BROWSER, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // The build's fonts, and the machine's own if it has any, with fontconfig's cache in that home
  // (written with whole paths: a relative one lands wherever the browser happens to start).
  const fontsConfig = path.join(home, "fonts.conf");
  const xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  fs.writeFileSync(fontsConfig, [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
    "<fontconfig>",
    `  <dir>${xml(path.join(build, "fonts"))}</dir>`,
    '  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>',
    `  <cachedir>${xml(path.join(home, ".cache", "fontconfig"))}</cachedir>`,
    // Droid Sans after them for the scripts they don't have: Chinese, Japanese and Korean (in
    // Droid Sans Fallback), Hebrew, Thai, Devanagari, Tamil and others; Japanese in its own
    // forms on a Japanese page.
    "  <alias><family>sans-serif</family><prefer><family>Liberation Sans</family><family>DejaVu Sans</family><family>Droid Sans</family><family>Droid Sans Fallback</family></prefer></alias>",
    "  <alias><family>serif</family><prefer><family>Liberation Serif</family><family>DejaVu Sans</family><family>Droid Sans Fallback</family></prefer></alias>",
    "  <alias><family>monospace</family><prefer><family>Liberation Mono</family><family>DejaVu Sans</family><family>Droid Sans Fallback</family></prefer></alias>",
    "  <alias><family>emoji</family><prefer><family>Noto Color Emoji</family></prefer></alias>",
    '  <match><test name="lang" compare="contains"><string>ja</string></test><edit name="family" mode="prepend"><string>Droid Sans Japanese</string></edit></match>',
    "</fontconfig>",
    "",
  ].join("\n"));
  // Its temporary files in its own folder, never the machine's /tmp, where one stopped hard would
  // leave them. Unless that's too far down for its lock's socket (a path of 107 bytes at most, 103
  // on a Mac):
  // then wherever its temporary files would go otherwise.
  removeStaleLock();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
  const fits = Buffer.byteLength(path.join(TMP, "org.chromium.Chromium.XXXXXX", "SingletonSocket")) <= (process.platform === "darwin" ? 103 : 107);
  const env = {
    ...process.env,
    ...(fits ? { TMPDIR: TMP } : {}),
    HOME: home,
    // (A Mac's programs find your home by your account, and this is what they take it from instead.
    // The one thing that still lands in the real one is the system's own record of Chrome's last run,
    // in its preferences, which nothing here changes: removing the machine takes it out.)
    CFFIXED_USER_HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    // Its own libraries and fonts, never the machine's: nothing has to be installed there.
    LD_LIBRARY_PATH: [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
    FONTCONFIG_FILE: fontsConfig,
    GIO_MODULE_DIR: path.join(lib, "gio-modules"),
    GSETTINGS_BACKEND: "memory",
  };
  delete env.BUN_BE_BUN;
  const log = fs.openSync(LOGFILE, "a", 0o600);
  fs.writeSync(log, `--- ${new Date().toISOString()} starting${sandbox ? "" : " without the sandbox"}\n`);
  const chrome = spawn(path.join(build, binary), args, { stdio: ["ignore", log, log, "pipe", "pipe"], env, cwd: home });
  fs.closeSync(log);
  let exited = null;
  chrome.on("exit", (code, signal) => (exited = { code, signal }));
  chrome.on("error", (error) => (exited = { code: -1, error }));
  const pipe = { input: chrome.stdio[3], output: chrome.stdio[4] };
  pipe.input.on("error", () => {});

  // Asks for its version; Chromium answers once it's up.
  const answered = new Promise((resolve) => {
    let buffer = "";
    const listen = (chunk) => {
      buffer += chunk;
      if (buffer.includes('"id":1,')) {
        pipe.output.off("data", listen);
        resolve(true);
      }
    };
    pipe.output.setEncoding("utf8");
    pipe.output.on("data", listen);
  });
  pipe.input.write(JSON.stringify({ id: 1, method: "Browser.getVersion" }) + "\0");
  const deadline = Date.now() + 30_000;
  let ready = false;
  answered.then(() => (ready = true));
  while (!ready && !exited && Date.now() < deadline) await sleep(50);
  if (ready) return { chrome, pipe };
  chrome.kill("SIGKILL");
  let output = "";
  try {
    output = fs.readFileSync(LOGFILE, "utf8");
  } catch {}
  // (The program itself couldn't be run: gone, or not a program; on a Mac, its launcher couldn't
  // run the app, 126 or 127.)
  const unrunnable = ["ENOENT", "EACCES", "ENOEXEC"].includes(exited?.error?.code) || exited?.code === 126 || exited?.code === 127;
  return { output: output || (exited?.error ? String(exited.error.message) : ""), timedOut: !exited, unrunnable };
}

async function host() {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  fs.chmodSync(RUN, 0o700);
  if (!(await claim())) return;
  // A socket left behind by a keeper that's gone.
  if (await reachable()) {
    fs.rmSync(PIDFILE, { force: true });
    return;
  }
  fs.rmSync(SOCKET, { force: true });
  fs.mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
  fs.writeFileSync(LOGFILE, "", { mode: 0o600 });

  // Sandboxed when the machine allows it (it needs user namespaces, which some distributions turn
  // off); as root, or where Chromium says it can't be, without. Anything else gets a second try.
  const isRoot = process.getuid && process.getuid() === 0;
  let sandbox = !isRoot;
  // The pages open last time, opened again once the browser's up (after the keeper's own
  // watch on pages, so they load as the browser it says it is), each with the conversation that
  // worked in it last.
  let reopen = [];
  try {
    reopen = JSON.parse(fs.readFileSync(PAGESFILE, "utf8"))
      // COMPAT(0.7 pages-addresses): a keeper from before kept addresses alone. Goes 3 months after 0.8.0.
      .map((page) => (typeof page === "string" ? { url: page } : page))
      .filter((page) => typeof page?.url === "string" && /^(https?|file):/.test(page.url))
      .map((page) => ({ url: page.url, session: typeof page.session === "string" ? page.session : null }))
      .slice(0, 8);
  } catch {}
  fs.rmSync(PAGESFILE, { force: true });
  // The box removing a site's data from the profile's files while Chrome was stopped: Chrome
  // starts once it's done. One held over half a minute was cut off: it goes, as the box's own
  // locks do.
  for (const until = Date.now() + 30_000; Date.now() < until; await sleep(100)) {
    let age;
    try {
      age = Date.now() - fs.statSync(PROFILE_EDITING).mtimeMs;
    } catch {
      break;
    }
    if (age <= 30_000) continue;
    try {
      fs.rmdirSync(PROFILE_EDITING);
    } catch {}
    break;
  }
  // What this Mac's app's panel kept before (its history, its settings): taken in by the box once,
  // as its own browser first starts (nothing to take on a machine).
  if (!fs.existsSync(path.join(BROWSER, "app-data-read"))) askBox(["browser", "take-in"]);
  // What a keeper before this one left asked: it went with it.
  fs.rmSync(ASKSFILE, { force: true });
  let started = await launchChrome(sandbox);
  if (!started.chrome && sandbox && /No usable sandbox|SUID sandbox|user namespace/i.test(started.output)) sandbox = false;
  if (!started.chrome) started = await launchChrome(sandbox);
  if (!started.chrome) {
    const lines = started.output.trim().split("\n").filter((line) => !/^\s*$/.test(line)).slice(-6).join("\n");
    if (/GLIBC_[0-9.]+' not found/.test(started.output)) {
      fail("unsupported", "This machine's C library (glibc) is too old for the browser.\n\n" + lines);
    }
    // Its build isn't whole (a library or the browser itself gone, or damaged): the box sets it up again.
    if (started.unrunnable || /error while loading shared libraries|cannot open shared object file|Exec format error/.test(started.output)) {
      fail("broken", "The browser on this machine isn't whole." + (lines ? "\n\n" + lines : ""));
    }
    fail("failed", (started.timedOut ? "The browser didn't start in time." : "The browser stopped as it started.") + (lines ? "\n\n" + lines : ""));
  }
  const { chrome, pipe } = started;

  let next = 2;
  const pending = new Map();
  const owners = new Map();
  const clients = new Set();
  let active = null;
  // The pages there are, so the one in use is always one of them.
  const targets = new Set();
  // The keeper's own session with each page and worker, which says what the browser is before
  // it loads anything; the ones clients open come after it.
  const own = new Map();
  // And with each frame of another site in a page, which Chrome runs on its own, as a target of
  // its own: held as it starts, as a page is.
  const ownFrames = new Set();
  const isOwn = (sessionId) => ownFrames.has(sessionId) || [...own.values()].includes(sessionId);
  // Each frame's target, and the page it's in, by its session.
  const frameTargets = new Map();
  const pageOf = (sessionId) => frameTargets.get(sessionId)?.page ?? [...own].find(([, each]) => each === sessionId)?.[0];
  // The page each frame of a page's own site is in (it runs in the page, no target of its own),
  // and the page that opened each page: where a download from one of them began.
  const framePages = new Map();
  const openers = new Map();
  // Sites that asked for a passkey lately (which this browser can't use), by host: an ask for
  // one says so, to tell you to choose another way to sign in.
  const passkeySites = new Map();
  const askedPasskeyLately = (host) => Date.now() - (passkeySites.get(host) ?? 0) < 10 * 60_000;
  // And the site of each page that asked, for a client that connects later (the agent's tools).
  const passkeyPages = new Map();
  // A page that's left that site, or closed: clients stop saying it.
  const passkeyCleared = (targetId) => {
    if (passkeyPages.delete(targetId)) broadcast({ method: "Kuvo.passkeyCleared", params: { targetId } });
  };
  // Downloads under way: their temporary names, and the names their sites gave them.
  const downloads = new Map();
  const browserIdentity = identity();
  let status = { working: false };
  let idle = null;
  // What agents ask the user for (a sign-in, a code, a step), by ID: who asked, and the ask. The
  // answer goes to the one who asked, and no one else.
  const asks = new Map();
  const noteAsks = () => {
    try {
      if (!asks.size) return fs.rmSync(ASKSFILE, { force: true });
      fs.writeFileSync(ASKSFILE + ".tmp", JSON.stringify({ asks: [...asks.values()].map((ask) => ask.params) }), { mode: 0o600 });
      fs.renameSync(ASKSFILE + ".tmp", ASKSFILE);
    } catch {}
  };
  const closeAsk = (id) => {
    if (asks.delete(id)) {
      broadcast({ method: "Kuvo.askClosed", params: { id } });
      noteAsks();
    }
  };

  const send = (client, message) => {
    if (!client.closed) client.socket.write((typeof message === "string" ? message : JSON.stringify(message)) + "\n");
  };
  const viewers = () => [...clients].filter((client) => client.viewer && !client.closed).length;
  const everyStatus = () => {
    const working = [...clients].filter((client) => client.status?.working && !client.closed);
    return {
      working: working.length > 0,
      tool: working[0]?.status.tool,
      pages: working.map((client) => client.status.targetId).filter(Boolean),
      // Who works where, for the Mac to name them.
      workers: working.filter((client) => client.status.targetId).map((client) => ({ targetId: client.status.targetId, session: client.status.session ?? null })),
    };
  };
  const broadcast = (message) => {
    const text = typeof message === "string" ? message : JSON.stringify(message);
    for (const client of clients) send(client, text);
  };
  const toChrome = (message) => pipe.input.write(JSON.stringify(message) + "\0");
  const internal = (method, params = {}) => {
    const id = next++;
    pending.set(id, { internal: true });
    toChrome({ id, method, params });
  };
  // The same, for its answer: its result, or null when Chrome refused it.
  const ownCall = (method, params = {}, sessionId) => new Promise((resolve) => {
    const id = next++;
    pending.set(id, { internal: true, answered: (message) => resolve(message.error ? null : message.result ?? {}) });
    toChrome({ id, method, params, ...(sessionId ? { sessionId } : {}) });
  });
  const setActive = (targetId, by, session) => {
    if (active === targetId) return;
    active = targetId;
    broadcast({ method: "Kuvo.activeChanged", params: { targetId, by, ...(session ? { session } : {}) } });
  };
  // Which conversation works in each page lately, so another one gets a page of its own rather
  // than taking over one in use; and when you last picked a page for a conversation.
  const claims = new Map();
  const picks = new Map();
  // Pages a Mac took over from the agents, and which client it is: their tools wait until it
  // hands them back, or goes.
  const held = new Map();
  // Which Mac took each page over, by the ID it gives: it can hand the page back from a new
  // connection while the old one is still open here (after a sleep).
  const holdMacs = new Map();
  // Pages held for a Mac whose connection dropped, with the drop they're kept from.
  const orphaned = new Map();
  const announceHeld = () => broadcast({ method: "Kuvo.held", params: { pages: [...held.keys()] } });
  // Each page's address, as the browser last said, and the page it started with.
  const addresses = new Map();
  let firstPage = null;
  // Each page's title, as the browser last said.
  const titles = new Map();
  // What the box removed while Chrome was stopped, the rest of it (what each site's pages stored):
  // cleared in the first page Chrome has (Storage's calls need one), and forgotten once Chrome took
  // each; what it refused is cleared the next time.
  let clearing = [];
  try {
    clearing = JSON.parse(fs.readFileSync(CLEAR_SITES, "utf8")).filter((host) => typeof host === "string" && /^[a-z0-9.:[\]-]+$/i.test(host));
  } catch {}
  const clearPending = async (sessionId) => {
    const hosts = clearing;
    clearing = [];
    const left = [];
    for (const host of hosts) {
      const done = await Promise.all(["https", "http"].map((scheme) => ownCall("Storage.clearDataForOrigin", { origin: `${scheme}://${host}`, storageTypes: "all" }, sessionId)));
      if (done.some((answer) => answer === null)) left.push(host);
    }
    try {
      if (left.length) fs.writeFileSync(CLEAR_SITES, JSON.stringify(left), { mode: 0o600 });
      else fs.rmSync(CLEAR_SITES, { force: true });
    } catch {}
  };
  // A line for the box's history (a page that loaded, or its site's icon); the box is asked to take
  // them in once they've piled up, so the file stays small with no client asking for the history.
  let foldAsked = 0;
  const noteForHistory = (line) => {
    try {
      // (Never past a few megabytes, should the box not take them in: a box from before this keeper.)
      if ((fs.statSync(VISITS, { throwIfNoEntry: false })?.size ?? 0) > 4 * 1024 * 1024) return;
      fs.appendFileSync(VISITS, JSON.stringify(line) + "\n", { mode: 0o600 });
      if (fs.statSync(VISITS).size > 256 * 1024 && Date.now() - foldAsked > 60_000) {
        foldAsked = Date.now();
        askBox(["browser", "fold"]);
      }
    } catch {}
  };
  // Sites whose icon was looked for since Chrome started: once each.
  const iconsAsked = new Set();
  // A page that loaded: noted for the history, and its site's icon fetched the first time, by Chrome
  // as the page's own (from its <link rel=icon>, else /favicon.ico), in a world of the keeper's own.
  const loaded = async (page, sessionId) => {
    const url = addresses.get(page);
    if (!/^https?:/.test(url ?? "")) return;
    noteForHistory({ url, title: titles.get(page) ?? "", at: Date.now() });
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    if (iconsAsked.has(origin)) return;
    iconsAsked.add(origin);
    const icon = await siteIcon(page, sessionId, url).catch(() => null);
    if (icon) noteForHistory({ url, icon, at: Date.now() });
  };
  const siteIcon = async (page, sessionId, url) => {
    const world = await ownCall("Page.createIsolatedWorld", { frameId: page, worldName: "kuvo-icons" }, sessionId);
    if (!world?.executionContextId) return null;
    const found = await ownCall("Runtime.evaluate", { expression: ICON_LINKS, contextId: world.executionContextId, returnByValue: true }, sessionId);
    const href = bestIcon(found?.result?.value) ?? new URL("/favicon.ico", url).href;
    const inline = /^data:[^,;]*;base64,(.*)$/s.exec(href);
    if (inline) return inline[1].length <= ICON_LIMIT * 1.4 ? inline[1] : null;
    if (!/^https?:/.test(href)) return null;
    const fetched = await ownCall("Network.loadNetworkResource", { frameId: page, url: href, options: { disableCache: false, includeCredentials: false } }, sessionId);
    const stream = fetched?.resource?.success && fetched.resource.stream;
    if (!stream) return null;
    const chunks = [];
    let size = 0;
    try {
      while (size <= ICON_LIMIT) {
        const read = await ownCall("IO.read", { handle: stream, size: 65_536 }, sessionId);
        if (!read) return null;
        const bytes = Buffer.from(read.data ?? "", read.base64Encoded ? "base64" : "utf8");
        chunks.push(bytes);
        size += bytes.length;
        if (read.eof) break;
      }
    } finally {
      ownCall("IO.close", { handle: stream }, sessionId);
    }
    return size > 0 && size <= ICON_LIMIT ? Buffer.concat(chunks).toString("base64") : null;
  };
  // The page each client's session is attached to, to know which pages a Mac shows.
  const attachedTo = new Map();
  const shown = (targetId) => [...attachedTo].some(([sessionId, target]) => target === targetId && owners.get(sessionId)?.viewer);
  // Pages a Mac has shown: yours, kept however long agents leave them alone.
  const seen = new Set();
  // Pages only agents used, left alone for an hour, close: sessions' subagents and bots that wake
  // every hour don't pile up tabs. Never the page in use, one a Mac shows or showed, or the last one.
  // Unless the Mac's Settings › Panel keeps them (it leaves this file while it does), and not while
  // its conversation works or waits for you to go on in it (the engine's or the agents bridge's
  // sessions at work), as the Mac's panel does (Utilities.isBusy).
  setInterval(async () => {
    if (fs.existsSync(path.join(BROWSER, "keeps-agent-tabs"))) return;
    const idle = [...claims].filter(([targetId, claim]) => Date.now() - claim.at >= TAB_IDLE && targetId !== active && !shown(targetId) && !seen.has(targetId));
    if (!idle.length) return;
    const busy = new Set();
    for (const place of ["engine", "bridge"]) {
      const data = (await engine("GET", "api/session/active", undefined, place).catch(() => null))?.data;
      for (const id of Array.isArray(data) ? data : Object.keys(data ?? {})) busy.add(id);
    }
    for (const [targetId, claim] of idle) {
      if (busy.has(claim.session) || targets.size <= 1 || claims.get(targetId) !== claim) continue;
      claims.delete(targetId);
      internal("Target.closeTarget", { targetId });
    }
  }, Math.min(5 * 60_000, TAB_IDLE / 2)).unref();
  // A build an update put in `current` takes over once nobody uses this one (no agent at work or
  // between its steps lately, no page taken over or shown, nothing asked): what's open is kept,
  // and opens again when the next client starts the browser from there. Otherwise one started
  // before the update arrived would run the old build for as long as the engine does.
  const runsFrom = path.dirname(chrome.spawnfile);
  const usedLately = () => [...claims.values()].some((claim) => Date.now() - claim.at < 10 * 60_000);
  setInterval(() => {
    let installed;
    try {
      installed = fs.realpathSync(CURRENT);
    } catch {
      return;
    }
    if (installed === runsFrom || everyStatus().working || usedLately() || held.size || asks.size || viewers()) return;
    stop();
  }, 60_000).unref();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // What's open, to open again next time, with the conversation that worked in each.
    const open = [...addresses].filter(([, url]) => /^(https?|file):/.test(url ?? "")).map(([targetId, url]) => ({ url, session: claims.get(targetId)?.session ?? null }));
    try {
      if (open.length) fs.writeFileSync(PAGESFILE, JSON.stringify(open.slice(-8)), { mode: 0o600 });
    } catch {}
    try {
      toChrome({ id: next++, method: "Browser.close" });
    } catch {}
    const deadline = Date.now() + 3000;
    while (chrome.exitCode === null && chrome.signalCode === null && Date.now() < deadline) await sleep(50);
    chrome.kill("SIGKILL");
    cleanUp();
    process.exit(0);
  };
  const cleanUp = () => {
    fs.rmSync(SOCKET, { force: true });
    fs.rmSync(ASKSFILE, { force: true });
    try {
      if (Number(fs.readFileSync(PIDFILE, "utf8")) === process.pid) fs.rmSync(PIDFILE, { force: true });
    } catch {}
  };
  const idleSoon = () => {
    clearTimeout(idle);
    idle = setTimeout(stop, IDLE);
  };

  chrome.on("exit", () => {
    for (const client of clients) client.socket.end();
    cleanUp();
    process.exit(0);
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);

  lines(pipe.output, (text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (!request || request.internal) return request?.answered?.(message);
      if (request.method === "Target.attachToTarget" && message.result?.sessionId) {
        owners.set(message.result.sessionId, request.client);
        request.client.sessions.add(message.result.sessionId);
        attachedTo.set(message.result.sessionId, request.targetId);
        if (request.client.viewer) seen.add(request.targetId);
      }
      message.id = request.id;
      send(request.client, message);
      return;
    }
    // Chrome gives a new document a binding only with its Runtime domain on (which sites notice):
    // each of the keeper's pages and frames gets it again as it navigates.
    if (message.method === "Page.frameNavigated" && message.sessionId && isOwn(message.sessionId)) {
      toChrome({ id: next++, method: "Runtime.addBinding", params: { name: PASSKEY_BINDING, executionContextName: PASSKEY_WORLD }, sessionId: message.sessionId });
    }
    // A page (or a frame of another site in it) asked for a passkey: its site as Chrome has it.
    if (message.method === "Runtime.bindingCalled" && message.params?.name === PASSKEY_BINDING) {
      if (!message.sessionId || !isOwn(message.sessionId)) return;
      // The page's site, as Chrome last said its address, which an ask names, even when a frame
      // of another site in it asked.
      const page = pageOf(message.sessionId);
      const host = page && hostOf(addresses.get(page) ?? "");
      // Asked again by the same page: said already.
      if (!host || passkeyPages.get(page) === host) return;
      for (const site of passkeySites.keys()) if (!askedPasskeyLately(site)) passkeySites.delete(site);
      passkeySites.set(host, Date.now());
      let changed = false;
      for (const ask of asks.values()) {
        if (ask.params.host !== host || ask.params.passkey) continue;
        ask.params.passkey = true;
        changed = true;
      }
      if (changed) noteAsks();
      passkeyPages.set(page, host);
      return broadcast({ method: "Kuvo.passkeyAsked", params: { host, targetId: page } });
    }
    if (message.method === "Target.detachedFromTarget") {
      frameTargets.delete(message.params.sessionId);
      const owner = owners.get(message.params.sessionId);
      owner?.sessions.delete(message.params.sessionId);
      owners.delete(message.params.sessionId);
      attachedTo.delete(message.params.sessionId);
    }
    // A page, or a frame of another site in one of the keeper's pages.
    const frame = message.method === "Target.attachedToTarget" && message.sessionId && isOwn(message.sessionId);
    if (message.method === "Target.attachedToTarget" && (frame || (!message.sessionId && !own.has(message.params.targetInfo.targetId)))) {
      const { sessionId, targetInfo, waitingForDebugger } = message.params;
      if (frame) {
        ownFrames.add(sessionId);
        frameTargets.set(sessionId, { targetId: targetInfo.targetId, page: pageOf(message.sessionId) });
      } else {
        own.set(targetInfo.targetId, sessionId);
        if (clearing.length && targetInfo.type === "page") clearPending(sessionId);
      }
      toChrome({ id: next++, method: "Network.setUserAgentOverride", params: browserIdentity, sessionId });
      // No passkeys here yet: a page asking for one hears so at once, instead of Chrome's passkey
      // dialog, which no one sees in the live view, holding the page still (Passkeys.swift). The
      // page domain first: without it Chrome takes the script and never runs it.
      toChrome({ id: next++, method: "Page.enable", params: {}, sessionId });
      // How the script says a passkey was asked for: its listener in a world of the keeper's, and
      // the binding there (no Runtime domain needed, which sites notice).
      toChrome({ id: next++, method: "Runtime.addBinding", params: { name: PASSKEY_BINDING, executionContextName: PASSKEY_WORLD }, sessionId });
      toChrome({ id: next++, method: "Page.addScriptToEvaluateOnNewDocument", params: { source: PASSKEY_LISTENER, worldName: PASSKEY_WORLD, runImmediately: true }, sessionId });
      toChrome({ id: next++, method: "Page.addScriptToEvaluateOnNewDocument", params: { source: NO_PASSKEYS.replace("KUVO_PASSKEY_EVENT", PASSKEY_EVENT), runImmediately: true }, sessionId });
      // Its frames of other sites run on their own: the same for them (a sign-in button from
      // another site, say).
      toChrome({ id: next++, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId });
      if (waitingForDebugger) toChrome({ id: next++, method: "Runtime.runIfWaitingForDebugger", params: {}, sessionId });
      return;
    }
    if (message.method === "Target.detachedFromTarget" && (ownFrames.delete(message.params.sessionId) || [...own.values()].includes(message.params.sessionId))) return;
    if (message.method === "Page.frameAttached" && message.sessionId && isOwn(message.sessionId)) framePages.set(message.params.frameId, pageOf(message.sessionId));
    if (message.method === "Page.frameDetached" && message.sessionId && isOwn(message.sessionId)) framePages.delete(message.params.frameId);
    if (message.method === "Browser.downloadWillBegin" && !downloads.has(message.params.guid)) {
      // Whose it is: the conversation at work in the page it started in (a page's main frame's ID
      // is the page's; a frame's is its page's), now or in the last two minutes, unless you'd
      // taken the page over. One a page began as it opened (a link to a new tab) is that of the
      // page that opened it. Anyone else's (yours, a page an agent left) is nobody's.
      const pageWith = (frame) => framePages.get(frame) ?? [...frameTargets.values()].find((each) => each.targetId === frame)?.page ?? frame;
      const whose = (page) => {
        const worker = everyStatus().workers.find((each) => each.targetId === page && each.session);
        const claim = claims.get(page);
        return held.has(page) ? undefined : worker?.session ?? (claim && Date.now() - claim.at < 2 * 60_000 ? claim.session : undefined);
      };
      const page = pageWith(message.params.frameId);
      const opener = openers.get(page);
      const session = whose(page) ?? (opener && !held.has(page) ? whose(pageWith(opener)) : undefined);
      downloads.set(message.params.guid, { name: message.params.suggestedFilename || "download", session });
      broadcast({ method: "Kuvo.downloading", params: { name: downloads.get(message.params.guid).name, session } });
    }
    if (message.method === "Browser.downloadProgress" && message.params.state !== "inProgress") {
      const { name, session } = downloads.get(message.params.guid) ?? {};
      downloads.delete(message.params.guid);
      if (message.params.state === "completed" && name) {
        const file = finishDownload(message.params.guid, name);
        if (file) broadcast({ method: "Kuvo.downloaded", params: { name: path.basename(file), path: file, size: message.params.totalBytes, session } });
        else broadcast({ method: "Kuvo.downloadFailed", params: { name, session } });
        // Kept in the record of what agents made, as that conversation's (none running: not kept).
        if (file && session) engine("POST", "api/kuvo/artifacts/noted", { path: file, session, via: "download" }, "bridge").catch(() => {});
      } else if (name) {
        broadcast({ method: "Kuvo.downloadFailed", params: { name, session } });
      }
    }
    if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page") {
      targets.add(message.params.targetInfo.targetId);
      if (message.params.targetInfo.openerId) openers.set(message.params.targetInfo.targetId, message.params.targetInfo.openerId);
    }
    if ((message.method === "Target.targetCreated" || message.method === "Target.targetInfoChanged") && message.params.targetInfo.type === "page") {
      addresses.set(message.params.targetInfo.targetId, message.params.targetInfo.url);
      titles.set(message.params.targetInfo.targetId, message.params.targetInfo.title ?? "");
      firstPage ??= message.params.targetInfo.targetId;
      // A page that's left the site that asked for a passkey: nothing's said of it any more.
      const asked = passkeyPages.get(message.params.targetInfo.targetId);
      if (asked && hostOf(message.params.targetInfo.url) !== asked) passkeyCleared(message.params.targetInfo.targetId);
    }
    if (message.method === "Target.targetDestroyed") {
      targets.delete(message.params.targetId);
      openers.delete(message.params.targetId);
      for (const [frame, page] of framePages) if (page === message.params.targetId) framePages.delete(frame);
      addresses.delete(message.params.targetId);
      titles.delete(message.params.targetId);
      passkeyCleared(message.params.targetId);
      own.delete(message.params.targetId);
      claims.delete(message.params.targetId);
      seen.delete(message.params.targetId);
      orphaned.delete(message.params.targetId);
      holdMacs.delete(message.params.targetId);
      if (held.delete(message.params.targetId)) announceHeld();
      if (message.params.targetId === active) setActive(null, "browser");
    }
    // A page loaded (heard on the keeper's own session with it, which every page has): for the history.
    if (message.method === "Page.loadEventFired" && message.sessionId) {
      const page = [...own].find(([, each]) => each === message.sessionId)?.[0];
      if (page && targets.has(page)) loaded(page, message.sessionId);
    }
    const owner = message.sessionId ? owners.get(message.sessionId) : null;
    if (owner) send(owner, text);
    else if (!message.sessionId) broadcast(text);
  }, "\0");

  const server = net.createServer((socket) => {
    const client = { socket, sessions: new Set(), closed: false };
    // Kuvo Code's own processes first give the box's socket key; one that doesn't (a command in the
    // sandbox, or an older Kuvo Code's) hears only that it can't, and is closed. It counts as no one
    // using the browser meanwhile, and has a few seconds and a short line to give it in.
    const refuse = () => {
      if (client.keyed || client.closed) return;
      client.closed = true;
      // Closed once it has read why and closed too: what it still sends is read and dropped (a
      // socket closed with that unread is reset, and the reset can lose the words). Or soon after.
      socket.end(JSON.stringify({ method: "Kuvo.error", params: { kind: "failed", message: "This machine's browser needs a newer Kuvo Code. Update Kuvo Code on your Mac to use it." } }) + "\n");
      setTimeout(() => socket.destroy(), 5_000).unref?.();
    };
    const unkeyed = setTimeout(refuse, 10_000);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(unkeyed);
      client.closed = true;
      if (!client.keyed) return;
      clients.delete(client);
      for (const sessionId of client.sessions) {
        owners.delete(sessionId);
        internal("Target.detachFromTarget", { sessionId });
      }
      for (const [id, ask] of asks) if (ask.client === client) closeAsk(id);
      // A page a Mac took over stays taken ten minutes after its connection drops (it slept, the
      // network blinked), for it to take the page again as it comes back. (One it closes on
      // purpose hands its pages back first.)
      for (const [targetId, holder] of held) {
        if (holder !== client) continue;
        const token = Symbol();
        held.set(targetId, null);
        orphaned.set(targetId, token);
        setTimeout(() => {
          if (orphaned.get(targetId) !== token) return;
          orphaned.delete(targetId);
          held.delete(targetId);
          holdMacs.delete(targetId);
          announceHeld();
        }, 600_000).unref?.();
      }
      if (client.status?.working) broadcast({ method: "Kuvo.status", params: (status = everyStatus()) });
      if (client.viewer) broadcast({ method: "Kuvo.viewers", params: { count: viewers() } });
      if (!client.quiet && ![...clients].some((each) => !each.quiet)) idleSoon();
    });
    lines(socket, (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        if (!client.keyed) refuse();
        return;
      }
      if (client.closed) return;
      if (!client.keyed) {
        if (message.method !== "Kuvo.key" || !sameKey(message.params?.key)) return refuse();
        client.keyed = true;
        clearTimeout(unkeyed);
        clients.add(client);
        // The box reading what the browser keeps (its cookies) or removing a site's data: it doesn't
        // keep the browser running.
        client.quiet = message.params?.quiet === true;
        if (!client.quiet) clearTimeout(idle);
        send(client, { method: "Kuvo.hello", params: { targetId: active, status, version: VERSION, keeper: KEEPER_NUMBER, build: KEEPER, asks: [...asks.values()].map((ask) => ask.params), viewers: viewers(), held: [...held.keys()], holdMacs: Object.fromEntries(holdMacs), passkeys: Object.fromEntries(passkeyPages) } });
        return;
      }
      switch (message.method) {
        case "Kuvo.viewing":
          // A Mac showing the browser: someone who can answer asks.
          client.viewer = true;
          broadcast({ method: "Kuvo.viewers", params: { count: viewers() } });
          return message.id !== undefined && send(client, { id: message.id, result: {} });
        case "Kuvo.getActive":
          return send(client, { id: message.id, result: { targetId: active } });
        case "Kuvo.setActive": {
          // A page closed a moment ago isn't the one in use.
          const target = message.params?.targetId ?? null;
          if (target === null || targets.has(target)) {
            setActive(target, message.params?.by ?? "user", message.params?.session);
            // You picked it for that conversation: its agent goes on there.
            if (target && message.params?.by !== "agent" && message.params?.session) {
              picks.set(message.params.session, Date.now());
              claims.set(target, { session: message.params.session, at: Date.now() });
            }
          }
          return message.id !== undefined && send(client, { id: message.id, result: {} });
        }
        case "Kuvo.setStatus":
          // Each helper's: the pages agents are at work in, all together.
          client.status = message.params ?? { working: false };
          status = everyStatus();
          broadcast({ method: "Kuvo.status", params: status });
          return message.id !== undefined && send(client, { id: message.id, result: {} });
        case "Kuvo.stop":
          return stop();
        case "Kuvo.ask": {
          const params = message.params ?? {};
          // One already asked keeps its asker: its answer goes to it.
          if (!params.id || asks.has(params.id)) return;
          if (params.host && askedPasskeyLately(params.host)) params.passkey = true;
          asks.set(params.id, { client, params });
          noteAsks();
          return broadcast({ method: "Kuvo.asked", params });
        }
        case "Kuvo.answer": {
          const ask = asks.get(message.params?.id);
          if (ask) {
            send(ask.client, { method: "Kuvo.answered", params: { id: message.params.id, answer: message.params.answer } });
            closeAsk(message.params.id);
          }
          return message.id !== undefined && send(client, { id: message.id, result: {} });
        }
        case "Kuvo.cancelAsk":
          return closeAsk(message.params?.id);
        case "Kuvo.mine": {
          // The page a conversation worked in last, if it's still open, and whether you picked
          // another for it since.
          const session = message.params?.session;
          let mine = null;
          for (const [targetId, claim] of claims) if (claim.session === session && targets.has(targetId) && (!mine || claim.at > mine.at)) mine = { targetId, at: claim.at };
          return send(client, { id: message.id, result: { ...(mine ?? {}), picked: picks.get(session) ?? 0 } });
        }
        case "Kuvo.claim": {
          // A conversation's agent wants to work in a page: yes, unless another one has in the
          // last minute and a half, or has it on a Mac's screen.
          const { targetId, session } = message.params ?? {};
          // A page a Mac shows stays with its conversation however long ago it was last used.
          const claim = claims.get(targetId);
          const ok = !claim || claim.session === session || (Date.now() - claim.at > 90_000 && !shown(targetId));
          if (ok && targetId && session) claims.set(targetId, { session, at: Date.now() });
          return message.id !== undefined && send(client, { id: message.id, result: { ok } });
        }
        case "Kuvo.pointer":
          // Where the agent is about to act, for the pointer in every view of the page.
          return broadcast({ method: "Kuvo.pointer", params: message.params ?? {} });
        case "Kuvo.hold": {
          // You took a page over from the agent, or handed it back.
          const { targetId, on, mac } = message.params ?? {};
          if (targetId && on && targets.has(targetId)) {
            orphaned.delete(targetId);
            held.set(targetId, client);
            if (mac) holdMacs.set(targetId, mac); else holdMacs.delete(targetId);
          } else if (targetId && (held.get(targetId) === client || (mac && holdMacs.get(targetId) === mac) ||
            (held.get(targetId) === null && !holdMacs.has(targetId)))) {
            // Only its own hold (this connection's, or this Mac's from before, kept since its
            // connection dropped), or a kept one no Mac is known for: not another Mac's.
            orphaned.delete(targetId);
            held.delete(targetId);
            holdMacs.delete(targetId);
          }
          announceHeld();
          return message.id !== undefined && send(client, { id: message.id, result: {} });
        }
      }
      if (message.id === undefined || typeof message.method !== "string") return;
      const id = next++;
      pending.set(id, { client, id: message.id, method: message.method, targetId: message.params?.targetId });
      const forward = { id, method: message.method, params: message.method === "Input.dispatchKeyEvent" ? keyForHere(message.params ?? {}) : message.params ?? {} };
      if (message.sessionId) forward.sessionId = message.sessionId;
      toChrome(forward);
    }, "\n", (held) => !client.keyed && held > 4096 && (refuse(), true));
  });
  server.on("error", (error) => fail("failed", "The browser couldn't listen for Kuvo Code: " + error.message));
  // Its own view of the pages there, whoever else asks for it, and a session with each, held
  // before it starts.
  internal("Target.setDiscoverTargets", { discover: true });
  internal("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  // Downloads go into the browser's folder, each under a temporary name until it's done.
  fs.mkdirSync(DOWNLOADS, { recursive: true, mode: 0o700 });
  clearOldDownloads();
  // And every hour while it runs, which can be for days.
  setInterval(clearOldDownloads, 3_600_000).unref?.();
  internal("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: DOWNLOADS, eventsEnabled: true });
  if (reopen.length) {
    for (const { url, session } of reopen) {
      // Each page again its conversation's, as when it was last used.
      ownCall("Target.createTarget", { url, newWindow: true }).then((made) => {
        if (made?.targetId && session) claims.set(made.targetId, { session, at: Date.now() });
      });
    }
    // The blank page the browser starts with goes, once the others are there.
    setTimeout(() => {
      const url = addresses.get(firstPage);
      if (firstPage && (!url || url === "about:blank") && targets.size > 1 && !shown(firstPage)) internal("Target.closeTarget", { targetId: firstPage });
    }, 2000);
  }
  const mask = process.umask(0o077);
  server.listen(SOCKET, () => {
    process.umask(mask);
    fs.rmSync(ERRORFILE, { force: true });
    idleSoon();
  });
}

// MARK: - Talking to the keeper

/// One connection to the keeper, with requests matched to their answers.
class Connection {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.waiting = new Map();
    this.handlers = new Set();
    this.closed = false;
    lines(socket, (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.id !== undefined && this.waiting.has(message.id)) {
        const { resolve, reject, timer } = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message || "The browser refused that."));
        else resolve(message.result ?? {});
      } else if (message.method) {
        for (const handler of this.handlers) handler(message);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.closed = true;
      for (const { reject, timer } of this.waiting.values()) {
        clearTimeout(timer);
        reject(new Error("The browser stopped."));
      }
      this.waiting.clear();
      for (const handler of this.handlers) handler({ method: "Kuvo.closed" });
    });
  }

  static open() {
    return new Promise((resolve, reject) => {
      const socket = keeperConnection();
      socket.once("connect", () => resolve(new Connection(socket)));
      socket.once("error", reject);
    });
  }

  send(method, params = {}, sessionId, timeout = 30_000) {
    if (this.closed) return Promise.reject(new Error("The browser stopped."));
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`The browser didn't answer (${method}).`));
      }, timeout);
      this.waiting.set(id, { resolve, reject, timer });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.socket.write(JSON.stringify(message) + "\n");
    });
  }

  notify(method, params = {}) {
    if (!this.closed) this.socket.write(JSON.stringify({ method, params }) + "\n");
  }
}

// MARK: - The live view

async function connect() {
  // How the box's setup of the browser goes, for the Mac to show meanwhile.
  const told = (status) => process.stdout.write(JSON.stringify({ method: "Kuvo.installing", params: { state: status.state, progress: status.progress ?? null } }) + "\n");
  const problem = await ensure(told);
  if (problem) {
    process.stdout.write(JSON.stringify({ method: "Kuvo.error", params: problem }) + "\n");
    return;
  }
  const socket = keeperConnection();
  socket.on("connect", () => {
    // Pictures of a page come one at a time, each once the last is acknowledged. Here, a couple
    // ahead of the Mac: the next is made while the last is on its way, so over a slow link the
    // round trip doesn't set the frame rate, and no more than that many are ever under way.
    const ahead = 2;
    const pacing = new Map();
    const pace = (session) => pacing.get(session) ?? pacing.set(session, { underWay: 0, owed: [] }).get(session);
    const acknowledge = (session, frame) => socket.write(JSON.stringify({ id: -2, method: "Page.screencastFrameAck", params: { sessionId: frame }, sessionId: session }) + "\n");
    lines(process.stdin, (line) => {
      if (line.includes('"Page.screencastFrameAck"') || line.includes('"Page.startScreencast"') || line.includes('"Page.stopScreencast"')) {
        const message = JSON.parse(line);
        if (message.method === "Page.screencastFrameAck") {
          // The Mac has it: one fewer under way, and the picture held back can come.
          const p = pace(message.sessionId);
          p.underWay = Math.max(0, p.underWay - 1);
          const frame = p.owed.shift();
          if (frame !== undefined) acknowledge(message.sessionId, frame);
          return;
        }
        // Starting or stopping over: nothing under way.
        pacing.delete(message.sessionId);
      }
      socket.write(line + "\n");
    });
    lines(socket, (line) => {
      // The answers to the acknowledgments made here.
      if (line.startsWith('{"id":-2,')) return;
      if (line.startsWith('{"method":"Page.screencastFrame"')) {
        // Its numbers are at the end; the picture before them is long.
        const ids = line.slice(-160).match(/"sessionId":(\d+)\}\s*,\s*"sessionId":"([^"]+)"\}\s*$/);
        const [frame, session] = ids ? [Number(ids[1]), ids[2]] : (({ params, sessionId }) => [params.sessionId, sessionId])(JSON.parse(line));
        const p = pace(session);
        p.underWay += 1;
        if (p.underWay <= ahead) acknowledge(session, frame);
        else p.owed.push(frame);
      }
      process.stdout.write(line + "\n");
    });
  });
  socket.on("close", () => process.exit(0));
  socket.on("error", (error) => {
    process.stdout.write(JSON.stringify({ method: "Kuvo.error", params: { kind: "failed", message: error.message } }) + "\n");
    process.exit(1);
  });
  process.stdin.on("end", () => socket.end());
}

// MARK: - The agent's tools

class ToolError extends Error {}
// The page a call would work in is one you've taken over: it waits for you, out of the line.
class HeldError extends Error {}
// The engine gave up on the call (it was stopped, or ran out of time): it goes no further, and
// nothing answers it.
class Cancelled extends Error {}

let link = null;
let active = null;
const sessions = new Map();
// Dialogs a page opened that no tool has answered (none was at work in it), by session, and what
// the agent should hear about the ones answered.
const dialogs = new Map();
const notes = [];
const noteOnce = (note) => {
  if (!notes.includes(note)) notes.push(note);
};
// What each conversation's downloads did, until one of its calls says so (one that says nothing
// of its page, a screenshot say, leaves them for the next). Every helper hears every download, so
// only the latest conversations' and their latest news are kept.
const downloadNotes = new Map();
/// A download's news, for the conversation it's for. One that's nobody's (yours, a page no agent
/// was in) goes to no agent, except one at work that can't say whose it is.
function noteDownload(note, session = null) {
  if (!session) {
    if (busy && !caller) noteOnce(note);
    return;
  }
  const waiting = downloadNotes.get(session) ?? [];
  downloadNotes.delete(session);
  if (!waiting.includes(note)) waiting.push(note);
  downloadNotes.set(session, waiting.slice(-20));
  if (downloadNotes.size > 100) downloadNotes.delete(downloadNotes.keys().next().value);
}

/// What the agent hears ahead of a call's result: what happened on the way, and its conversation's
/// downloads.
function heard() {
  const said = notes.splice(0);
  if (caller && downloadNotes.has(caller)) {
    for (const note of downloadNotes.get(caller)) if (!said.includes(note)) said.push(note);
    downloadNotes.delete(caller);
  }
  return said.length ? said.join("\n") + "\n\n" : "";
}
let busy = false;
// The tool at work, and the page it works in.
let currentTool = null;
let workingIn = null;
// The tool at work said to accept confirmations and prompts, rather than decline them.
let acceptDialogs = false;
// The session whose tool call is under way, when the engine says.
let caller = null;
// Asks waiting for the user's answer, by ID.
const waiting = new Map();
// How many Macs show this browser now (who could answer an ask).
let viewerCount = 1;
// A file picker an upload is waiting for, by page session.
const choosers = new Map();
// Pages you took over in Kuvo Code: a tool for one waits until you hand it back.
let held = new Set();
// The site of each page whose site asked for a passkey (which this browser can't use), by page,
// for the agent's look at the page to say so.
const passkeyPages = new Map();
const heldWaiters = new Set();
// One tool call at a time in the browser, as they share its pages: the one whose turn it is, and
// the line after it. A call waiting for you (to hand its page back, or to answer) waits out of
// the line, so it holds up no one else's.
let current = null;
let line = Promise.resolve();

/// Waits for the call's turn, then makes it the one at work.
async function takeTurn(call) {
  let done;
  const turn = new Promise((resolve) => (done = resolve));
  const before = line;
  line = before.then(() => turn);
  await before;
  call.done = done;
  current = call;
  busy = true;
  acceptDialogs = call.args.accept_dialog === true;
  // The engine names the session calling, so an ask goes to the right conversation.
  caller = call.session;
  currentTool = call.name;
  workingIn = null;
  notes.unshift(...call.notes.splice(0));
  link?.notify("Kuvo.setStatus", { working: true, tool: call.name });
}

/// The call's turn ends, and the next in line goes.
function endTurn(call) {
  if (current === call) {
    unguardFiles();
    current = null;
    busy = false;
    acceptDialogs = false;
    caller = null;
    currentTool = null;
    workingIn = null;
    notes.length = 0;
    link?.notify("Kuvo.setStatus", { working: false });
  }
  call.done?.();
}

/// Waits for `until` (you) out of the line, so other calls go on meanwhile, then gets back in
/// line to go on where it left off; one the engine gave up on meanwhile goes no further.
async function outOfLine(until) {
  const call = current;
  call.notes = notes.splice(0);
  endTurn(call);
  const result = await until(call);
  if (call.cancelled) throw new Cancelled();
  await takeTurn(call);
  if (call.cancelled) throw new Cancelled();
  return result;
}

// The link being opened, so calls at once share it.
let opening = null;

async function browser() {
  if (link && !link.closed) return link;
  opening ??= openLink().finally(() => (opening = null));
  return opening;
}

async function openLink() {
  // (A tool waits for the box's setup a few minutes; then it says to try again.)
  const problem = await ensure(null, 4 * 60_000);
  if (problem) throw new ToolError(problem.message);
  link = await Connection.open();
  sessions.clear();
  fileRules.clear();
  refusedFiles.clear();
  link.handlers.add((message) => {
    switch (message.method) {
      case "Kuvo.hello":
        active = message.params.targetId;
        for (const [target, host] of Object.entries(message.params.passkeys ?? {})) passkeyPages.set(target, host);
        viewerCount = message.params.viewers ?? 1;
        held = new Set(message.params.held ?? []);
        break;
      case "Kuvo.held":
        held = new Set(message.params.pages ?? []);
        for (const resolve of heldWaiters) resolve();
        heldWaiters.clear();
        break;
      case "Kuvo.viewers":
        viewerCount = message.params.count ?? 0;
        break;
      case "Kuvo.activeChanged":
        active = message.params.targetId;
        break;
      case "Kuvo.passkeyAsked":
        if (message.params?.targetId) passkeyPages.set(message.params.targetId, message.params.host);
        break;
      case "Kuvo.passkeyCleared":
        passkeyPages.delete(message.params?.targetId);
        break;
      case "Target.detachedFromTarget":
        for (const [target, session] of sessions) if (session === message.params.sessionId) sessions.delete(target);
        fileRules.delete(message.params.sessionId);
        refusedFiles.delete(message.params.sessionId);
        break;
      case "Fetch.requestPaused":
        fileRequest(message);
        break;
      case "Page.javascriptDialogOpening":
        // In the page the tool at work is in, at once: the page (and the script that opened it)
        // waits on the answer. Any other page's waits for a tool there, or for you, as does one
        // you took over.
        if (busy && workingIn && sessions.get(workingIn) === message.sessionId && !held.has(workingIn)) answer(message.sessionId, message.params);
        else dialogs.set(message.sessionId, message.params);
        break;
      case "Kuvo.downloading":
        noteDownload(`The page started downloading ${message.params.name}.`, message.params.session);
        break;
      case "Kuvo.downloaded":
        noteDownload(`Downloaded ${message.params.name} to ${message.params.path}.`, message.params.session);
        break;
      case "Kuvo.downloadFailed":
        noteDownload(`Downloading ${message.params.name} failed.`, message.params.session);
        break;
      case "Page.fileChooserOpened":
        choosers.get(message.sessionId)?.(message.params);
        choosers.delete(message.sessionId);
        break;
      case "Page.javascriptDialogClosed":
        dialogs.delete(message.sessionId);
        break;
      case "Kuvo.answered":
        waiting.get(message.params.id)?.(message.params.answer ?? { type: "declined" });
        waiting.delete(message.params.id);
        break;
      case "Kuvo.closed":
        for (const resolve of waiting.values()) resolve({ type: "lost" });
        waiting.clear();
        break;
    }
  });
  await link.send("Target.setDiscoverTargets", { discover: true });
  active = (await link.send("Kuvo.getActive")).targetId ?? null;
  return link;
}

async function pages() {
  const { targetInfos } = await (await browser()).send("Target.getTargets");
  return targetInfos.filter((target) => target.type === "page");
}

/// The page in use: the one you or the agent last used, else the newest, else a new one. With
/// several conversations browsing, each keeps to its own page (unless you picked another since),
/// and one whose page in use is busy with another conversation gets a new one.
async function page() {
  const c = await browser();
  const open = await pages();
  const isOpen = (target) => open.some((info) => info.targetId === target);
  let target = null;
  if (caller) {
    const own = await c.send("Kuvo.mine", { session: caller });
    if (own.targetId && isOpen(own.targetId) && own.picked <= own.at) target = own.targetId;
  }
  // Its own page (or, with no conversation named, the one in use) you took over since: it waits.
  if (target ? held.has(target) : !caller && held.has(active)) throw new HeldError();
  // Any other page you took over isn't one to borrow: it gets a page of its own. Nor one on a file
  // it may not read (you opened it, say), which stays as it is.
  const fallback = open.find((info) => info.targetId === active)?.targetId ?? open.at(-1)?.targetId;
  target ??= fallback && !held.has(fallback) ? fallback : null;
  if (target && (await onOutsideFile(target, open))) {
    target = null;
    notes.push("The tab in use shows a file outside this conversation's folder, so this goes on in a new tab.");
  }
  if (target && caller && !(await c.send("Kuvo.claim", { targetId: target, session: caller })).ok) target = null;
  if (!target) {
    target = (await c.send("Target.createTarget", { url: "about:blank", newWindow: true })).targetId;
    if (caller) await c.send("Kuvo.claim", { targetId: target, session: caller });
  }
  return use(target);
}

async function use(target) {
  const c = await browser();
  // The pages a call works in, to check where they are when it's done.
  current?.pages?.add(target);
  let session = sessions.get(target);
  if (!session) {
    session = (await c.send("Target.attachToTarget", { targetId: target, flatten: true })).sessionId;
    sessions.set(target, session);
    await c.send("Page.enable", {}, session);
  }
  await guardFiles(session);
  // In front in its window: a site's new tab shares its opener's, and only the front one is drawn.
  await c.send("Target.activateTarget", { targetId: target }).catch(() => {});
  if (active !== target) {
    active = target;
    c.notify("Kuvo.setActive", { targetId: target, by: "agent", ...(caller ? { session: caller } : {}) });
  }
  // At work in this page: a Mac showing it says so.
  if (busy && workingIn !== target) {
    workingIn = target;
    c.notify("Kuvo.setStatus", { working: true, tool: currentTool, targetId: target, ...(caller ? { session: caller } : {}) });
  }
  // A dialog it left waiting, first, unless you took the page over.
  if (busy && dialogs.has(session) && !held.has(target)) answer(session, dialogs.get(session));
  return { target, session };
}

/// The agent's own world in the page: the browsing scripts run there, and the numbers they keep
/// stay there, where the page's own scripts can't read or change them. The same name gives the
/// same world (and a new document, a new one of it).
async function world(p) {
  const { frameTree } = await link.send("Page.getFrameTree", {}, p.session);
  return (await link.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "kuvo-agent" }, p.session)).executionContextId;
}

/// Runs `expression` in the page's own world, or with `inWorld` in the agent's.
async function evaluate(p, expression, timeout = 30_000, inWorld = false) {
  const contextId = inWorld ? await world(p) : undefined;
  const result = await link.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true, ...(contextId ? { contextId } : {}) }, p.session, timeout);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

// Each conversation's latest snapshot: the numbers its actions use are that snapshot's, and not
// another page's, or another conversation's in the same page.
const snapshots = new Map();

/// `args`, with the snapshot the calling conversation's numbers are from (none, if it hasn't read
/// a page yet).
function withSnapshot(args) {
  return caller ? { ...args, kuvoSnapshot: snapshots.get(caller) ?? "none" } : args;
}

/// Runs one of the browsing scripts (a function body) in the agent's world, with `args` as its
/// named arguments.
async function run(p, body, args = {}) {
  args = withSnapshot(args);
  const expression = `(async function({${Object.keys(args).join(", ")}}) {\n${body}\n})(${JSON.stringify(args)})`;
  try {
    const value = await evaluate(p, expression, 30_000, true);
    return typeof value === "string" ? value : "ok";
  } catch (error) {
    return "The page refused that: " + error.message;
  }
}

async function address(p) {
  try {
    return (await link.send("Target.getTargetInfo", { targetId: p.target })).targetInfo.url;
  } catch {
    return "";
  }
}

async function readyState(p) {
  try {
    return await evaluate(p, "document.readyState", 2000);
  } catch {
    return "loading";
  }
}

/// Waits for a navigation to start and finish, then a moment for the page to settle: until it has
/// loaded, or it's been readable for 2 s (a slow ad or tracker shouldn't hold it up), 10 s at most.
async function settle(p, expectNavigation) {
  if (expectNavigation) await sleep(250);
  const deadline = Date.now() + 10_000;
  let readable = null;
  while (Date.now() < deadline) {
    const state = await readyState(p);
    if (state === "complete") break;
    if (state === "interactive") {
      readable ??= Date.now();
      if (Date.now() - readable > 2000) break;
    } else {
      readable = null;
    }
    await sleep(150);
  }
  await sleep(expectNavigation ? 500 : 350);
}

/// A click may start a navigation a beat later, or open a page of its own: follow either.
async function settleAfterClick(p, before, pagesBefore) {
  const start = Date.now();
  while (Date.now() - start < 1000 && (await readyState(p)) !== "loading" && (await address(p)) === before) await sleep(100);
  // The page it opened (a sign-in window, say) is this conversation's to go on in: one this page
  // opened (Chrome names its opener, with noopener too), not one another conversation or you
  // opened meanwhile, nor one another conversation's agent has.
  const opened = (await pages()).find((info) => !pagesBefore.has(info.targetId) && info.openerId === p.target);
  const ours = opened && (!caller || (await (await browser()).send("Kuvo.claim", { targetId: opened.targetId, session: caller }).catch(() => ({ ok: false }))).ok);
  if (ours) {
    const next = await use(opened.targetId);
    await settle(next, true);
    return next;
  }
  await settle(p, (await readyState(p)) === "loading" || (await address(p)) !== before);
  return p;
}

const isEmpty = (url) => !url || url === "about:blank";

/// The page as text: title, address, scroll position, and its numbered elements.
async function snapshot(p) {
  p = p ?? (await page());
  if (isEmpty(await address(p))) return "The browser is empty. Use browser_navigate to open a page.";
  let result;
  try {
    // What the page set to run on a click, which only its own world sees, for the snapshot to
    // count those elements as clickable too.
    const handlers = await evaluate(p, `(function() {\n${CONFIG.scripts.handlers}\n})()`).catch(() => []);
    const id = crypto.randomUUID();
    const args = { kuvoSnapshot: id, kuvoHandlers: Array.isArray(handlers) ? handlers : [] };
    result = await evaluate(p, `(async function({kuvoSnapshot, kuvoHandlers}) {\n${CONFIG.scripts.snapshot}\n})(${JSON.stringify(args)})`, 30_000, true);
    // Its numbers are the ones this conversation's actions use, in this page only.
    if (result && caller) snapshots.set(caller, id);
  } catch {}
  if (!result) return `Couldn't read the page at ${await address(p)}.`;
  const text = result.text || "";
  const body = text.length > 18_000 ? text.slice(0, 18_000) + "\n… (cut; scroll or use browser_text for more)" : text;
  // (Its site asked: told while it's on that site.)
  const passkey = passkeyPages.has(p.target) && passkeyPages.get(p.target) === hostOf(result.url || "");
  if (passkeyPages.has(p.target) && !passkey) passkeyPages.delete(p.target);
  return [
    `Page: ${result.title || ""}`,
    `URL: ${result.url || ""}`,
    // Much more below: reading it all beats scrolling through it a screen at a time.
    `Scroll: ${result.above || 0} px above, ${result.below || 0} px below` + ((result.below || 0) > 1200 ? " (browser_text reads all of it at once)" : ""),
    ...(passkey ? [PASSKEY_NOTE] : []),
    "Interactive elements are numbered like [3]; use the number with browser_click, browser_type and browser_select.",
    "",
    body || "(no visible content)",
  ].join("\n");
}

/// What you type in an address bar: an address, or words to search for.
function destination(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (["http:", "https:", "file:", "about:"].includes(url.protocol)) return url.href;
  } catch {}
  // A file's path on this machine ("/home/me/report.html", "~/site/index.html"), as on the Mac.
  if (text.startsWith("/") || text.startsWith("~/")) return pathToFileURL(text.startsWith("~/") ? path.join(os.homedir(), text.slice(2)) : text).href;
  const looksLikeHost = !text.includes(" ") && (text.includes(".") || text.startsWith("localhost") || text.includes(":"));
  if (looksLikeHost) return (text.startsWith("localhost") || text.startsWith("127.") ? "http://" : "https://") + text;
  // The box's own search engine once it has one (`kuvo/browser/settings`), else the one its Mac named.
  const chosen = CONFIG.searchEngines.find((engine) => engine.id === readJSON(SETTINGS)?.searchEngine)?.url;
  const search = chosen || process.env.KUVO_SEARCH || "https://www.google.com/search?q=%s";
  return search.replace("%s", encodeURIComponent(text));
}

// The sites of the integrations added on this machine, which the agent reaches through their
// tools rather than the browser: opening one, it's told so instead, the first time (asked again
// a while after, it goes, for when the user asked for the website itself). From the Mac's
// Integrations.Site, which writes what it's told.
const integrationSites = (() => {
  try {
    return JSON.parse(process.env.KUVO_INTEGRATION_SITES || "[]");
  } catch {
    return [];
  }
})();
const sentAway = new Map();

function integrationNote(address, caller) {
  const trimmed = typeof address === "string" ? address.trim() : "";
  if (!trimmed || trimmed.includes(" ")) return null;
  let url;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : "https://" + trimmed);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  const site = integrationSites.find((site) => site.hosts.some((h) => host === h || host.endsWith("." + h)) && (!site.path || url.pathname.startsWith(site.path)));
  if (!site) return null;
  const key = (caller ?? "") + "\0" + site.id;
  const when = sentAway.get(key);
  if (when && Date.now() - when < 600_000) return null;
  sentAway.set(key, Date.now());
  return site.note;
}

// What a navigation that didn't open says first: the step failed (its line doesn't read "Opened").
const notOpened = (said) => said.startsWith("Couldn't open ") || said.startsWith("Not an address or search: ");

async function navigate(p, url) {
  const target = destination(url);
  if (!target) return `Not an address or search: ${url}`;
  const result = await link.send("Page.navigate", { url: target }, p.session);
  if (result.errorText && result.errorText !== "net::ERR_ABORTED") {
    await settle(p, false);
    return `Couldn't open ${target}: ${result.errorText}\n\n` + (await snapshot(p));
  }
  await settle(p, true);
  return snapshot(p);
}

async function history(p, step) {
  const { currentIndex, entries } = await link.send("Page.getNavigationHistory", {}, p.session);
  const entry = entries[currentIndex + step];
  if (!entry) return step < 0 ? "There's no page to go back to." : "There's no page to go forward to.";
  await link.send("Page.navigateToHistoryEntry", { entryId: entry.id }, p.session);
  await settle(p, true);
  return snapshot(p);
}

/// What's in view, as a PNG at most 1280 pixels wide.
async function screenshot(p) {
  // What the user filled in stays out of the picture.
  await run(p, CONFIG.scripts.mask);
  try {
    return await capture(p);
  } finally {
    await run(p, CONFIG.scripts.unmask);
  }
}

async function capture(p) {
  const { cssVisualViewport: view } = await link.send("Page.getLayoutMetrics", {}, p.session);
  const ratio = (await evaluate(p, "window.devicePixelRatio").catch(() => 1)) || 1;
  const scale = Math.min(1, 1280 / Math.max(view.clientWidth, 1));
  const { data } = await link.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale: scale / ratio },
  }, p.session);
  return data;
}

/// A dialog the page opened (an alert, a confirmation) holds the page up until it's answered: an
/// alert is accepted, anything else declined, as the panel's browser on the Mac does, and the
/// agent hears about it with the tool's result.
function answer(sessionId, dialog) {
  dialogs.delete(sessionId);
  const accept = dialog.type === "alert" || dialog.type === "beforeunload" || acceptDialogs;
  link?.send("Page.handleJavaScriptDialog", { accept, promptText: dialog.defaultPrompt || "" }, sessionId).catch(() => {});
  const what = dialog.type === "alert" ? "an alert" : dialog.type === "confirm" ? "a confirmation" : dialog.type === "prompt" ? "a question" : "a dialog";
  notes.push(`The page showed ${what}: “${dialog.message}” (${accept ? "accepted" : "declined"}).` + (accept ? "" : " If it should go ahead, do it again with accept_dialog: true."));
}

/// Shows the pointer in the views of the page where the agent's about to act, and gives it a
/// moment to get there.
async function point(p, index, action) {
  let rect = null;
  try {
    const value = await run(p, CONFIG.scripts.find + CONFIG.scripts.rect, { index });
    rect = value && value !== "ok" ? JSON.parse(value) : null;
  } catch {}
  if (!rect) return null;
  link?.notify("Kuvo.pointer", { targetId: p.target, action, rect });
  await sleep(150);
  return rect;
}

/// Asks the user, in Kuvo Code, and waits for the answer (15 minutes at most), out of the line.
/// With no Mac connected and no phone to answer it, it waits a few minutes for one (Kuvo Code
/// opening) rather than the whole while. Meanwhile its page stays this conversation's; the engine
/// giving up on the call closes the ask.
async function askUser(params) {
  if (current.cancelled) throw new Cancelled();
  const id = crypto.randomUUID();
  const session = caller;
  // On Autopilot nothing waits for the user: it's left undone at once.
  if (session && await onAutopilot(session)) return { type: "autopilot" };
  link.notify("Kuvo.ask", { id, ...params, ...(session ? { session } : {}) });
  const started = Date.now();
  let alone = viewerCount || phoneCanAnswer() ? null : started;
  let looking = false;
  return outOfLine((call) => new Promise((resolve) => {
    const finish = (answer) => {
      clearInterval(check);
      waiting.delete(id);
      call.stops.delete(stop);
      resolve(answer);
    };
    const stop = () => {
      link?.notify("Kuvo.cancelAsk", { id });
      finish({ type: "cancelled" });
    };
    waiting.set(id, finish);
    call.stops.add(stop);
    const check = setInterval(() => {
      if (viewerCount || phoneCanAnswer()) alone = null;
      else alone ??= Date.now();
      const nobody = alone !== null && Date.now() - alone > 180_000;
      if (nobody || Date.now() - started >= 900_000) {
        link?.notify("Kuvo.cancelAsk", { id });
        return finish({ type: nobody ? "nobody" : "timedOut" });
      }
      if (session && params.targetId) link?.notify("Kuvo.claim", { targetId: params.targetId, session });
      // Autopilot turned on meanwhile: this no longer waits for the user.
      if (session && !looking) {
        looking = true;
        onAutopilot(session).catch(() => false).then((on) => {
          looking = false;
          if (!on || !waiting.has(id)) return;
          link?.notify("Kuvo.cancelAsk", { id });
          finish({ type: "autopilot" });
        });
      }
    }, 5_000);
    if (call.cancelled) stop();
  }));
}

/// Whether a phone can answer: one is paired with this machine, and its phone link runs, which
/// tells it what's asked (`ASKSFILE`) and gives the browser its answer.
function phoneCanAnswer() {
  try {
    if (!fs.existsSync(path.join(RUN, "link.needed"))) return false;
    if (!(JSON.parse(fs.readFileSync(path.join(RUN, "link.json"), "utf8")).phones?.length > 0)) return false;
    const pid = Number(fs.readFileSync(path.join(RUN, "link.pid"), "utf8"));
    return pid > 0 && Boolean(commandLine(pid)?.includes("kuvo-link"));
  } catch {
    return false;
  }
}

/// Back in the page a call waited for you in (or for the vault, `meanwhile` says), as the page in
/// use: nil if it can go on there (it's open, not taken over, on `host`, and its `fields` are still
/// the kinds they were), else what changed meanwhile.
async function backTo(p, host, fields = [], meanwhile = "while the user answered") {
  if (!(await pages()).some((info) => info.targetId === p.target)) return `The page was closed ${meanwhile}.`;
  if (held.has(p.target)) return "The user took the page over and still has it.";
  Object.assign(p, await use(p.target));
  if (host && hostOf(await address(p)) !== host) return `The page left ${host} ${meanwhile}.`;
  for (const [index, wanted] of fields) {
    const problem = index === null ? null : await checkField(p, index, wanted);
    if (problem) return `The page changed ${meanwhile}: ` + problem;
  }
  return null;
}

/// The site a page is on, as the ask names it and Passwords keeps it: its host ("http://" and it,
/// for a page that isn't private, never the https site's), or for a page from a file, that it
/// is one.
function hostOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return "a file on this machine";
    if (parsed.protocol === "http:") return parsed.hostname ? "http://" + parsed.hostname : null;
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

/// The site the fill script checks the page is still on. It names a page from a file as one on
/// the Mac, wherever it runs.
const siteOf = (host) => (host === "a file on this machine" ? "a file on this Mac" : host);

/// Where a conversation may open files without asking: anywhere under Approve All, else its
/// folder and the temporary ones (where an agent writes a page to open). A subagent's goes by the
/// conversation that started it. Unknown, it asks. As the Mac's BrowserTools.
async function fileAccess(session) {
  let found = null;
  for (let id = session, step = 0; id && step < 6; step++) {
    found = (await findSession(id))?.data ?? null;
    id = found?.parentID ?? null;
  }
  // Ask First asks before commands; a group chat's seat refuses them all. (Approve All keeps
  // Settings' refusals, of some commands.)
  const rules = found?.permissions ?? [];
  const asks = rules.some((rule) => rule.action === "shell" && (rule.effect === "ask" || (rule.effect === "deny" && rule.resource === "*")));
  if (found && !asks) return { anywhere: true, places: [] };
  return { anywhere: false, places: [found?.location?.directory, os.tmpdir(), "/tmp"].filter(Boolean).map(realPath) };
}

function realPath(place) {
  try {
    return fs.realpathSync(place);
  } catch {
    return path.resolve(place);
  }
}

/// Where a file that may not be there yet would be: its nearest folder that is, with links
/// followed, and the rest of its path.
function realTarget(file) {
  let folder = file;
  const rest = [];
  while (!fs.existsSync(folder) && path.dirname(folder) !== folder) {
    rest.unshift(path.basename(folder));
    folder = path.dirname(folder);
  }
  return path.join(realPath(folder), ...rest);
}

/// The file `address` (a whole URL) is, when it's one outside `access`'s places, links followed
/// to where they lead; else null. One it can't tell (a host in it, say, which Chrome ignores)
/// counts as outside.
function outsideFile(address, access) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "file:" || access.anywhere) return null;
  let file;
  try {
    file = fileURLToPath(url);
  } catch {
    return url.pathname || address;
  }
  const where = realPath(file);
  return access.places.some((place) => where === place || where.startsWith(place.endsWith("/") ? place : place + "/")) ? null : file;
}

const outsideNote = (file) =>
  `Not opened: ${file} is outside this conversation's folder, and this session asks before reading files elsewhere. Ask the user first; if they agree, copy it into the folder (a command, which asks them) and open it there.`;

/// What the browser says instead of opening `address`, a file outside where the conversation may
/// read files without asking: opened, the browser read it without asking, where a command would
/// have asked.
async function fileNote(address, session) {
  const target = destination(address);
  if (!target || !target.startsWith("file:")) return null;
  const file = outsideFile(target, await fileAccess(session));
  return file ? outsideNote(file) : null;
}

/// What a page has from files outside where `session` may read files: `{ file, main }`, `main`
/// when it's the page itself, else a frame, a picture or a script in it; nil if nothing. Its
/// frames first, and only with a file among them its resources (only a page from a file can load
/// files); neither while it shows a dialog, which holds the page. Unknown, it goes by the page's
/// address. `access` is looked up once, when a page has a file in it.
async function pageFile(p, session, access) {
  if (access.value?.anywhere) return null;
  const tree = async (method) => {
    if (dialogs.has(p.session)) return null;
    return (await link.send(method, {}, p.session, 3_000).catch(() => null))?.frameTree ?? null;
  };
  const frames = await tree("Page.getFrameTree");
  const main = frames?.frame?.url ?? (await address(p));
  const addresses = [main];
  // A frame from a file, or one with a file's origin (a blank page or blob a file page opened).
  let fromFile = false;
  (function collect(node) {
    if (node?.frame?.url) addresses.push(node.frame.url);
    if (String(node?.frame?.securityOrigin ?? "").startsWith("file:")) fromFile = true;
    for (const child of node?.childFrames ?? []) collect(child);
  })(frames);
  if (!fromFile && !addresses.some((each) => each.startsWith("file:"))) return null;
  const resources = await tree("Page.getResourceTree");
  (function collect(node) {
    // What it has, not what it was refused.
    for (const resource of node?.resources ?? []) if (!resource.failed && !resource.canceled) addresses.push(resource.url);
    for (const child of node?.childFrames ?? []) collect(child);
  })(resources);
  access.value ??= await fileAccess(session);
  const itself = outsideFile(main, access.value);
  if (itself) return { file: itself, main: true };
  const file = addresses.map((each) => outsideFile(each, access.value)).find(Boolean);
  return file ? { file, main: false } : null;
}

/// What a page may load from files while a step works in it, by its session here: what the
/// step's conversation may read (see `fileAccess`). Its loads of files are paused, and those
/// outside that refused, as the page itself, a frame, a picture or a script; a page you took over
/// loads anything. Only during the step: between steps (you browsing, another conversation's
/// step) a page loads as it would, and the next step looks at what it has (`readyPage`).
const fileRules = new Map();
/// The files refused in each page during the step (by its session), for it to say so.
const refusedFiles = new Map();

async function guardFiles(session) {
  if (!current || fileRules.has(session)) return;
  current.access ??= await fileAccess(current.session);
  // Approve All: nothing to refuse.
  if (current.access.anywhere) return;
  fileRules.set(session, current.access);
  await link.send("Fetch.enable", { patterns: [{ urlPattern: "file://*" }] }, session).catch(() => {});
}

/// The step is over, or waits for you: its pages load anything again.
function unguardFiles() {
  for (const session of fileRules.keys()) link?.send("Fetch.disable", {}, session).catch(() => {});
  fileRules.clear();
  refusedFiles.clear();
}

function fileRequest(message) {
  const { requestId, request } = message.params;
  const access = fileRules.get(message.sessionId);
  const target = [...sessions].find(([, session]) => session === message.sessionId)?.[0];
  const file = access && !held.has(target) ? outsideFile(request.url, access) : null;
  if (file) {
    const refused = refusedFiles.get(message.sessionId) ?? new Set();
    if (refused.size < 20) refused.add(file);
    refusedFiles.set(message.sessionId, refused);
    link.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, message.sessionId).catch(() => {});
  } else {
    link.send("Fetch.continueRequest", { requestId }, message.sessionId).catch(() => {});
  }
}

/// Whether `target` is on a file the conversation at work may not read (one you opened, say),
/// from what `open` says of it (a page whose load of one was refused shows an error, not it).
async function onOutsideFile(target, open) {
  const url = open.find((info) => info.targetId === target)?.url ?? "";
  if (!url.startsWith("file:") || !current) return false;
  current.access ??= await fileAccess(current.session);
  if (!outsideFile(url, current.access)) return false;
  const session = sessions.get(target);
  if (!session || dialogs.has(session)) return true;
  const tree = await link.send("Page.getFrameTree", {}, session, 3_000).catch(() => null);
  return !tree || Boolean(outsideFile(tree.frameTree?.frame?.url ?? url, current.access));
}

/// The page a step goes on in: `p`, loaded again without them if it shows pictures or frames from
/// files outside the conversation's folder (from before, as its loads are only refused during a
/// step); a new tab if it's on such a file itself, which stays as it is.
async function readyPage(p, leaving = false) {
  const found = await pageFile(p, caller, { value: current?.access });
  if (!found) return p;
  if (found.main) {
    current?.pages?.delete(p.target);
    const c = await browser();
    const { targetId } = await c.send("Target.createTarget", { url: "about:blank", newWindow: true });
    if (caller) await c.send("Kuvo.claim", { targetId, session: caller });
    notes.push("The tab in use shows a file outside this conversation's folder, so this goes on in a new tab.");
    return use(targetId);
  }
  // A step that leaves the page anyway needs it as it is.
  if (leaving) return p;
  await link.send("Page.reload", {}, p.session).catch(() => {});
  await settle(p, true);
  refusedFiles.delete(p.session);
  notes.push("The page had files from outside this conversation's folder in it, so it was loaded again without them (anything typed in it is gone).");
  return p;
}

/// Nil if the field is there and takes `wanted` ("password" or "text"), else why not.
async function checkField(p, index, wanted) {
  const kind = await run(p, CONFIG.scripts.find + CONFIG.scripts.fieldKind, { index });
  if (kind === "missing") return `There's no element [${index}] on the page now. Take a fresh browser_snapshot.`;
  if (wanted === "password" && kind !== "password") return `[${index}] isn't a password field: a password only goes into one.`;
  if (wanted === "text" && kind !== "text") return `[${index}] isn't a field for a username or email.`;
  if (wanted === "code" && kind !== "text" && kind !== "password") return `[${index}] isn't a field to type a code into.`;
  return null;
}

// What's told of an ask left undone on Autopilot (LEFT_UNDONE_WORDS on the box).
const LEFT_UNDONE = "This is on Autopilot: nothing was put to the user, and nothing was chosen for you. If only the user can do it, don't do it or ask again: leave that step undone, keep it as waiting if you're at a goal (goal_progress), carry on with everything else, and list what's left for them in your final reply.";

const noAnswer = (answer, what) =>
  answer.type === "autopilot" ? LEFT_UNDONE
    : answer.type === "nobody" ? "No one has Kuvo Code open to answer now. Carry on with what you can without it, and say in your reply what you need; if you work on your own (a bot), schedule a wake-up to try again later."
    : answer.type === "timedOut" ? "The user didn't answer in time. Carry on with what you can without it, and say in your reply what you need; if you work on your own (a bot), schedule a wake-up to try again later."
    : answer.type === "lost" ? "The connection to the browser closed while the user was answering. Try again."
    : `The user didn't ${what}. Ask them in the chat how to go on.`;

const text = (value, isError = false) => ({ content: [{ type: "text", text: value }], isError });

// The tools answered by this machine's box: agents writing to each other and running their
// sessions, a conversation's wake-ups, a bot's job, and the checks before showing a file or a widget
// (which Kuvo Code then shows from the call).
const MAIL_TOOLS = new Set(["list_agents", "send_message", "read_conversation", "start_session", "list_sessions", "stop_session", "compact_session", "answer_ask", "list_models", "make_project", "list_projects", "propose_goal", "goal_progress", "may_spend", "finish_goal", "notify_user", "plan_limits", "use_limit_reset",
  "schedule_wake_up", "watch_for_change", "list_wake_ups", "cancel_wake_up", "set_job", "show_in_panel", "show_file", "mark_final", "show_widget"]);
// Those that change what's kept, which the call stopping doesn't cut off.
const KEPT_WHOLE = new Set(["schedule_wake_up", "watch_for_change", "cancel_wake_up", "set_job"]);
// Kuvo Code's own tools (agents writing to each other, wake-ups, a bot's job, showing things): this
// machine's box answers them, as every box does (`POST kuvo/agent-tools`), so they're the same on all
// your computers. A call that waits for an answer holds up to eleven minutes; stopped, the
// box stops waiting, and an answer that comes later reaches the conversation as a message.
async function mail(name, args, from, cancelled = () => false) {
  const answer = await boxRoute({ method: "POST", path: "kuvo/agent-tools", body: { name, arguments: args, session: from } }, { timeout: 720_000, cancelled });
  let said = null;
  try {
    said = JSON.parse(answer?.body || "null");
  } catch {}
  if (answer?.status === 200 && typeof said?.text === "string") return text(said.text, said.isError === true);
  return text(said?.message || "Kuvo Code on this machine didn't answer. Try again in a moment.", true);
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/// The machine's engine, or (`place` "bridge") the agents bridge beside it, whose sessions are
/// the coding agents' (Claude Code, Codex…): the same paths answer on both.
async function engine(method, pathname, body, place = "engine") {
  const record = readJSON(path.join(K, "run", place === "bridge" ? "bridge.json" : "engine.json"));
  if (!record) throw new ToolError(place === "bridge" ? "The coding agents aren't running on this machine." : "This machine's engine isn't running.");
  const response = await fetch(`http://127.0.0.1:${record.port}/${pathname}`, {
    method,
    headers: { Authorization: "Basic " + Buffer.from("opencode:" + record.password).toString("base64"), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new ToolError(`This machine's engine said ${response.status}.`);
  const answer = await response.text();
  return answer ? JSON.parse(answer) : null;
}

/// A session on this machine, where it runs: the engine's, or the agents bridge's. Null when
/// neither has it.
const places = new Map();
async function findSession(id) {
  const known = places.get(id);
  for (const place of known ? [known] : ["engine", "bridge"]) {
    const data = (await engine("GET", `api/session/${encodeURIComponent(id)}`, undefined, place).catch(() => null))?.data;
    if (!data) continue;
    places.set(id, place);
    return { place, data };
  }
  return null;
}

/// Whether the conversation `id` is part of (a subagent's, the one that started it) is on Autopilot.
async function onAutopilot(id) {
  let found = await findSession(id);
  // (Through a coding agent's engine run, Auto's, to the conversation it runs for.)
  const above = (data) => data?.parentID ?? data?.metadata?.kuvo?.engineFor;
  for (let step = 0; above(found?.data) && step < 5; step++) found = await findSession(above(found.data));
  return found?.data?.metadata?.kuvo?.autopilot === true;
}

/// A route of this machine's box, answered once: `{status, body}`, or null when its script didn't
/// answer (in `timeout` ms). Its call `cancelled`, it's told to stop (and answers at once): told
/// again and again (a route that doesn't stop is ended), or with `once`, told once, for a route that
/// sees what it began through for others (opening the app) and then ends by itself.
function boxRoute(request, { timeout = 30_000, cancelled = () => false, once = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...OWN_RUNTIME, path.join(K, "bin", "kuvo-link.js"), "box", "route"], {
      cwd: K,
      env: { ...process.env, KUVO_HOME: K, BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    const stop = setTimeout(() => child.kill("SIGTERM"), timeout);
    let told = false;
    const watch = setInterval(() => {
      if (!cancelled() || (once && told)) return;
      told = true;
      child.kill("SIGTERM");
    }, 500);
    child.on("error", () => {
      clearTimeout(stop);
      clearInterval(watch);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(stop);
      clearInterval(watch);
      try {
        const answer = JSON.parse(output.trim().split("\n").pop() || "null");
        resolve(answer && typeof answer.status === "number" ? answer : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// A Mac's own box in a home of its own (#333: `box/kind` says `mac`): its agents browse in its app's
// panel, as they do with the app's box in its folder, with no Chromium of its own. Each browser call
// goes to the app's tools while the app is registered (`run/app.json`, PROTOCOL.md, "This Mac's
// app"); while it isn't, the box opens it (`kuvo/box/app/open`, which decides, and waits for it with
// every call meanwhile), and the call goes on once it's there.
const MAC_BOX = (() => {
  try {
    return fs.readFileSync(path.join(K, "box", "kind"), "utf8").trim() === "mac";
  } catch {
    return false;
  }
})();

/// Where the app's tools answer, as it registered: `{url, token}`, or null while it isn't open.
function registeredApp() {
  const tools = readJSON(path.join(RUN, "app.json"))?.tools;
  return tools && typeof tools.url === "string" && typeof tools.token === "string" ? tools : null;
}

// Each process its own client to the app (its calls' ids are its own there, for a cancel to name).
const APP_CLIENT = crypto.randomUUID();

/// One browser call, to the app's tools: its result, or `{gone: true}` when the app doesn't answer
/// there (it quit without saying: nothing there, or something else). Stopped, the app's told.
async function appCall(tools, call) {
  const id = crypto.randomUUID();
  const send = (message, signal) =>
    fetch(tools.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tools.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": APP_CLIENT,
        ...(call.session ? { "x-kuvo-session": call.session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
      signal,
    });
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
    send({ method: "notifications/cancelled", params: { requestId: id } }, AbortSignal.timeout(5_000)).catch(() => {});
  };
  call.stops.add(stop);
  try {
    const response = await send({ id, method: "tools/call", params: { name: call.name, arguments: call.args, ...(call.meta ? { _meta: call.meta } : {}) } }, abort.signal);
    const answer = await response.json().catch(() => null);
    // Something else answering there (the app quit, and another took its port; or one that refuses
    // its token): taken for the app gone, so it's opened again, never asked of again.
    if (answer?.jsonrpc !== "2.0" || answer.id !== id) return { gone: true };
    if (answer.result) return answer.result;
    return text(answer.error?.message ? `Kuvo Code's browser said: ${answer.error.message}` : `Kuvo Code's browser said ${response.status}.`, true);
  } catch (error) {
    if (call.cancelled) return text("The call was stopped.", true);
    const code = error?.cause?.code ?? error?.code;
    if (code === "ECONNREFUSED" || code === "ConnectionRefused") return { gone: true };
    return text(`The call didn't finish: ${error?.message || error}`, true);
  } finally {
    call.stops.delete(stop);
  }
}

/// A browser call on a Mac's own box: to the app, opened first if it isn't open (once more if the
/// app registered had gone without saying).
async function appBrowser(call, reply) {
  let gone = null;
  for (let tries = 0; tries < 2; tries++) {
    let tools = gone ? null : registeredApp();
    if (!tools) {
      const answer = await boxRoute({ method: "POST", path: "kuvo/box/app/open", body: gone ? { gone } : {} }, { timeout: 120_000, cancelled: () => call.cancelled, once: true });
      if (call.cancelled) return reply(text("The call was stopped.", true));
      if (answer?.status !== 200) {
        let said = null;
        try {
          said = JSON.parse(answer?.body || "null");
        } catch {}
        return reply(text(said?.message || "Kuvo Code on this Mac didn't answer. Try again in a moment.", true));
      }
      tools = registeredApp();
      if (!tools) break;
    }
    const result = await appCall(tools, call);
    if (!result?.gone) return reply(result);
    gone = tools.token;
  }
  reply(text("Kuvo Code on this Mac didn't take the browser's call. Ask the user to open Kuvo Code, then try again.", true));
}

/// One of the vault's or the sandbox's routes on this machine's box (PROTOCOL.md, "Vault",
/// "Sandbox"): `{status, value}`, or
/// null when its script didn't answer. Its process stops with the tool call, and waits as long as
/// the box may (one that asks you waits for you).
function vaultRoute(request, call, timeout = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...OWN_RUNTIME, path.join(K, "bin", "kuvo-link.js"), "box", "route"], {
      cwd: K,
      env: { ...process.env, KUVO_HOME: K, BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    const stopNow = () => child.kill("SIGTERM");
    call?.stops.add(stopNow);
    child.stdout.on("data", (chunk) => (output += chunk));
    const stop = setTimeout(stopNow, timeout);
    const done = (answer) => {
      clearTimeout(stop);
      call?.stops.delete(stopNow);
      resolve(answer);
    };
    child.on("error", () => done(null));
    child.on("close", () => {
      try {
        const answer = JSON.parse(output.trim().split("\n").pop() || "null");
        if (!answer || typeof answer.status !== "number") return done(null);
        let value = {};
        try { value = JSON.parse(answer.body || "{}"); } catch {}
        done({ status: answer.status, value });
      } catch {
        done(null);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/// The vault's tools, as this machine's box lists them: kept once it's said.
let vaultToolList = null;
/// The browser's tools while this machine's vault isn't open to agents: no browser_fill, and no
/// vault item to name in browser_sign_in.
function closedVaultTools(tools) {
  return tools.filter((tool) => tool.name !== "browser_fill").map((tool) => {
    if (tool.name !== "browser_sign_in") return tool;
    const { item, ...properties } = tool.inputSchema?.properties ?? {};
    return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
  });
}

async function vaultTools() {
  if (vaultToolList) return vaultToolList;
  const answer = await vaultRoute({ method: "GET", path: "kuvo/vault/tools" }, null, 15_000);
  if (answer?.status === 200 && Array.isArray(answer.value?.tools)) vaultToolList = answer.value.tools;
  return vaultToolList ?? [];
}

/// The Work Queue's tools (`queue_…`), and what agents are told of them, as this machine's box
/// gives them (PROTOCOL.md, "The Work Queue"): kept once it's said.
let workQueueList = null;
async function workQueueTools() {
  if (workQueueList) return workQueueList;
  const answer = await vaultRoute({ method: "GET", path: "kuvo/work-queue/tools" }, null, 15_000);
  if (answer?.status === 200 && Array.isArray(answer.value?.tools)) workQueueList = { tools: answer.value.tools, instructions: typeof answer.value.instructions === "string" ? answer.value.instructions : "" };
  return workQueueList ?? { tools: [], instructions: "" };
}

/// The sandbox's way out (`sandbox_ask`), as this machine's box lists it while its commands run in
/// the sandbox: kept once it's listed, asked again while it isn't.
let sandboxToolList = null;
async function sandboxTools() {
  if (sandboxToolList) return sandboxToolList;
  const answer = await vaultRoute({ method: "GET", path: "kuvo/sandbox/tools" }, null, 15_000);
  if (answer?.status === 200 && Array.isArray(answer.value?.tools) && answer.value.tools.length) sandboxToolList = answer.value.tools;
  return sandboxToolList ?? [];
}

/// What the vault fills on the page `p` (at `origin`) for this conversation: `{status, value}` (200
/// with `values`; 403 refused, 404 nothing yours, 423 locked), or null without a vault to ask. The
/// box may ask you first (an item its grant says to ask about), so this waits out of the line, as
/// an ask does, with `p` staying this conversation's meanwhile: back in line, the page may have
/// changed (`backTo`).
function vaultFill(p, body) {
  if (current.cancelled) throw new Cancelled();
  const session = caller;
  const request = { method: "POST", path: "kuvo/vault/fill", body: { session, ...body } };
  return outOfLine(async (call) => {
    const keep = session ? setInterval(() => link?.notify("Kuvo.claim", { targetId: p.target, session }), 5_000) : null;
    try {
      return await vaultRoute(request, call, 16 * 60_000);
    } finally {
      clearInterval(keep);
    }
  });
}

/// While you have the page a conversation works in, its tool call waits, up to ten minutes,
/// before it joins the others (so it holds up no one else's); nil when the page is free, else the
/// page and whether you still have it. The engine giving up on the call ends the wait.
async function waitForControl(call) {
  // A new tab is a page of its own.
  if (!held.size || call.name === "browser_new_tab") return null;
  const c = await browser();
  // The conversation's own page, as page() picks it; one with none yet gets one of its own,
  // never one you took over.
  let target = active;
  if (call.session) {
    const own = await c.send("Kuvo.mine", { session: call.session });
    target = own.targetId && own.picked <= own.at ? own.targetId : null;
  }
  if (!target || !held.has(target) || !(await pages()).some((info) => info.targetId === target)) return null;
  const started = Date.now();
  while (held.has(target) && !call.cancelled && Date.now() - started < 600_000) {
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        heldWaiters.delete(done);
        call.stops.delete(done);
        resolve();
      };
      const timer = setTimeout(done, 5_000);
      heldWaiters.add(done);
      call.stops.add(done);
    });
  }
  return { target, stillHeld: held.has(target) };
}

/// What a tool says instead of its step, after waiting for you.
async function afterControl(wait) {
  if (wait.stillHeld) return text("The user took over the browser and still has it. Carry on without it for now, or try again later; if you work on your own (a bot), schedule a wake-up to come back to it.");
  // A page closed meanwhile: it goes on in another.
  const open = (await pages()).some((info) => info.targetId === wait.target);
  const p = await readyPage(open ? await use(wait.target) : await page());
  const moved = heard();
  return text("The user took over the browser while you worked, and has handed it back. The page may have changed: this is where it is now. Go on from here.\n\n" + moved + (await snapshot(p)));
}

/// A browser tool call, in its turn in the line, once you've handed back its page if you have
/// it. One the engine gives up on stops waiting, or never runs, and nothing answers it.
async function perform(call, reply) {
  for (;;) {
    const wait = await waitForControl(call).catch(() => null);
    if (call.cancelled) return;
    await takeTurn(call);
    try {
      if (call.cancelled) return;
      await browser();
      const result = wait ? await afterControl(wait) : await tool(call.name, call.args);
      // A page it worked in that's on a file it may not read (one handed back to it, say): its
      // result is kept back, and the page goes blank unless you have it.
      const access = { value: call.access };
      const open = new Set((await pages()).map((info) => info.targetId));
      const refused = [];
      for (const target of call.pages) {
        if (!open.has(target) || !sessions.has(target)) continue;
        const session = sessions.get(target);
        refused.push(...(refusedFiles.get(session) ?? []));
        refusedFiles.delete(session);
        const found = await pageFile({ target, session }, call.session, access);
        if (!found) continue;
        if (held.has(target)) return reply(text("The page shows a file outside this conversation's folder, so this step's result was held back.", true));
        if (!found.main) {
          await link.send("Page.reload", {}, session).catch(() => {});
          await settle({ target, session }, true);
          return reply(text("The page had files from outside this conversation's folder in it, which this session asks about before reading, so it was loaded again without them and this step's result was held back. Take the step again.", true));
        }
        await link.send("Page.navigate", { url: "about:blank" }, session).catch(() => {});
        return reply(text("The page went to a file outside this conversation's folder, which this session asks about before reading, so it's blank now and this step's result was held back.", true));
      }
      // Files the page tried to load from outside the folder, which weren't.
      if (refused.length) {
        const files = [...new Set(refused)];
        const note = `Not loaded: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}, outside this conversation's folder; this session asks before reading files elsewhere.`;
        return reply({ ...result, content: [{ type: "text", text: note }, ...(result.content ?? [])] });
      }
      return reply(result);
    } catch (error) {
      if (error instanceof Cancelled) return;
      // Its page, taken over while it waited in line: it waits again, out of the line.
      if (!(error instanceof HeldError)) return reply(text(error instanceof ToolError ? error.message : "The browser ran into a problem: " + error.message, true));
    } finally {
      endTurn(call);
    }
  }
}

async function tool(name, args) {
  const integer = (key) => (Number.isFinite(Number(args[key])) && args[key] !== "" && args[key] !== null ? Math.trunc(Number(args[key])) : null);
  const string = (key) => (typeof args[key] === "string" ? args[key] : null);
  const scripts = CONFIG.scripts;

  if (name === "browser_upload") {
    const index = integer("index");
    const files = Array.isArray(args.files) ? args.files.filter((f) => typeof f === "string" && f) : [];
    if (index === null || !files.length) throw new ToolError("Missing index or files.");
    const paths = files.map((f) => path.resolve(f.replace(/^~(?=$|\/)/, os.homedir())));
    const unreadable = paths.find((f) => {
      try {
        return !fs.statSync(f).isFile();
      } catch {
        return true;
      }
    });
    if (unreadable) return text(`Can't read ${unreadable} on this machine. Give its full path.`);
    // Attached, a file goes to the site: one outside the conversation's folder only as a command
    // could read it, after asking (as on the Mac).
    const access = await fileAccess(caller);
    const outside = paths.find((f) => outsideFile(pathToFileURL(f).href, access));
    if (outside) return text(`Not attached: ${outside} is outside this conversation's folder, and this session asks before reading files elsewhere. Ask the user first; if they agree, copy it into the folder (a command, which asks them) and attach it from there.`, true);
    const p = await page();
    // The file input the element stands for, as an object to hand the files to.
    const found = await link.send("Runtime.evaluate", {
      expression: `(function({index, kuvoSnapshot}) {\n${scripts.find}\n${scripts.fileInput}\n})(${JSON.stringify(withSnapshot({ index }))})`,
      returnByValue: false,
      contextId: await world(p),
    }, p.session);
    const value = found.result;
    if (value?.type === "string" && value.value === "missing") return text(`There's no element [${index}] on the page now. Take a fresh browser_snapshot.`);
    if (value?.objectId) {
      await link.send("DOM.setFileInputFiles", { files: paths, objectId: value.objectId }, p.session);
    } else {
      // A button that opens the file picker itself: click it, and answer the picker.
      await link.send("Page.setInterceptFileChooserDialog", { enabled: true }, p.session);
      try {
        const opened = new Promise((resolve) => {
          choosers.set(p.session, resolve);
          setTimeout(() => resolve(null), 4000);
        });
        await run(p, scripts.find + scripts.click, { index });
        const chooser = await opened;
        if (!chooser) return text(`[${index}] didn't open a file picker. Give the number of the upload button or its file input.`);
        await link.send("DOM.setFileInputFiles", { files: paths, backendNodeId: chooser.backendNodeId }, p.session);
      } finally {
        choosers.delete(p.session);
        await link.send("Page.setInterceptFileChooserDialog", { enabled: false }, p.session).catch(() => {});
      }
    }
    await sleep(400);
    return text(`Attached ${paths.length === 1 ? "the file" : `${paths.length} files`}.\n\n` + (await snapshot(p)));
  }

  if (name === "browser_tabs") {
    const c = await browser();
    const open = await pages();
    // The page this conversation works in, else the browser's page in use.
    const own = caller ? (await c.send("Kuvo.mine", { session: caller })).targetId : null;
    const inUse = own && open.some((t) => t.targetId === own) ? own : active;
    // A tab on a file the conversation may not read shows as one, without its name.
    const access = open.some((t) => t.url.startsWith("file:")) && current ? (current.access ??= await fileAccess(caller)) : null;
    const describe = (t) =>
      isEmpty(t.url) ? "New tab — empty" : access && outsideFile(t.url, access) ? "A file outside this conversation's folder" : `${t.title || "(untitled)"} — ${t.url}`;
    const list = (targets) =>
      targets.length
        ? "Tabs:\n" + targets.map((t, i) => `[${i + 1}] ${describe(t)}${t.targetId === inUse ? " (in use)" : ""}`).join("\n")
        : "No tabs are open.";
    const action = string("action") || "list";
    if (action === "list") return text(list(open));
    const number = integer("tab");
    const chosen = number === null ? null : open[number - 1];
    if (!chosen) return text(`There's no tab [${number ?? 0}]. ` + list(open));
    if (held.has(chosen.targetId)) return text(`The user took tab [${number}] over and has it now. Pick another, or carry on without it.`);
    if (access && outsideFile(chosen.url, access)) return text(`Tab [${number}] shows a file outside this conversation's folder, which this session asks about before reading. Pick another, or open one with browser_new_tab.`);
    // Another conversation's agent is at work there: not this one's to take or close.
    if (caller && !(await c.send("Kuvo.claim", { targetId: chosen.targetId, session: caller })).ok) {
      return text(`Another conversation's agent is using tab [${number}]. Pick another, or open one with browser_new_tab.`);
    }
    if (action === "close") {
      await c.send("Target.closeTarget", { targetId: chosen.targetId });
      sessions.delete(chosen.targetId);
      if (active === chosen.targetId) active = null;
      return text(`Closed tab [${number}]. ` + list((await pages())));
    }
    const chosenPage = await readyPage(await use(chosen.targetId));
    const said = heard();
    return text(said + (await snapshot(chosenPage)));
  }

  if (name === "browser_navigate" || name === "browser_new_tab") {
    const url = string("url");
    const refused = url ? await fileNote(url, caller) : null;
    if (refused) return text(refused, true);
  }

  if (name === "browser_new_tab") {
    const url = string("url");
    const c = await browser();
    const { targetId } = await c.send("Target.createTarget", { url: "about:blank", newWindow: true });
    if (caller) await c.send("Kuvo.claim", { targetId, session: caller });
    const p = await use(targetId);
    const said = url ? await navigate(p, url) : await snapshot(p);
    return text(said, notOpened(said));
  }

  let p = await readyPage(await page(), ["browser_navigate", "browser_back", "browser_forward"].includes(name));
  const note = heard;
  const withNote = async (promise) => {
    const result = await promise;
    return text(note() + result);
  };

  switch (name) {
    case "browser_navigate": {
      const url = string("url");
      if (!url) return text("Missing url.", true);
      const said = await navigate(p, url);
      return text(note() + said, notOpened(said));
    }
    case "browser_snapshot":
      return withNote(snapshot(p));
    case "browser_click": {
      const index = integer("index");
      if (index === null) return text("Missing index.", true);
      await point(p, index, "click");
      const before = await address(p);
      const pagesBefore = new Set((await pages()).map((info) => info.targetId));
      const outcome = await run(p, scripts.find + scripts.click, { index });
      if (outcome !== "ok") return text(note() + outcome);
      p = await settleAfterClick(p, before, pagesBefore);
      return withNote(snapshot(p).then((page) => `Clicked [${index}].\n\n` + page));
    }
    case "browser_type": {
      const index = integer("index");
      const value = string("text");
      if (index === null || value === null) return text("Missing index or text.", true);
      const submit = args.submit === true;
      await point(p, index, "type");
      const outcome = await run(p, scripts.find + scripts.type, { index, text: value, submit, clear: args.clear !== false });
      if (outcome !== "ok") return text(note() + outcome);
      await settle(p, submit);
      return withNote(snapshot(p).then((page) => `Typed into [${index}]${submit ? " and submitted" : ""}.\n\n` + page));
    }
    case "browser_select": {
      const index = integer("index");
      const option = string("option");
      if (index === null || option === null) return text("Missing index or option.", true);
      await point(p, index, "select");
      const outcome = await run(p, scripts.find + scripts.select, { index, option });
      if (outcome !== "ok") return text(note() + outcome);
      await settle(p, false);
      return withNote(snapshot(p).then((page) => `Selected “${option}” in [${index}].\n\n` + page));
    }
    case "browser_scroll": {
      const pages = Number(args.pages) || 1;
      await run(p, "window.scrollBy({top: (down ? 1 : -1) * window.innerHeight * 0.85 * pages, behavior: 'instant'}); return 'ok';", { down: string("direction") !== "up", pages });
      await sleep(300);
      return withNote(snapshot(p));
    }
    case "browser_press": {
      const key = string("key");
      if (!key) return text("Missing key.", true);
      const outcome = await run(p, scripts.press, { key });
      if (outcome !== "ok") return text(note() + outcome);
      await settle(p, key === "Enter");
      return withNote(snapshot(p).then((page) => `Pressed ${key}.\n\n` + page));
    }
    case "browser_back":
      return withNote(history(p, -1));
    case "browser_forward":
      return withNote(history(p, 1));
    case "browser_text": {
      let value = "";
      try {
        value = (await evaluate(p, "document.body ? document.body.innerText : ''")) || "";
      } catch {}
      return withNote(Promise.resolve(value.length > 30_000 ? value.slice(0, 30_000) + "\n… (cut)" : value || "(no text)"));
    }
    case "browser_save_pdf": {
      const given = string("path");
      const file = given && path.resolve(given.replace(/^~(?=$|\/)/, os.homedir()));
      if (!given || !/^~?\//.test(given) || !file.toLowerCase().endsWith(".pdf")) return text("Give a full path ending in .pdf.", true);
      // Saved outside the conversation's folder, it would replace what's there without asking,
      // where a command would have asked (as on the Mac).
      if (outsideFile(pathToFileURL(realTarget(file)).href, await fileAccess(caller))) {
        return text(`Not saved: ${file} is outside this conversation's folder, and this session asks before writing files elsewhere. Save it in the folder; if the user wants it elsewhere, ask them first, then move it there (a command, which asks them).`, true);
      }
      if (isEmpty(await address(p))) return text("The browser is empty. Open the page first: for a document, write it as an HTML file and open it (file:///…).", true);
      try {
        // On the paper the Mac prints on, with the page's colors.
        const paper = process.env.KUVO_PAPER === "letter" ? { paperWidth: 8.5, paperHeight: 11 } : { paperWidth: 8.27, paperHeight: 11.69 };
        // What the user filled in stays out of it, as out of a screenshot (left out, since text
        // drawn clear is still in a PDF).
        await run(p, scripts.printMask);
        let data;
        try {
          ({ data } = await link.send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true, marginTop: 0.5, marginBottom: 0.5, marginLeft: 0.5, marginRight: 0.5, ...paper }, p.session, 60_000));
        } finally {
          await run(p, scripts.printUnmask);
        }
        const bytes = Buffer.from(data, "base64");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
        const pages = (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
        return withNote(Promise.resolve(`Saved the page as a ${pages ? pages + "-page " : ""}PDF at ${file}.`));
      } catch (error) {
        return text("Couldn't save the page as a PDF: " + (error.message || error), true);
      }
    }
    case "browser_screenshot": {
      try {
        return { content: [{ type: "image", data: await screenshot(p), mimeType: "image/png" }] };
      } catch {
        return text("Couldn't capture the page.", true);
      }
    }
    case "browser_sign_in": {
      const username = integer("username");
      const password = integer("password");
      const item = string("item");
      if (username === null && password === null) return text("Name the username field, the password field, or both, by number.", true);
      const url = await address(p);
      const host = hostOf(url);
      if (!host || isEmpty(url)) return text(note() + "Open the sign-in page first.");
      for (const [index, wanted] of [[password, "password"], [username, "text"]]) {
        if (index === null) continue;
        const problem = await checkField(p, index, wanted);
        if (problem) return text(note() + problem);
      }
      // From the vault, when this conversation may use one of its sign-ins here (or the one named):
      // only on that sign-in's own site. Without one, you're asked, as always.
      const vault = await vaultFill(p, { origin: url, purpose: "sign-in", ...(item ? { item } : {}) });
      if (vault?.status === 200) {
        const fields = [[username, vault.value.username, "the username", "text"], [password, vault.value.values?.password, "the password", "password"]].filter(([index, value]) => index !== null && value);
        if (!fields.length) return text(note() + `“${vault.value.item.name}” has nothing for those fields.`);
        // Other calls went on while the vault answered (it may have asked you): a sign-in only
        // goes into the fields it was asked for, on the site the vault was told.
        const changed = await backTo(p, host, fields.map(([index, , , wanted]) => [index, wanted]), "meanwhile");
        if (changed) return text(note() + changed + " Nothing was filled: take a fresh browser_snapshot, and try again if it's still needed.");
        const filled = [];
        for (const [index, value, what, wanted] of fields) {
          const outcome = await run(p, scripts.find + scripts.fill, { index, value, wanted, site: siteOf(host) });
          if (outcome !== "ok") return text(note() + outcome);
          filled.push(what);
        }
        await sleep(300);
        return withNote(snapshot(p).then((page) => `Filled ${filled.join(" and ")} for ${host} from the vault's “${vault.value.item.name}” (you can't see them). Submit the form to sign in.\n\n` + page));
      }
      if (vault && (vault.status === 403 || (item && vault.status !== 423))) return text(note() + (vault.value?.message || "The vault didn't fill that."), vault.status !== 403);
      const answer = await askUser({ kind: "signIn", host, targetId: p.target, username: username !== null, password: password !== null });
      if (answer.type !== "signIn") return text(note() + noAnswer(answer, "sign in"));
      const fields = [[username, answer.username, "the username", "text"], [password, answer.password, "the password", "password"]].filter(([index, value]) => index !== null && value);
      if (!fields.length) return text(note() + "The user didn't give a sign-in for that.");
      // The page may have changed while you answered: a sign-in only goes into the fields it
      // was asked for, on the site you were told.
      const changed = await backTo(p, host, fields.map(([index, , , wanted]) => [index, wanted]));
      if (changed) return text(note() + changed + " Nothing was filled: take a fresh browser_snapshot, and ask again if it's still needed.");
      const filled = [];
      for (const [index, value, what, wanted] of fields) {
        const outcome = await run(p, scripts.find + scripts.fill, { index, value, wanted, site: siteOf(host) });
        if (outcome !== "ok") return text(note() + outcome);
        filled.push(what);
      }
      await sleep(300);
      return withNote(snapshot(p).then((page) => `Filled ${filled.join(" and ")} for ${host} (you can't see them). Submit the form to sign in.\n\n` + page));
    }
    case "browser_fill": {
      const index = integer("index");
      const item = string("item");
      if (index === null || !item) return text("Name the field by its number and the vault item to fill it from.", true);
      const url = await address(p);
      const host = hostOf(url);
      if (!host || isEmpty(url)) return text(note() + "Open the page first.");
      const kind = await run(p, scripts.find + scripts.fieldKind, { index });
      if (kind === "missing") return text(note() + `There's no element [${index}] on the page now. Take a fresh browser_snapshot.`);
      if (kind !== "text" && kind !== "password") return text(note() + `[${index}] isn't a field to fill.`);
      const vault = await vaultFill(p, { origin: url, purpose: "field", item, ...(string("field") ? { field: string("field") } : {}), ...(string("why") ? { why: string("why") } : {}) });
      if (!vault) return text(note() + "This machine's vault can't be reached now. Try again in a moment.", true);
      if (vault.status !== 200) return text(note() + (vault.value?.message || `The vault didn't fill that (${vault.status}).`), vault.status !== 403);
      const [field, value] = Object.entries(vault.value.values ?? {})[0] ?? [];
      if (value === undefined) return text(note() + `“${vault.value.item.name}” has nothing to fill there.`);
      // A password only into a password field; anything else into either.
      const wanted = field === "password" ? "password" : "code";
      // Other calls went on while the vault answered (it may have asked you): only into the same
      // field, on the site the vault was told.
      const changed = await backTo(p, host, [[index, wanted]], "meanwhile");
      if (changed) return text(note() + changed + " Nothing was filled: take a fresh browser_snapshot, and try again if it's still needed.");
      const outcome = await run(p, scripts.find + scripts.fill, { index, value, wanted, site: siteOf(host) });
      if (outcome !== "ok") return text(note() + outcome);
      await sleep(300);
      return withNote(snapshot(p).then((page) => `Filled [${index}] with “${vault.value.item.name}”'s ${field} (you can't see it).\n\n` + page));
    }
    case "browser_ask_code": {
      const index = integer("index");
      if (index === null) return text("Missing index.", true);
      const host = hostOf(await address(p));
      if (!host) return text(note() + "Open the page that asks for the code first.");
      const problem = await checkField(p, index, "code");
      if (problem) return text(note() + problem);
      const answer = await askUser({ kind: "code", host, targetId: p.target, prompt: string("prompt") ?? "" });
      if (answer.type !== "code" || !answer.code) return text(note() + noAnswer(answer, "give a code"));
      const changed = await backTo(p, host, [[index, "code"]]);
      if (changed) return text(note() + changed + " Nothing was filled: take a fresh browser_snapshot, and ask again if it's still needed.");
      const outcome = await run(p, scripts.find + scripts.fill, { index, value: answer.code, wanted: "code", site: siteOf(host) });
      if (outcome !== "ok") return text(note() + outcome);
      await sleep(300);
      return withNote(snapshot(p).then((page) => "Filled the code (you can't see it). Submit it if the page doesn't on its own.\n\n" + page));
    }
    case "browser_ask_user": {
      const instruction = string("instruction");
      if (!instruction) return text("Missing instruction.", true);
      const answer = await askUser({ kind: "action", host: hostOf(await address(p)) ?? "the page", targetId: p.target, instruction });
      if (answer.type !== "done") return text(note() + noAnswer(answer, "do it"));
      // The page may have closed meanwhile; one you still have is only read.
      if (!(await pages()).some((info) => info.targetId === p.target)) return text(note() + "The user says it's done, and the page was closed. Take a fresh browser_snapshot to see where things are.");
      if (!held.has(p.target)) p = await use(p.target);
      await settle(p, false);
      return withNote(snapshot(p).then((page) => "The user says it's done.\n\n" + page));
    }
    case "browser_wait": {
      const wanted = string("text");
      if (wanted) {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const found = await evaluate(p, `(document.body ? document.body.innerText : '').toLowerCase().includes(${JSON.stringify(wanted.toLowerCase())})`).catch(() => false);
          if (found) return withNote(snapshot(p).then((page) => `“${wanted}” is on the page.\n\n` + page));
          await sleep(500);
        }
        return withNote(snapshot(p).then((page) => `“${wanted}” didn't show up in 30 seconds.\n\n` + page));
      }
      const seconds = Math.min(Math.max(Number(args.seconds) || 2, 0), 10);
      await sleep(seconds * 1000);
      return withNote(snapshot(p));
    }
    case "browser_hover": {
      const index = integer("index");
      if (index === null) return text("Missing index.", true);
      const rect = await point(p, index, "hover");
      if (!rect) return text(`There's no element [${index}] on the page now. Take a fresh browser_snapshot.`);
      // A real pointer over it, so the page's own hover styles show too.
      await link.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, p.session);
      await sleep(400);
      return withNote(snapshot(p).then((page) => `Hovered over [${index}].\n\n` + page));
    }
    default:
      return text(`Unknown tool ${name}.`, true);
  }
}

async function mcp() {
  const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
  // Tool calls under way, by request ID, for the engine to give up on.
  const calls = new Map();
  lines(process.stdin, (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    // The engine gave up on a call (it was stopped, or ran out of time): it stops waiting for
    // you, one still in line never runs, and nothing answers it.
    if (message.method === "notifications/cancelled") {
      const call = calls.get(message.params?.requestId);
      if (!call) return;
      call.cancelled = true;
      calls.delete(call.id);
      for (const stop of call.stops) stop();
      call.stops.clear();
      return;
    }
    if (message.id === undefined || message.id === null) return;
    let call = null;
    const reply = (result) => {
      if (call?.cancelled) return;
      if (call) calls.delete(call.id);
      write({ jsonrpc: "2.0", id: message.id, result });
    };
    const params = message.params || {};
    switch (message.method) {
      case "initialize": {
        const supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
        // What the vault's tools are for, only where this machine's box lets agents use it.
        return Promise.all([vaultTools(), workQueueTools()]).then(([more, queue]) => reply({
          protocolVersion: supported.includes(params.protocolVersion) ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "kuvo-browser", title: "Kuvo Code browser", version: VERSION },
          instructions: CONFIG.instructions + (more.length ? CONFIG.vaultInstructions ?? "" : "") + queue.instructions,
        }));
      }
      case "ping":
        return reply({});
      case "tools/list":
        // With the vault's and the sandbox's, in this machine's box's own words (none from a box
        // without them). (browser_fill, and browser_sign_in's vault item, only with the vault's: none
        // while the vault isn't open to agents here, when a sign-in fills only one you let agents
        // make on their own.)
        return Promise.all([vaultTools(), sandboxTools(), workQueueTools()]).then(([more, sandbox, queue]) => reply({ tools: [...(more.length ? CONFIG.tools : closedVaultTools(CONFIG.tools)), ...more, ...sandbox, ...queue.tools] }));
      case "tools/call": {
        // The session it's for: the engine says so with each call; an agent of the agents bridge
        // starts this for one session, named in KUVO_SESSION.
        call = { id: message.id, name: params.name || "", args: params.arguments || {}, session: params._meta?.["ai.opencode/sessionID"] ?? (process.env.KUVO_SESSION || null), cancelled: false, stops: new Set(), notes: [], pages: new Set() };
        calls.set(call.id, call);
        // Showing something in Kuvo Code's panel needs no browser, nor a turn in the line.
        // Nor does writing to another agent.
        // The vault's, the sandbox's and the Work Queue's, which this machine's box carries out (and
        // may ask you).
        const boxTool = typeof params.name === "string" && (params.name.startsWith("vault_") ? ["kuvo/vault/tools", "This machine's vault can't be reached now. Try again in a moment."]
          : params.name.startsWith("sandbox_") ? ["kuvo/sandbox/tools", "This machine's box can't be reached now. Try again in a moment."]
          : params.name.startsWith("queue_") ? ["kuvo/work-queue/tools", "This machine's box can't be reached now. Try again in a moment."] : null);
        if (boxTool) {
          const asked = call;
          vaultRoute({ method: "POST", path: boxTool[0], body: { name: params.name, arguments: params.arguments || {}, session: asked.session } }, asked, 16 * 60_000)
            .then((answer) => reply(answer?.status === 200 && typeof answer.value?.text === "string" ? text(answer.value.text, answer.value.isError === true) : text(answer?.value?.message || boxTool[1], true)));
          return;
        }
        if (MAIL_TOOLS.has(params.name)) {
          // (A wake-up or a job is never stopped half way: what's kept would be half of it.)
          const stops = !KEPT_WHOLE.has(params.name);
          mail(params.name, params.arguments || {}, call.session, () => stops && call.cancelled).then(reply, (error) => reply(text(error instanceof ToolError ? error.message : String(error), true)));
          return;
        }
        // A Mac's own box: the browser is its app's panel's.
        if (MAC_BOX && typeof params.name === "string" && params.name.startsWith("browser_")) {
          call.meta = params._meta;
          appBrowser(call, reply).catch((error) => reply(text(String(error?.message || error), true)));
          return;
        }
        // An added integration's site: to its tools instead, with no browser needed.
        if (params.name === "browser_navigate" || params.name === "browser_new_tab") {
          const note = integrationNote(params.arguments?.url, call.session);
          if (note) return reply(text(note));
        }
        perform(call, reply);
        return;
      }
      default:
        return write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });
    }
  });
  process.stdin.on("end", () => process.exit(0));
  // (A Mac's own box has no browser of its own: its app's panel is.)
  if (MAC_BOX) return;
  // A keeper that's already running stays up while the engine does, across its restarts.
  if (await reachable()) browser().catch(() => {});
  // No browser here: the box sets it up now, ready for the first tool (it waits a while after a
  // failure, as its keeper does).
  else if (!browserBinary(CURRENT)) startSetUp().catch(() => {});
}

const mode = process.argv[2];
const modes = { host, mcp, connect };
if (!modes[mode]) {
  console.error("Usage: kuvo-browser.js host|mcp|connect");
  process.exit(2);
}
modes[mode]().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
