(function () {
  const LAZY_PANELS = new Set([
    'staff',
    'quick-replies',
    'holidays',
    'whatsapp',
    'billing',
    'business',
    'ai_configuration',
    'bookings_section',
  ]);
  const SCRIPT_BY_PANEL = {
    staff: '/staff-working-hours.js',
    holidays: '/holiday-closures.js',
    whatsapp: '/settings-whatsapp-connect.js',
  };
  const loadedScripts = new Set();
  const loadedPanels = new Map();
  const assetVer = (document.querySelector('script[src*="settings-lazy-panels.js"]') || {}).src?.split('v=')[1]?.split('&')[0] || 'dev';

  function panelUrl(panelId, force) {
    const params = new URLSearchParams(window.location.search || '');
    if (force) params.set('_', String(Date.now()));
    const qs = params.toString();
    return '/api/settings/lazy-panel/' + encodeURIComponent(panelId) + (qs ? '?' + qs : '');
  }

  function loadScriptOnce(src) {
    const fullSrc = src + (src.includes('?') ? '&' : '?') + 'v=' + assetVer;
    if (loadedScripts.has(fullSrc)) {
      return Promise.resolve();
    }
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src^="' + src + '"]')) {
        loadedScripts.add(fullSrc);
        resolve();
        return;
      }
      const el = document.createElement('script');
      el.src = fullSrc;
      el.defer = true;
      el.onload = function () {
        loadedScripts.add(fullSrc);
        resolve();
      };
      el.onerror = reject;
      document.body.appendChild(el);
    });
  }

  function injectInlineScript(code, panelId) {
    if (!code) return;
    const marker = 'settings-lazy-inline-' + panelId;
    if (document.getElementById(marker)) return;
    const el = document.createElement('script');
    el.id = marker;
    el.textContent = code;
    document.body.appendChild(el);
  }

  function initPanelWidgets(panelId, root) {
    if (panelId === 'staff' && typeof window.initStaffWorkingHours === 'function') {
      window.initStaffWorkingHours(root);
    }
    if (panelId === 'holidays' && typeof window.initHolidayClosures === 'function') {
      window.initHolidayClosures(root);
    }
    if (panelId === 'whatsapp' && typeof window.initWhatsAppConnect === 'function') {
      window.initWhatsAppConnect(root);
    }
    if (panelId === 'ai_configuration' && typeof window.initSettingsAiPanel === 'function') {
      window.initSettingsAiPanel(root);
    }
  }

  async function loadLazyPanel(panelId, options) {
    options = options || {};
    const root = document.getElementById(panelId);
    if (!root) return;

    if (!options.force && loadedPanels.get(panelId) === true) {
      initPanelWidgets(panelId, root);
      return;
    }

    root.innerHTML = '<div class="settings-lazy-panel__placeholder"><p class="small">Loading…</p></div>';

    try {
      const response = await fetch(panelUrl(panelId, options.force), {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const data = await response.json();
      if (!response.ok || !data.success || !data.html) {
        throw new Error((data && data.error) || 'Failed to load panel');
      }
      root.innerHTML = data.html;
      if (data.stripeEnabled && !document.querySelector('script[src="https://js.stripe.com/v3/"]')) {
        await loadScriptOnce('https://js.stripe.com/v3/');
      }
      if (data.inlineScript) {
        injectInlineScript(data.inlineScript, panelId);
      }
      if (SCRIPT_BY_PANEL[panelId]) {
        await loadScriptOnce(SCRIPT_BY_PANEL[panelId]);
      }
      loadedPanels.set(panelId, true);
      initPanelWidgets(panelId, root);
    } catch (error) {
      root.innerHTML = '<div class="settings-callout settings-callout--error"><p class="small">Could not load this section. Refresh and try again.</p></div>';
      console.error('Settings lazy panel failed:', panelId, error);
    }
  }

  function onPanelShown(panelId) {
    if (!LAZY_PANELS.has(panelId)) return;
    loadLazyPanel(panelId);
  }

  document.addEventListener('settings-panel-shown', function (event) {
    onPanelShown(event.detail && event.detail.panelId);
  });

  window.settingsLazyPanels = {
    load: loadLazyPanel,
    reload: function (panelId) {
      loadedPanels.delete(panelId);
      return loadLazyPanel(panelId, { force: true });
    },
  };

  function bootInitialPanel() {
    const hash = (window.location.hash || '').replace(/^#/, '');
    const aliases = { ai: 'ai_configuration', conversation: 'ai_configuration' };
    const panelId = aliases[hash] || hash;
    if (panelId && LAZY_PANELS.has(panelId)) {
      onPanelShown(panelId);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootInitialPanel);
  } else {
    bootInitialPanel();
  }
})();
