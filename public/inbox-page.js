(function () {
  async function checkWaTokenAndPrompt() {
    try {
      const r = await fetch('/api/settings/wa-token/status', { credentials: 'include' });
      const j = await r.json();
      if (j.status === 'invalid' || j.status === 'missing') {
        openWaTokenModal(j.status);
      }
    } catch (_) {}
  }

  window.openWaTokenModal = function openWaTokenModal(state) {
    const m = document.getElementById('waTokenModal');
    if (!m) return;
    m.style.display = 'flex';
    const msg = document.getElementById('waTokenMsg');
    if (msg) {
      msg.textContent = state === 'missing'
        ? 'Your WhatsApp configuration is incomplete. Please add a valid token.'
        : 'Your WhatsApp token appears to be invalid or expired. Please enter a new token.';
    }
  };

  window.closeWaTokenModal = function closeWaTokenModal() {
    const m = document.getElementById('waTokenModal');
    if (m) m.style.display = 'none';
  };

  window.saveWaToken = async function saveWaToken() {
    const input = document.getElementById('waTokenInput');
    const btn = document.getElementById('waTokenSave');
    if (!input || !input.value.trim() || !btn) return;
    btn.disabled = true;
    try {
      const resp = await fetch('/api/settings/wa-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ whatsapp_token: input.value.trim() })
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        const msg = (data && data.error) || 'Failed to update token';
        try {
          if (window.Toast && typeof window.Toast.error === 'function') {
            window.Toast.error(msg);
          }
        } catch (_) {}
        btn.disabled = false;
        return;
      }
      closeWaTokenModal();
      location.reload();
    } catch (e) {
      btn.disabled = false;
      try {
        if (window.Toast && typeof window.Toast.error === 'function') {
          window.Toast.error('Error: ' + ((e && e.message) || e));
        }
      } catch (_) {}
    }
  };

  window.openNameModal = function openNameModal(contactId) {
    const f = document.getElementById('nameForm');
    if (f) f.action = '/inbox/' + encodeURIComponent(contactId) + '/nameCustomer';
    const m = document.getElementById('nameModal');
    if (m) m.style.display = 'flex';
  };

  window.closeNameModal = function closeNameModal() {
    const m = document.getElementById('nameModal');
    if (m) m.style.display = 'none';
  };

  window.openImageModal = function openImageModal() {
    const m = document.getElementById('imageModal');
    if (m) m.style.display = 'flex';
  };

  window.closeImageModal = function closeImageModal() {
    const m = document.getElementById('imageModal');
    if (m) m.style.display = 'none';
  };

  window.toggleSearchFilters = function toggleSearchFilters() {
    const filters = document.getElementById('searchFilters');
    if (!filters) return;
    const open = filters.style.display === 'none' || filters.style.display === '';
    filters.style.display = open ? 'grid' : 'none';
  };

  window.clearFilters = function clearFilters() {
    const q = document.querySelector('input[name="q"]');
    const type = document.querySelector('select[name="type"]');
    const dir = document.querySelector('select[name="direction"]');
    const from = document.querySelector('input[name="date_from"]');
    const to = document.querySelector('input[name="date_to"]');
    if (q) q.value = '';
    if (type) type.value = '';
    if (dir) dir.value = '';
    if (from) from.value = '';
    if (to) to.value = '';
  };

  function saveSearchHistory(query) {
    if (!query.trim()) return;
    let history = JSON.parse(localStorage.getItem('searchHistory') || '[]');
    history = history.filter(function (item) { return item !== query; });
    history.unshift(query);
    history = history.slice(0, 10);
    localStorage.setItem('searchHistory', JSON.stringify(history));
  }

  function loadSearchHistory() {
    return JSON.parse(localStorage.getItem('searchHistory') || '[]');
  }

  function selectSuggestion(query) {
    const input = document.querySelector('input[name="q"]');
    if (input) input.value = query;
    hideSearchSuggestions();
  }

  function hideSearchSuggestions() {
    const suggestions = document.querySelector('.search-suggestions');
    if (suggestions) suggestions.remove();
  }

  function showSearchSuggestions() {
    const history = loadSearchHistory();
    if (!history.length) return;
    const input = document.querySelector('input[name="q"]');
    const container = document.querySelector('.search-container') || document.querySelector('.search-form');
    if (!input || !container) return;
    hideSearchSuggestions();
    if (input.value.trim() !== '') return;

    const suggestionsDiv = document.createElement('div');
    suggestionsDiv.className = 'search-suggestions';
    const header = document.createElement('div');
    header.className = 'suggestions-header';
    header.textContent = 'Recent Searches';
    suggestionsDiv.appendChild(header);
    history.forEach(function (item) {
      const row = document.createElement('div');
      row.className = 'suggestion-item';
      row.setAttribute('data-query', item);
      row.textContent = item;
      suggestionsDiv.appendChild(row);
    });
    suggestionsDiv.addEventListener('click', function (ev) {
      const item = ev.target.closest('.suggestion-item');
      if (!item) return;
      selectSuggestion(item.getAttribute('data-query') || '');
    });
    container.appendChild(suggestionsDiv);
  }

  window.switchImageTab = function switchImageTab(tab) {
    const urlTab = document.getElementById('urlTab');
    const uploadTab = document.getElementById('uploadTab');
    const urlForm = document.getElementById('imageUrlForm');
    const uploadForm = document.getElementById('imageUploadForm');
    if (!urlTab || !uploadTab || !urlForm || !uploadForm) return;
    if (tab === 'url') {
      urlTab.style.background = 'var(--surface)';
      uploadTab.style.background = '#f0f0f0';
      urlForm.style.display = 'grid';
      uploadForm.style.display = 'none';
    } else {
      urlTab.style.background = '#f0f0f0';
      uploadTab.style.background = 'var(--surface)';
      urlForm.style.display = 'none';
      uploadForm.style.display = 'grid';
    }
  };

  function closeInboxMenu(menu) {
    if (!menu) return;
    menu.classList.remove('is-open');
    menu.style.position = '';
    menu.style.left = '';
    menu.style.top = '';
    menu.style.zIndex = '';
    menu.style.display = '';
  }

  function openInboxMenu(menu, trigger) {
    const rect = (trigger && trigger.getBoundingClientRect()) || menu.getBoundingClientRect();
    menu.classList.add('is-open');
    menu.style.position = 'fixed';
    menu.style.left = Math.max(8, rect.right - 208) + 'px';
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.zIndex = '100000';
    menu.style.display = 'block';
  }

  window.toggleMenu = function toggleMenu(id, evt) {
    if (evt) {
      try {
        evt.preventDefault();
        evt.stopPropagation();
      } catch (_) {}
    }
    try {
      const menu = document.getElementById(id);
      if (!menu) return false;
      const dropdown = menu.closest('.inbox-dropdown');
      const trigger = dropdown && dropdown.querySelector('.inbox-dropdown__trigger');
      const isOpen = menu.classList.contains('is-open');
      document.querySelectorAll('.inbox-dropdown-menu.is-open').forEach(function (el) {
        if (el !== menu) closeInboxMenu(el);
      });
      if (isOpen) {
        closeInboxMenu(menu);
      } else {
        openInboxMenu(menu, trigger);
      }
    } catch (_) {}
    return false;
  };

  document.addEventListener('click', function (evt) {
    if (evt.target.closest('.inbox-dropdown')) return;
    document.querySelectorAll('.inbox-dropdown-menu.is-open').forEach(closeInboxMenu);
  });

  document.addEventListener('keydown', function (evt) {
    if (evt.key === 'Escape') {
      closeNameModal();
      closeImageModal();
      document.querySelectorAll('.inbox-dropdown-menu.is-open').forEach(closeInboxMenu);
    }
  });

  document.addEventListener('DOMContentLoaded', function () {
    const searchInput = document.querySelector('input[name="q"]');
    const searchForm = document.querySelector('.search-form');
    if (searchInput) {
      searchInput.addEventListener('focus', showSearchSuggestions);
      searchInput.addEventListener('blur', function () {
        setTimeout(hideSearchSuggestions, 200);
      });
      searchInput.addEventListener('input', function () {
        if (this.value.trim() === '') {
          showSearchSuggestions();
        } else {
          hideSearchSuggestions();
        }
      });
    }
    if (searchForm && searchInput) {
      searchForm.addEventListener('submit', function () {
        const query = searchInput.value.trim();
        if (query) saveSearchHistory(query);
      });
    }
  });

  (async function checkAuthOnLoad() {
    try {
      const r = await fetch('/auth/status', { credentials: 'include', headers: { Accept: 'application/json' } });
      const j = await r.json();
      if (!j.signedIn) {
        window.location = '/auth';
        return;
      }
    } catch (e) {
      console.warn('Auth status check failed (non-fatal):', e);
    }
    setTimeout(checkWaTokenAndPrompt, 150);
  })();
})();
