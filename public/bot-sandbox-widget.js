(function () {
  if (window.__BOT_SANDBOX_WIDGET__) return;
  window.__BOT_SANDBOX_WIDGET__ = true;

  const WA_SVG = `<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`;

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatTime(ts) {
    try {
      return new Date(ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  class BotSandboxWidget {
    constructor() {
      this.open = false;
      this.busy = false;
      this.history = [];
      this.businessName = "";
      this.root = null;
      this.panel = null;
      this.messagesEl = null;
      this.inputEl = null;
      this.titleEl = null;
    }

    fetchApi(url, options) {
      const auth = window.authManager;
      if (auth?.authenticatedFetch) {
        return auth.authenticatedFetch(url, options);
      }
      return fetch(url, { ...options, credentials: "include" });
    }

    mount() {
      if (!document.querySelector(".layout")) return;
      if (document.getElementById("bot-sandbox-root")) return;

      const root = document.createElement("div");
      root.id = "bot-sandbox-root";
      root.className = "bot-sandbox";
      root.innerHTML = `
        <button type="button" class="bot-sandbox-fab" aria-label="Open bot preview" title="Test your bot">
          ${WA_SVG}
        </button>
        <div class="bot-sandbox-panel" hidden>
          <header class="bot-sandbox-header">
            <div class="bot-sandbox-header__info">
              <div class="bot-sandbox-header__avatar" aria-hidden="true">${WA_SVG}</div>
              <div>
                <div class="bot-sandbox-header__title">Bot preview</div>
                <div class="bot-sandbox-header__subtitle">Sandbox — not sent to WhatsApp</div>
              </div>
            </div>
            <div class="bot-sandbox-header__actions">
              <button type="button" class="bot-sandbox-icon-btn" data-action="reset" title="Reset conversation" aria-label="Reset conversation">↺</button>
              <button type="button" class="bot-sandbox-icon-btn" data-action="close" title="Close" aria-label="Close preview">×</button>
            </div>
          </header>
          <div class="bot-sandbox-messages" role="log" aria-live="polite"></div>
          <form class="bot-sandbox-composer">
            <input type="text" class="bot-sandbox-input" placeholder="Type a message…" autocomplete="off" maxlength="2000" />
            <button type="submit" class="bot-sandbox-send" aria-label="Send">➤</button>
          </form>
        </div>
      `;

      document.body.appendChild(root);
      this.root = root;
      this.panel = root.querySelector(".bot-sandbox-panel");
      this.messagesEl = root.querySelector(".bot-sandbox-messages");
      this.inputEl = root.querySelector(".bot-sandbox-input");
      this.titleEl = root.querySelector(".bot-sandbox-header__title");

      root.querySelector(".bot-sandbox-fab").addEventListener("click", () => this.toggle());
      root.querySelector('[data-action="close"]').addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setOpen(false);
      });
      root.querySelector('[data-action="reset"]').addEventListener("click", () => this.reset());
      root.querySelector(".bot-sandbox-composer").addEventListener("submit", (e) => {
        e.preventDefault();
        this.sendMessage();
      });

      this.renderEmptyState();
    }

    renderEmptyState() {
      if (!this.messagesEl || this.history.length) return;
      this.messagesEl.innerHTML = `
        <div class="bot-sandbox-empty">
          <p>Chat here to test your bot exactly as a customer would.</p>
          <p class="bot-sandbox-empty__hint">Messages stay in this sandbox — nothing is sent to WhatsApp.</p>
        </div>
      `;
    }

    setOpen(next) {
      this.open = !!next;
      if (!this.panel) return;
      this.panel.hidden = !this.open;
      this.root?.classList.toggle("bot-sandbox--open", this.open);
      if (this.open) {
        setTimeout(() => this.inputEl?.focus(), 80);
      }
    }

    toggle() {
      this.setOpen(!this.open);
    }

    scrollToBottom() {
      if (!this.messagesEl) return;
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }

    appendUserBubble(text) {
      const empty = this.messagesEl.querySelector(".bot-sandbox-empty");
      if (empty) empty.remove();
      const el = document.createElement("div");
      el.className = "bot-sandbox-msg bot-sandbox-msg--out";
      el.innerHTML = `
        <div class="bot-sandbox-bubble bot-sandbox-bubble--out">${escapeHtml(text)}</div>
        <time class="bot-sandbox-time">${formatTime()}</time>
      `;
      this.messagesEl.appendChild(el);
      this.scrollToBottom();
    }

    appendBotReplies(replies) {
      const list = Array.isArray(replies) ? replies : [];
      for (const reply of list) {
        const wrap = document.createElement("div");
        wrap.className = "bot-sandbox-msg bot-sandbox-msg--in";

        if (reply.type === "buttons") {
          const buttons = (reply.buttons || []).slice(0, 3);
          wrap.innerHTML = `
            <div class="bot-sandbox-bubble bot-sandbox-bubble--in">${escapeHtml(reply.body || "")}</div>
            <div class="bot-sandbox-actions"></div>
            <time class="bot-sandbox-time">${formatTime(reply.timestamp)}</time>
          `;
          const actions = wrap.querySelector(".bot-sandbox-actions");
          buttons.forEach((btn) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "bot-sandbox-action-btn";
            b.textContent = btn.title || btn.id || "Option";
            b.addEventListener("click", () => this.sendInteractive(btn.id, btn.title || btn.id, "button"));
            actions.appendChild(b);
          });
          const bodyText = String(reply.body || "").trim();
          if (bodyText) {
            this.history.push({ role: "assistant", content: bodyText });
          }
        } else if (reply.type === "list") {
          const options = (reply.options || []).slice(0, 10);
          const header = [reply.header, reply.body].filter(Boolean).join("\n");
          wrap.innerHTML = `
            <div class="bot-sandbox-bubble bot-sandbox-bubble--in">${escapeHtml(header)}</div>
            <div class="bot-sandbox-actions"></div>
            <time class="bot-sandbox-time">${formatTime(reply.timestamp)}</time>
          `;
          const actions = wrap.querySelector(".bot-sandbox-actions");
          options.forEach((row) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "bot-sandbox-action-btn bot-sandbox-action-btn--list";
            b.textContent = row.title || row.id || "Option";
            b.addEventListener("click", () => this.sendInteractive(row.id, row.title || row.id, "list"));
            actions.appendChild(b);
          });
          if (header.trim()) {
            this.history.push({ role: "assistant", content: header.trim() });
          }
        } else if (reply.type === "location") {
          const label = reply.address || reply.name || "Location";
          wrap.innerHTML = `
            <div class="bot-sandbox-bubble bot-sandbox-bubble--in bot-sandbox-bubble--location">
              <span class="bot-sandbox-pin">📍</span> ${escapeHtml(label)}
            </div>
            <time class="bot-sandbox-time">${formatTime(reply.timestamp)}</time>
          `;
          this.history.push({ role: "assistant", content: `📍 ${label}` });
        } else {
          const body = String(reply.body || "").trim();
          if (!body) continue;
          wrap.innerHTML = `
            <div class="bot-sandbox-bubble bot-sandbox-bubble--in">${escapeHtml(body)}</div>
            <time class="bot-sandbox-time">${formatTime(reply.timestamp)}</time>
          `;
          this.history.push({ role: "assistant", content: body });
        }

        this.messagesEl.appendChild(wrap);
      }
      this.scrollToBottom();
    }

    setBusy(busy) {
      this.busy = !!busy;
      if (this.inputEl) this.inputEl.disabled = this.busy;
      this.root?.classList.toggle("bot-sandbox--busy", this.busy);
    }

    async sendMessage(textOverride) {
      const text = String(textOverride ?? this.inputEl?.value ?? "").trim();
      if (!text || this.busy) return;

      if (this.inputEl && textOverride == null) this.inputEl.value = "";
      this.appendUserBubble(text);
      this.history.push({ role: "user", content: text });
      this.setBusy(true);

      try {
        const res = await this.fetchApi("/api/sandbox/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, history: this.history.slice(0, -1) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || "Request failed");
        }
        if (data.businessName) {
          this.businessName = data.businessName;
          if (this.titleEl) {
            this.titleEl.textContent = data.businessName || "Bot preview";
          }
        }
        this.appendBotReplies(data.replies);
      } catch (err) {
        const el = document.createElement("div");
        el.className = "bot-sandbox-msg bot-sandbox-msg--in";
        el.innerHTML = `<div class="bot-sandbox-bubble bot-sandbox-bubble--error">Could not reach the bot. Try again.</div>`;
        this.messagesEl.appendChild(el);
        this.scrollToBottom();
      } finally {
        this.setBusy(false);
      }
    }

    async sendInteractive(interactiveId, title, interactiveType) {
      if (!interactiveId || this.busy) return;
      const label = String(title || interactiveId).trim();
      this.appendUserBubble(label);
      this.history.push({ role: "user", content: label });
      this.setBusy(true);

      try {
        const res = await this.fetchApi("/api/sandbox/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: label,
            interactiveId,
            interactiveType,
            history: this.history.slice(0, -1),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Request failed");
        if (data.businessName && this.titleEl) {
          this.titleEl.textContent = data.businessName || "Bot preview";
        }
        this.appendBotReplies(data.replies);
      } catch {
        const el = document.createElement("div");
        el.className = "bot-sandbox-msg bot-sandbox-msg--in";
        el.innerHTML = `<div class="bot-sandbox-bubble bot-sandbox-bubble--error">Could not reach the bot. Try again.</div>`;
        this.messagesEl.appendChild(el);
        this.scrollToBottom();
      } finally {
        this.setBusy(false);
      }
    }

    async reset() {
      if (this.busy) return;
      this.setBusy(true);
      try {
        await this.fetchApi("/api/sandbox/reset", { method: "POST" });
      } catch {}
      this.history = [];
      if (this.messagesEl) this.messagesEl.innerHTML = "";
      this.renderEmptyState();
      this.setBusy(false);
    }
  }

  function init() {
    const widget = new BotSandboxWidget();
    widget.mount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
