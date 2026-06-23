(function () {
  const SETTINGS_PANEL_KEY = 'settings:activePanel:v1';

  function initSettingsPanels() {
    const panels = document.querySelectorAll('.settings-panel');
    const links = document.querySelectorAll('[data-settings-panel]');
    const heading = document.getElementById('settings-panel-heading');

    function showPanel(id) {
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
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', '#' + id);
      }
    }

    links.forEach(function (link) {
      link.addEventListener('click', function () {
        showPanel(link.getAttribute('data-settings-panel'));
      });
    });

    window.addEventListener('hashchange', function () {
      const hash = (location.hash || '').replace(/^#/, '');
      if (hash) showPanel(hash);
    });

    const hash = (location.hash || '').replace(/^#/, '');
    let stored = null;
    try { stored = localStorage.getItem(SETTINGS_PANEL_KEY); } catch (_) {}
    const initial = (hash && document.getElementById(hash)) ? hash : (stored || 'account');
    showPanel(initial);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSettingsPanels);
  } else {
    initSettingsPanels();
  }
})();
