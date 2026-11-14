const roots = [];
(function collect(root) {
  roots.push(root);
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) collect(element.shadowRoot);
    if (element.localName === 'iframe' || element.localName === 'frame') {
      try { if (element.contentDocument) collect(element.contentDocument); } catch {}
    }
  }
})(document);

