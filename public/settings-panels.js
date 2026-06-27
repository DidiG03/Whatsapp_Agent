(function () {
  const SETTINGS_PANEL_KEY = 'settings:activePanel:v1';
  const PANEL_ALIASES = {
    ai: 'ai_configuration',
    conversation: 'ai_configuration',
  };

  function normalizePanelId(id) {
    return PANEL_ALIASES[id] || id;
  }

  function initSettingsPanels() {
    const panels = document.querySelectorAll('.settings-panel');
    const links = document.querySelectorAll('[data-settings-panel]');
    const heading = document.getElementById('settings-panel-heading');

    function showPanel(id) {
      id = normalizePanelId(id);
      if (!id) return;
      const hasPanel = Array.from(panels).some(function (panel) { return panel.id === id; });
      if (!hasPanel) return;

      panels.forEach(function (panel) {
        panel.classList.toggle('is-active', panel.id === id);
      });
      links.forEach(function (link) {
        link.classList.toggle('is-active', link.getAttribute('data-settings-panel') === id);
      });

      const activeHeading = document.querySelector('.settings-panel.is-active h3, .settings-panel.is-active .settings-section__title');
      if (heading) {
        heading.textContent = (activeHeading && activeHeading.textContent
          ? activeHeading.textContent.trim()
          : '') || 'Settings';
      }

      try { localStorage.setItem(SETTINGS_PANEL_KEY, id); } catch (_) {}
      const panelInput = document.getElementById('settings-active-panel');
      if (panelInput) panelInput.value = id;
      if (window.history && window.history.replaceState) {
        const search = location.search || '';
        window.history.replaceState(null, '', location.pathname + search + '#' + id);
      }
      try {
        document.dispatchEvent(new CustomEvent('settings-panel-shown', { detail: { panelId: id } }));
      } catch (_) {}
    }

    links.forEach(function (link) {
      link.addEventListener('click', function () {
        showPanel(link.getAttribute('data-settings-panel'));
      });
    });

    window.addEventListener('hashchange', function () {
      const hash = normalizePanelId((location.hash || '').replace(/^#/, ''));
      if (hash) showPanel(hash);
    });

    const hash = normalizePanelId((location.hash || '').replace(/^#/, ''));
    let stored = null;
    try { stored = normalizePanelId(localStorage.getItem(SETTINGS_PANEL_KEY)); } catch (_) {}
    const search = new URLSearchParams(location.search || '');
    const stripeBillingErrors = new Set(['payment_not_completed', 'processing_failed', 'no_session_id']);
    const stripeBillingReturn = search.get('success') === 'true'
      || search.get('canceled') === 'true'
      || stripeBillingErrors.has(search.get('error'));
    const initial = (hash && document.getElementById(hash))
      ? hash
      : (stripeBillingReturn ? 'billing' : (stored || 'account'));
    showPanel(initial);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSettingsPanels);
  } else {
    initSettingsPanels();
  }
})();
