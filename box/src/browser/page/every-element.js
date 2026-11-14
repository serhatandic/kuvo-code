const everyElement = (visit) => {
  let place = 0;
  (function walk(root) {
    for (const element of root.querySelectorAll('*')) {
      visit(element, place++);
      if (element.shadowRoot) walk(element.shadowRoot);
      if (element.localName === 'iframe' || element.localName === 'frame') {
        try { if (element.contentDocument) walk(element.contentDocument); } catch {}
      }
    }
  })(document);
};

