let target = document.activeElement || document.body;
for (;;) {
  const frame = (target.localName === 'iframe' || target.localName === 'frame') && target.contentDocument;
  const inner = target.shadowRoot ? target.shadowRoot.activeElement : frame ? frame.activeElement : null;
  if (!inner || inner === target) break;
  target = inner;
}
const view = target.ownerDocument.defaultView || window;
const codes = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32 };
const init = { key: key, code: key, keyCode: codes[key] || 0, which: codes[key] || 0, bubbles: true, cancelable: true, composed: true };
const proceed = target.dispatchEvent(new view.KeyboardEvent('keydown', init));
if (key === 'Enter') target.dispatchEvent(new view.KeyboardEvent('keypress', init));
target.dispatchEvent(new view.KeyboardEvent('keyup', init));
if (key === 'Enter' && proceed && target.form) target.form.requestSubmit ? target.form.requestSubmit() : target.form.submit();
if (key === 'Escape' && typeof target.blur === 'function') target.blur();
return 'ok';
