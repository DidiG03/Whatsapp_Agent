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
    filters.style.display = open ? 'flex' : 'none';
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

  function messagePreviewText(data) {
    const body = String(data?.text_body || '').trim();
    if (body) return body;
    const type = String(data?.type || 'text');
    if (type === 'image') return '📷 Image';
    if (type === 'audio') return '🎤 Voice message';
    if (type === 'document') return '📄 Document';
    if (type === 'video') return '🎬 Video';
    return 'New message';
  }

  function formatInboxListTime(ts) {
    const n = Number(ts || 0);
    if (!n) return '';
    try {
      const d = n > 1e12 ? new Date(n) : new Date(n * 1000);
      const now = new Date();
      const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (d >= startToday) {
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      }
      return d.toLocaleDateString();
    } catch (_) {
      return '';
    }
  }

  function normalizeDigits(phone) {
    return String(phone || '').replace(/\D/g, '');
  }

  function digitsMatch(a, b) {
    const da = normalizeDigits(a);
    const db = normalizeDigits(b);
    if (!da || !db) return false;
    if (da === db) return true;
    const minLen = Math.min(da.length, db.length);
    return minLen >= 8 && da.slice(-minLen) === db.slice(-minLen);
  }

  function findInboxRow(digits) {
    const list = document.getElementById('inboxConversationListItems');
    if (!list || !digits) return null;
    let found = null;
    list.querySelectorAll('.inbox-item').forEach(function (li) {
      if (found) return;
      const link = li.querySelector('a.inbox-item__link');
      if (!link) return;
      const hrefDigits = normalizeDigits(link.getAttribute('href') || '');
      if (digitsMatch(hrefDigits, digits)) found = li;
    });
    return found;
  }

  function removeInboxEmptyState() {
    const empty = document.querySelector('.empty-state-pro');
    if (empty) empty.remove();
  }

  function updateInboxRowPreview(row, data) {
    if (!row || !data) return;
    const preview = messagePreviewText(data);
    const previewEl = row.querySelector('.inbox-item__preview');
    if (previewEl) {
      previewEl.textContent = preview.length > 60 ? `${preview.slice(0, 57)}...` : preview;
    }
    const timeEl = row.querySelector('.inbox-item__time');
    if (timeEl) {
      timeEl.textContent = formatInboxListTime(data.timestamp) || timeEl.textContent;
    }
    if (data.direction === 'inbound') {
      row.classList.add('inbox-item--unread');
    }
  }

  function moveInboxRowToTop(row) {
    const list = document.getElementById('inboxConversationListItems');
    if (!list || !row) return;
    const firstItem = list.querySelector('.inbox-item');
    if (firstItem && firstItem !== row) {
      list.insertBefore(row, firstItem);
    }
  }

  function getInboxListShell() {
    return document.getElementById('inboxConversationList');
  }

  function buildInboxListQueryParams(extra) {
    const shell = getInboxListShell();
    const params = new URLSearchParams(extra || {});
    if (shell) {
      if (shell.dataset.filter && shell.dataset.filter !== 'all' && !params.has('filter')) {
        params.set('filter', shell.dataset.filter);
      }
      if (shell.dataset.archived === '1' && !params.has('archived')) {
        params.set('archived', '1');
      }
    }
    return params;
  }

  async function fetchAndInsertInboxRow(digits, data) {
    const shell = getInboxListShell();
    const list = document.getElementById('inboxConversationListItems');
    if (!list) return null;
    if (shell && shell.dataset.q) return null;

    const params = buildInboxListQueryParams({ phone: digits });
    try {
      const r = await fetch(`/api/inbox/contacts/row?${params.toString()}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const j = await r.json();
      if (!r.ok || !j.success || !j.visible || !j.html) return null;
      const temp = document.createElement('ul');
      temp.innerHTML = j.html;
      const li = temp.querySelector('.inbox-item');
      if (!li) return null;
      removeInboxEmptyState();
      const firstItem = list.querySelector('.inbox-item');
      if (firstItem) list.insertBefore(li, firstItem);
      else list.appendChild(li);
      updateInboxRowPreview(li, data);
      return li;
    } catch (e) {
      console.warn('Failed to fetch inbox row:', e);
      return null;
    }
  }

  function initInboxListRealtimePreview() {
    const list = document.getElementById('inboxConversationListItems');
    if (!list) return;

    async function onNewMessage(data) {
      if (!data) return;
      const phone = data.phone || data.contact
        || (data.direction === 'inbound' ? data.from_digits : data.to_digits);
      const digits = normalizeDigits(phone);
      if (!digits) return;

      let row = findInboxRow(digits);
      if (!row) {
        row = await fetchAndInsertInboxRow(digits, data);
        if (!row) return;
      } else {
        updateInboxRowPreview(row, data);
        moveInboxRowToTop(row);
      }
    }

    function hookRealtime() {
      const mgr = window.realtimeManager;
      if (!mgr || typeof mgr.onGlobal !== 'function') return false;
      mgr.onGlobal('new_message', onNewMessage);
      return true;
    }

    if (!hookRealtime()) {
      let tries = 0;
      const timer = setInterval(function () {
        if (hookRealtime() || ++tries > 40) clearInterval(timer);
      }, 250);
    }
  }

  function initInboxListPollingFallback() {
    const shell = getInboxListShell();
    const list = document.getElementById('inboxConversationListItems');
    if (!list) return;
    if (shell && shell.dataset.q) return;

    let pollTimer = null;
    const POLL_MS = 15000;

    async function refreshHead() {
      if (document.hidden) return;
      if (!shell || shell.dataset.infiniteScroll !== '1') return;

      const params = buildInboxListQueryParams({
        page: '1',
        page_size: shell.dataset.pageSize || '20',
      });

      try {
        const r = await fetch(`/api/inbox/contacts?${params.toString()}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        const j = await r.json();
        if (!r.ok || !j.success || !j.html) return;

        const temp = document.createElement('ul');
        temp.innerHTML = j.html;
        const newRows = Array.from(temp.querySelectorAll('.inbox-item'));
        newRows.forEach(function (newRow) {
          const link = newRow.querySelector('a.inbox-item__link');
          const d = normalizeDigits(link && link.getAttribute('href'));
          const existingRow = findInboxRow(d);
          if (existingRow) {
            const previewEl = existingRow.querySelector('.inbox-item__preview');
            const newPreview = newRow.querySelector('.inbox-item__preview');
            if (previewEl && newPreview) previewEl.innerHTML = newPreview.innerHTML;
            const timeEl = existingRow.querySelector('.inbox-item__time');
            const newTime = newRow.querySelector('.inbox-item__time');
            if (timeEl && newTime) timeEl.textContent = newTime.textContent;
            const unreadEl = newRow.querySelector('.inbox-item__unread, .inbox-item__dot');
            const existingUnread = existingRow.querySelector('.inbox-item__unread, .inbox-item__dot');
            if (unreadEl && !existingUnread) {
              const title = existingRow.querySelector('.inbox-item__title');
              if (title) title.appendChild(unreadEl.cloneNode(true));
            }
            if (newRow.classList.contains('inbox-item--unread')) {
              existingRow.classList.add('inbox-item--unread');
            }
            moveInboxRowToTop(existingRow);
          } else {
            removeInboxEmptyState();
            const firstItem = list.querySelector('.inbox-item');
            if (firstItem) list.insertBefore(newRow, firstItem);
            else list.appendChild(newRow);
          }
        });
      } catch (e) {
        console.warn('Inbox poll refresh failed:', e);
      }
    }

    function startPolling() {
      if (pollTimer) return;
      pollTimer = setInterval(refreshHead, POLL_MS);
    }

    function maybeStartPolling() {
      const mgr = window.realtimeManager;
      if (mgr && mgr.realtimeAvailable && mgr.isConnected) return;
      startPolling();
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshHead();
    });

    setTimeout(maybeStartPolling, 8000);

    (async function () {
      const mgr = window.realtimeManager;
      if (!mgr) {
        startPolling();
        return;
      }
      try {
        if (typeof mgr.ensureRealtimeAvailable === 'function') {
          await mgr.ensureRealtimeAvailable();
        }
        if (!mgr.realtimeAvailable || !mgr.isConnected) {
          startPolling();
        }
      } catch (_) {
        startPolling();
      }
    })();
  }

  function initInboxListInfiniteScroll() {
    const shell = document.getElementById('inboxConversationList');
    const list = document.getElementById('inboxConversationListItems');
    const status = document.getElementById('inboxListStatus');
    const statusText = document.getElementById('inboxListStatusText');
    if (!shell || shell.dataset.infiniteScroll !== '1' || !list) return;

    let loading = false;
    let page = parseInt(shell.dataset.page || '1', 10) || 1;

    function hasMore() {
      return shell.dataset.hasMore === '1';
    }

    function buildUrl(nextPage) {
      const params = new URLSearchParams();
      params.set('page', String(nextPage));
      params.set('page_size', shell.dataset.pageSize || '20');
      if (shell.dataset.filter && shell.dataset.filter !== 'all') params.set('filter', shell.dataset.filter);
      if (shell.dataset.archived === '1') params.set('archived', '1');
      return `/api/inbox/contacts?${params.toString()}`;
    }

    async function loadMore() {
      if (loading || !hasMore()) return;
      loading = true;
      if (status) status.classList.add('is-loading');
      if (statusText) statusText.textContent = 'Loading more…';

      try {
        const nextPage = page + 1;
        const r = await fetch(buildUrl(nextPage), {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        const j = await r.json();
        if (!r.ok || !j.success) throw new Error((j && j.error) || 'Failed to load conversations');

        if (j.html) {
          const temp = document.createElement('ul');
          temp.innerHTML = j.html;
          Array.from(temp.children).forEach(function (li) {
            list.appendChild(li);
          });
        }

        page = nextPage;
        shell.dataset.page = String(page);
        shell.dataset.hasMore = j.hasMore ? '1' : '0';

        if (!j.hasMore && status) {
          status.hidden = true;
        } else if (statusText) {
          statusText.textContent = 'Scroll for more conversations';
        }
      } catch (e) {
        console.warn('Inbox list load more failed:', e);
        if (statusText) statusText.textContent = 'Could not load more. Scroll to retry.';
      } finally {
        loading = false;
        if (status) status.classList.remove('is-loading');
      }
    }

    shell.addEventListener('scroll', function () {
      if (!hasMore() || loading) return;
      const nearBottom = shell.scrollTop + shell.clientHeight >= shell.scrollHeight - 120;
      if (nearBottom) loadMore();
    }, { passive: true });
  }

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
    initInboxListInfiniteScroll();
    initInboxListRealtimePreview();
    initInboxListPollingFallback();
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
