(function () {
  'use strict';

  function getMeta(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    return el ? el.getAttribute('content') : '';
  }

  function getPreloadHref() {
    var link = document.querySelector('link[rel="preload"][href*="clerk.browser.js"]');
    return link ? link.getAttribute('href') : '';
  }

  function ensureClerkScriptLoaded() {
    if (window.__clerkScriptReady) return window.__clerkScriptReady;

    window.__clerkScriptReady = new Promise(function (resolve) {
      if (window.Clerk && window.Clerk.load) {
        resolve();
        return;
      }

      var existing = document.querySelector('script[data-clerk-publishable-key]');
      if (existing) {
        if (existing.getAttribute('data-loaded') === '1') {
          resolve();
          return;
        }
        existing.addEventListener('load', function () {
          existing.setAttribute('data-loaded', '1');
          resolve();
        }, { once: true });
        existing.addEventListener('error', function () { resolve(); }, { once: true });
        return;
      }

      var src = getPreloadHref();
      var key = getMeta('clerk-publishable-key');
      if (!src || !key) {
        resolve();
        return;
      }

      var script = document.createElement('script');
      script.src = src;
      script.crossOrigin = 'anonymous';
      script.setAttribute('data-clerk-publishable-key', key);
      script.addEventListener('load', function () {
        script.setAttribute('data-loaded', '1');
        resolve();
      }, { once: true });
      script.addEventListener('error', function () { resolve(); }, { once: true });
      document.head.appendChild(script);
    });

    return window.__clerkScriptReady;
  }

  window.ensureClerkScriptLoaded = ensureClerkScriptLoaded;
})();
