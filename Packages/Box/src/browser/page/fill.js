const element = find(index);
if (!element) return missing(index);
// Only into a page of the site the user was asked about: its address may already show the
// next site while this document is still the last one's.
const where = element.ownerDocument.location;
const here = where.protocol === 'file:' ? 'a file on this Mac' : where.protocol === 'http:' ? 'http://' + where.hostname : where.hostname;
if (typeof site === 'string' && here !== site) {
  return `The page isn't on ${site} now, so nothing was filled in. Take a fresh browser_snapshot and ask again.`;
}
const kind = kindOf(element);
if (wanted === 'password' ? kind !== 'password' : wanted === 'code' ? kind === 'other' : kind !== 'text') {
  return wanted === 'password'
    ? `[${index}] isn't a password field now: a password only goes into one. Nothing was filled in. Take a fresh browser_snapshot and ask again.`
    : `[${index}] isn't a field for that now. Nothing was filled in. Take a fresh browser_snapshot and ask again.`;
}
element.scrollIntoView({ block: 'center' });
element.focus();
const view = viewOf(element);
const prototype = element.localName === 'textarea' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
element.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
element.dispatchEvent(new view.Event('change', { bubbles: true }));
element.setAttribute('data-kuvo-secret', '');
return 'ok';
