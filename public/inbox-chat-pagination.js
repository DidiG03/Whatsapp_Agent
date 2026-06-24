(function () {
  function initChatPagination() {
    const container = document.getElementById('chatThreadMessages');
    if (!container) return;

    const loadOlderBtn = document.getElementById('chatLoadOlderBtn');
    const loadOlderWrap = document.getElementById('chatThreadLoadOlder');
    let loading = false;

    async function loadOlder() {
      if (loading) return;
      if (container.dataset.hasMore !== '1') return;

      const phone = container.dataset.phone;
      const beforeTs = container.dataset.oldestTs;
      if (!phone || !beforeTs) return;

      loading = true;
      if (loadOlderBtn) {
        loadOlderBtn.disabled = true;
        loadOlderBtn.textContent = 'Loading…';
      }

      try {
        const url = `/api/inbox/${encodeURIComponent(phone)}/messages?before_ts=${encodeURIComponent(beforeTs)}`;
        const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
        const j = await r.json();
        if (!r.ok || !j.success) throw new Error((j && j.error) || 'Failed to load messages');

        const prevHeight = container.scrollHeight;
        const prevScroll = container.scrollTop;
        const anchor = container.querySelector('[data-thread-anchor]');
        const insertBefore = loadOlderWrap ? loadOlderWrap.nextSibling : anchor;

        const temp = document.createElement('div');
        temp.innerHTML = j.html || '';
        Array.from(temp.children).forEach((node) => {
          container.insertBefore(node, insertBefore);
        });

        if (j.oldestTs != null) container.dataset.oldestTs = String(j.oldestTs);
        container.dataset.hasMore = j.hasMore ? '1' : '0';
        if (!j.hasMore && loadOlderWrap) loadOlderWrap.hidden = true;

        const newHeight = container.scrollHeight;
        container.scrollTop = prevScroll + (newHeight - prevHeight);
      } catch (e) {
        console.warn('Load older messages failed:', e);
      } finally {
        loading = false;
        if (loadOlderBtn) {
          loadOlderBtn.disabled = false;
          loadOlderBtn.textContent = 'Load older messages';
        }
      }
    }

    if (loadOlderBtn) loadOlderBtn.addEventListener('click', loadOlder);

    container.addEventListener('scroll', function () {
      if (container.dataset.hasMore !== '1' || loading) return;
      if (container.scrollTop < 80) loadOlder();
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatPagination);
  } else {
    initChatPagination();
  }
})();
