const element = find(index);
if (!element) return missing(index);
document.getElementById('playwright-highlight-container')?.remove();
element.scrollIntoView({ block: 'center' });
element.focus();
const view = viewOf(element);
if (element.isContentEditable) {
  const doc = element.ownerDocument;
  if (clear) { doc.execCommand('selectAll', false); doc.execCommand('delete', false); }
  doc.execCommand('insertText', false, text);
} else if (element.localName === 'input' || element.localName === 'textarea') {
  const prototype = element.localName === 'textarea' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
  setter.call(element, (clear ? '' : element.value) + text);
  element.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new view.Event('change', { bubbles: true }));
} else {
  return `[${index}] doesn't take text. Click it first, or pick an input.`;
}
if (submit) {
  const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
  const proceed = element.dispatchEvent(new view.KeyboardEvent('keydown', init));
  element.dispatchEvent(new view.KeyboardEvent('keypress', init));
  element.dispatchEvent(new view.KeyboardEvent('keyup', init));
  if (proceed && element.form) element.form.requestSubmit ? element.form.requestSubmit() : element.form.submit();
}
return 'ok';
