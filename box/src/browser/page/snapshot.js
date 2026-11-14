document.getElementById('playwright-highlight-container')?.remove();
const numbered = {};
/*@ every-element */
const lent = [];
if (typeof kuvoHandlers === 'object' && kuvoHandlers && kuvoHandlers.length) {
  const handlers = new Map(kuvoHandlers.map((entry) => [entry[0], entry]));
  everyElement((element, place) => {
    const entry = handlers.get(place);
    if (!entry || entry[1] !== element.localName) return;
    for (const name of entry[2]) {
      Object.defineProperty(element, name, { value: () => {}, configurable: true });
      lent.push([element, name]);
    }
  });
}
let result;
try {
  result = (/*@ dom-tree */)({ doHighlightElements: false, focusHighlightIndex: -1, viewportExpansion: 0, debugMode: false, onIndex: (number, element) => { numbered[number] = element; } });
} finally {
  for (const [element, name] of lent) delete element[name];
}
/*@ fingerprint */
const map = result.map || {};
const ATTRIBUTES = ['title', 'type', 'checked', 'name', 'role', 'value', 'placeholder', 'alt', 'aria-label', 'aria-expanded', 'aria-checked', 'data-state', 'href'];
const index = {};
const lines = [];
const clean = (text) => text.replace(/\s+/g, ' ').trim();
function textUntilClickable(id) {
  const parts = [];
  (function walk(nodeID, isRoot) {
    const node = map[nodeID];
    if (!node) return;
    if (node.type === 'TEXT_NODE') { if (node.isVisible !== false) parts.push(node.text); return; }
    if (!isRoot && node.highlightIndex !== undefined && node.highlightIndex !== null) return;
    (node.children || []).forEach((child) => walk(child, false));
  })(id, true);
  return clean(parts.join(' '));
}
(function walk(nodeID, insideClickable) {
  const node = map[nodeID];
  if (!node) return;
  if (node.type === 'TEXT_NODE') {
    if (!insideClickable && node.isVisible !== false && clean(node.text)) lines.push(clean(node.text));
    return;
  }
  let inside = insideClickable;
  if (node.highlightIndex !== undefined && node.highlightIndex !== null) {
    const element = numbered[node.highlightIndex];
    if (element) index[node.highlightIndex] = { element, print: fingerprint(element) };
    const attributes = ATTRIBUTES
      .filter((name) => node.attributes && node.attributes[name])
      // A password field's value never goes to the model.
      .filter((name) => !(name === 'value' && String(node.attributes.type).toLowerCase() === 'password'))
      // Nor what the user filled in through Kuvo Code.
      .filter((name) => !(name === 'value' && node.attributes['data-kuvo-secret'] !== undefined))
      .map((name) => `${name}="${String(node.attributes[name]).slice(0, 100)}"`)
      .join(' ');
    const tag = node.tagName || 'element';
    lines.push(`[${node.highlightIndex}]<${tag}${attributes ? ' ' + attributes : ''}>${textUntilClickable(nodeID).slice(0, 150)}</${tag}>`);
    inside = true;
  }
  (node.children || []).forEach((child) => walk(child, inside));
})(result.rootId, false);
// In the agent's world (`BrowserAgent.world`, and a machine's), out of the page's reach.
window.__kuvoIndex = { snapshot: typeof kuvoSnapshot === 'string' ? kuvoSnapshot : null, elements: index };
// A page that asks to sign in (or for a one-time code) says what to do about it, where the
// agent reads it: ask the user in Kuvo Code, not in the chat.
const shown = (field) => !field.disabled && field.getClientRects().length > 0 && getComputedStyle(field).visibility !== 'hidden';
const fields = [...document.querySelectorAll('input')].filter(shown);
const filled = fields.some((field) => field.hasAttribute('data-kuvo-secret'));
const autocomplete = (pattern) => fields.some((field) => pattern.test(field.autocomplete || ''));
if (!filled && autocomplete(/one-time-code/)) {
  lines.unshift('(This page asks for a one-time code: call browser_ask_code with its field now, unless the user already said no. The user types it in Kuvo Code; never ask for it in the chat.)', '');
} else if (!filled && (fields.some((field) => field.type === 'password') || autocomplete(/\busername\b|current-password/))) {
  lines.unshift('(This page asks to sign in: call browser_sign_in with its fields now, unless the user already said no. The user answers in Kuvo Code, where they can also say Not Now; do not ask in the chat whether to sign in, or for their password.)', '');
}
const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
return {
  text: lines.join('\n'),
  title: document.title,
  url: location.href,
  above: Math.round(window.scrollY),
  below: Math.max(0, Math.round(scrollHeight - window.scrollY - window.innerHeight)),
};
