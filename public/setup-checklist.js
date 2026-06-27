(function () {
  'use strict';

  const MINIMIZED_KEY = 'setupChecklist:minimized:v1';
  const mountId = 'setup-checklist';

  function isMinimized() {
    try {
      const stored = localStorage.getItem(MINIMIZED_KEY);
      if (stored === '1' || stored === '0') return stored === '1';
      if (localStorage.getItem('setupChecklist:dismissed:v1') === '1') {
        localStorage.removeItem('setupChecklist:dismissed:v1');
        localStorage.setItem(MINIMIZED_KEY, '1');
        return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  function setMinimized(minimized) {
    try {
      localStorage.setItem(MINIMIZED_KEY, minimized ? '1' : '0');
    } catch (_) {}
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function bindChecklistInteractions(mount, minimized) {
    const toggleBtn = mount.querySelector('.setup-checklist__toggle');
    const summaryBtn = mount.querySelector('.setup-checklist__summary');

    function applyMinimized(next) {
      setMinimized(next);
      mount.classList.toggle('setup-checklist--minimized', next);
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-expanded', next ? 'false' : 'true');
        toggleBtn.setAttribute('aria-label', next ? 'Expand setup checklist' : 'Minimize setup checklist');
        toggleBtn.textContent = next ? '▾' : '▴';
      }
    }

    applyMinimized(minimized);

    if (toggleBtn) {
      toggleBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        applyMinimized(!mount.classList.contains('setup-checklist--minimized'));
      });
    }

    if (summaryBtn) {
      summaryBtn.addEventListener('click', function () {
        if (mount.classList.contains('setup-checklist--minimized')) {
          applyMinimized(false);
        }
      });
    }

    mount.querySelectorAll('.setup-checklist__link').forEach(function (link) {
      link.addEventListener('click', function () {
        document.body.classList.remove('mobile-nav-open');
        const navToggle = document.querySelector('.mobile-nav-toggle');
        if (navToggle) {
          navToggle.setAttribute('aria-expanded', 'false');
          navToggle.setAttribute('aria-label', 'Open menu');
        }
        const backdrop = document.querySelector('.mobile-nav-backdrop');
        if (backdrop) backdrop.hidden = true;
      });
    });
  }

  function renderChecklist(data) {
    const mount = document.getElementById(mountId);
    if (!mount) return;

    const steps = Array.isArray(data.steps) ? data.steps : [];
    const total = Number(data.total || steps.length || 0);
    if (!data || !data.success || total === 0) {
      mount.hidden = true;
      mount.innerHTML = '';
      mount.classList.remove('setup-checklist--minimized');
      return;
    }

    const completed = Number(data.completed || 0);
    const allDone = !!data.allDone;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    const title = allDone ? 'Setup complete' : 'Get started';
    const lead = allDone
      ? 'Your workspace is ready. Expand anytime to review these steps.'
      : 'Finish these steps to launch your bot.';
    const minimized = isMinimized() || allDone;

    mount.hidden = false;
    mount.innerHTML =
      '<div class="setup-checklist__card">' +
        '<div class="setup-checklist__header">' +
          '<button type="button" class="setup-checklist__summary">' +
            '<span class="setup-checklist__title">' + escapeHtml(title) + '</span>' +
            '<span class="setup-checklist__summary-meta">' + completed + '/' + total + '</span>' +
          '</button>' +
          '<button type="button" class="setup-checklist__toggle" aria-expanded="' + (minimized ? 'false' : 'true') + '" aria-label="' + (minimized ? 'Expand setup checklist' : 'Minimize setup checklist') + '">' + (minimized ? '▾' : '▴') + '</button>' +
        '</div>' +
        '<div class="setup-checklist__body">' +
          '<p class="setup-checklist__lead">' + escapeHtml(lead) + '</p>' +
          '<div class="setup-checklist__progress" aria-hidden="true">' +
            '<div class="setup-checklist__progress-bar' + (allDone ? ' setup-checklist__progress-bar--done' : '') + '" style="width:' + pct + '%"></div>' +
          '</div>' +
          '<div class="setup-checklist__meta">' + completed + ' of ' + total + ' complete</div>' +
          '<ul class="setup-checklist__list">' +
            steps.map(function (step) {
              const done = !!step.done;
              return (
                '<li class="setup-checklist__item' + (done ? ' is-done' : '') + '">' +
                  (done
                    ? '<span class="setup-checklist__check" aria-hidden="true">✓</span>'
                    : '<span class="setup-checklist__bullet" aria-hidden="true"></span>') +
                  '<a class="setup-checklist__link" href="' + escapeHtml(step.href) + '">' +
                    '<span class="setup-checklist__label">' + escapeHtml(step.label) + '</span>' +
                    (step.hint ? '<span class="setup-checklist__hint">' + escapeHtml(step.hint) + '</span>' : '') +
                  '</a>' +
                '</li>'
              );
            }).join('') +
          '</ul>' +
        '</div>' +
      '</div>';

    bindChecklistInteractions(mount, minimized);
  }

  async function refreshChecklist() {
    const mount = document.getElementById(mountId);
    if (!mount) return;

    try {
      const response = await fetch('/api/setup-checklist', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        mount.hidden = true;
        return;
      }
      renderChecklist(data);
    } catch (error) {
      console.warn('Setup checklist failed:', error);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    refreshChecklist();
    window.setInterval(refreshChecklist, 45000);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshChecklist();
  });

  window.addEventListener('pageshow', refreshChecklist);
  window.setupChecklist = { refresh: refreshChecklist };
})();
