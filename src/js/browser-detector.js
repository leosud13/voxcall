const PHONE_REGEX = /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}(?:[-.\s]?\d{1,6})?/g;

export const INJECT_SCRIPT = `
(function() {
  if (window.__voxcallInjected) return;
  window.__voxcallInjected = true;

  const PHONE_REGEX = /(?:\\+?\\d{1,3}[-.\\s]?)?(?:\\(?\\d{2,4}\\)?[-.\\s]?)?\\d{3,4}[-.\\s]?\\d{3,4}(?:[-.\\s]?\\d{1,6})?/g;

  function isValidPhone(text) {
    const digits = text.replace(/\\D/g, '');
    return digits.length >= 8 && digits.length <= 15;
  }

  function createButton(number) {
    const btn = document.createElement('button');
    btn.className = 'voxcall-detect-btn';
    btn.textContent = '📞 VoxCall';
    btn.title = 'Ligar com VoxCall: ' + number;
    btn.style.cssText = 'margin-left:4px;padding:2px 8px;font-size:11px;cursor:pointer;background:#3b82f6;color:#fff;border:none;border-radius:4px;vertical-align:middle;';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('VOXCALL_DIAL:' + number);
    });
    return btn;
  }

  function processTelLinks() {
    document.querySelectorAll('a[href^="tel:"]').forEach((link) => {
      if (link.dataset.voxcallDone) return;
      link.dataset.voxcallDone = '1';
      const number = link.href.replace('tel:', '').trim();
      if (isValidPhone(number)) {
        link.parentNode.insertBefore(createButton(number), link.nextSibling);
      }
    });
  }

  function processTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !PHONE_REGEX.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest('.voxcall-detect-btn') || parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach((textNode) => {
      const text = textNode.nodeValue;
      PHONE_REGEX.lastIndex = 0;
      const matches = [...text.matchAll(PHONE_REGEX)].filter((m) => isValidPhone(m[0]));
      if (!matches.length) return;

      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      matches.forEach((match) => {
        const start = match.index;
        const number = match[0];
        if (start > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));
        const span = document.createElement('span');
        span.textContent = number;
        span.style.whiteSpace = 'nowrap';
        span.appendChild(createButton(number));
        frag.appendChild(span);
        lastIndex = start + number.length;
      });
      if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      textNode.parentNode.replaceChild(frag, textNode);
    });
  }

  function scan() {
    processTelLinks();
    processTextNodes(document.body);
  }

  scan();
  const observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true });
})();
`;

export function setupBrowserDetector(webview, onDial) {
  if (!webview) return;

  webview.addEventListener('dom-ready', () => {
    webview.executeJavaScript(INJECT_SCRIPT).catch(() => {});
  });

  webview.addEventListener('console-message', (event) => {
    const match = event.message?.match(/^VOXCALL_DIAL:(.+)$/);
    if (match) onDial(match[1]);
  });
}
