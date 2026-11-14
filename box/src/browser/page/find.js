/*@ fingerprint */
let lost = 'none';
// On the page now: in its document, and that document still in its frame, out to the page's own.
const attached = (element) => {
  for (let node = element; node;) {
    if (!node.isConnected) return false;
    const doc = node.ownerDocument;
    if (doc === document) return true;
    const frame = doc.defaultView && doc.defaultView.frameElement;
    if (!frame || frame.contentDocument !== doc) return false;
    node = frame;
  }
  return false;
};
const find = (number) => {
  const map = window.__kuvoIndex;
  const entry = map && map.elements ? map.elements[number] : null;
  if (!entry) { lost = 'none'; return null; }
  if (typeof kuvoSnapshot === 'string' && map.snapshot !== kuvoSnapshot) { lost = 'other'; return null; }
  if (!attached(entry.element) || fingerprint(entry.element) !== entry.print) { lost = 'changed'; return null; }
  return entry.element;
};
const missing = (number) => lost === 'changed'
  ? `The page changed since the snapshot: [${number}] is gone or isn't what it was. Take a fresh browser_snapshot.`
  : lost === 'other'
    ? `[${number}] is from a snapshot of another page or tab. Take a fresh browser_snapshot of this one.`
    : `There's no element [${number}] on the page now. Take a fresh browser_snapshot.`;
// The window an element is in (its frame's), whose events and types it takes.
const viewOf = (element) => element.ownerDocument.defaultView || window;
// What kind of field an element is: "password", "text" (a username, an email, a code) or "other".
const kindOf = (element) => {
  if (element.localName === 'input') {
    const type = (element.type || 'text').toLowerCase();
    if (type === 'password') return 'password';
    return ['text', 'email', 'tel', 'number', 'search', 'url'].includes(type) ? 'text' : 'other';
  }
  return element.localName === 'textarea' ? 'text' : 'other';
};

