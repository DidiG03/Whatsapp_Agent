import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import {
  renderSidebar,
  renderTopbar,
  renderPageHeader,
  renderTranscriptAsBubbles,
  escapeHtml,
  getProfessionalHead,
} from "../utils.mjs";
import { getSettingsForUser, upsertSettingsForUser, isBookingsEnabled } from "../services/settings.mjs";
import { getPlanStatus } from "../services/usage.mjs";
import { refiningCoachReply, isRefiningSuggestionRequest } from "../services/ai.mjs";
import { retrieveCoachKbContext } from "../services/kb.mjs";
import { buildCoachBusinessContext } from "../services/coachContext.mjs";
import { parseRefiningDirectives, applyRefiningDirectives, removeRuleAtIndex, clearAllRefiningRules, listRefiningRules } from "../services/refiningDirectives.mjs";
import { mergeEnforcedRules, removeEnforcedRulesMatchingNeedle } from "../services/refiningEnforcement.mjs";
import { getBookingFieldsFromSettings, listBookingFieldsSummary, removeBookingFieldFromSettings } from "../services/bookingFields.mjs";

function parseRulesList(rulesText = "") {
  return String(rulesText || "")
    .split(/\n+/)
    .map((line) => line.replace(/^[\-\d.)\s]+/, "").trim())
    .filter(Boolean);
}

function renderBookingFields(settings = {}) {
  const fields = listBookingFieldsSummary(settings);
  if (!fields.length) {
    return `<p class="refining-rules__empty">Default booking questions apply (based on business type).</p>`;
  }
  const items = fields
    .map((f) => {
      const canRemove = String(f.id || "").toLowerCase() !== "name";
      const removeBtn = canRemove
        ? `<button
          type="button"
          class="refining-rules__remove"
          data-field-id="${escapeHtml(f.id)}"
          aria-label="Remove booking question"
          title="Remove booking question"
        >
          <span aria-hidden="true">×</span>
        </button>`
        : "";
      return `
      <li class="refining-rules__item refining-rules__item--field">
        <div class="refining-rules__field-body">
          <p class="refining-rules__text"><strong>${escapeHtml(f.label)}</strong>${f.required ? "" : " <span class=\"small\">(optional)</span>"}</p>
          <p class="small" style="margin:4px 0 0;color:var(--muted,#666);">${escapeHtml(f.prompt)}</p>
        </div>
        ${removeBtn}
      </li>`;
    })
    .join("");
  return `<ol class="refining-rules__list">${items}</ol>`;
}

function renderActiveRules(rulesText = "") {
  const rules = parseRulesList(rulesText);
  if (!rules.length) {
    return `<p class="refining-rules__empty">No active rules yet. Instructions you give the coach will appear here and apply to live WhatsApp chats.</p>`;
  }
  const items = rules
    .map((rule, index) => `
      <li class="refining-rules__item">
        <p class="refining-rules__text">${escapeHtml(rule)}</p>
        <button
          type="button"
          class="refining-rules__remove"
          data-rule-index="${index}"
          aria-label="Remove rule"
          title="Remove rule"
        >
          <span aria-hidden="true">×</span>
        </button>
      </li>`)
    .join("");
  return `<ol class="refining-rules__list">${items}</ol>`;
}

function renderRulesHeaderActions(rulesText = "") {
  const count = parseRulesList(rulesText).length;
  return `<button type="button" class="btn btn-ghost btn-sm refining-rules__clear" id="refining-clear-all"${count ? "" : " hidden"}>Clear all</button>`;
}

function hasRefiningTranscript(transcript = "") {
  return String(transcript || "").trim().length > 0;
}

function renderRefiningEmptyChat() {
  return `<div class="refining-empty">
          <p class="refining-empty__title">Start a coaching session</p>
          <p class="refining-empty__hint">Describe how your WhatsApp bot should behave, ask for suggestions, or refine rules.</p>
        </div>`;
}

function renderChatHeaderActions(transcript = "") {
  return `<button type="button" class="btn btn-ghost btn-sm refining-chat__clear" id="refining-clear-chat"${hasRefiningTranscript(transcript) ? "" : " hidden"}>Clear chat</button>`;
}

function renderRulesBadge(rulesText = "") {
  const count = parseRulesList(rulesText).length;
  return count
    ? `<span class="refining-rules__count">${count}</span>`
    : `<span class="refining-rules__count refining-rules__count--empty">0</span>`;
}

export default function registerRefiningRoutes(app) {
  app.get("/refining", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const email = await getSignedInEmail(req);
    const { isUpgraded } = await getPlanStatus(userId);
    const settings = await getSettingsForUser(userId);
    const transcript = settings?.refining_transcript || "";
    const rules = settings?.ai_refining_rules || "";
    const chatHtml = transcript.trim()
      ? renderTranscriptAsBubbles(transcript)
      : renderRefiningEmptyChat();

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.end(`
      <html>${getProfessionalHead("Refining", { sandbox: true, csrfToken: res.locals.csrfToken || '' })}<body class="refining-page">
        <div class="container">
          ${renderTopbar("Refining", email)}
          <div class="layout">
            ${renderSidebar("refining", { showBookings: !!isUpgraded, isUpgraded })}
            <main class="main">
              <div class="main-content refining-content">
                <div class="refining-shell">
                  <div class="refining-layout" id="refining-layout">
                    <section class="refining-panel refining-panel--chat" aria-label="Refining chat">
                      <header class="refining-panel__header">
                        <div>
                          <h2 class="refining-panel__title">Coach chat</h2>
                        </div>
                        ${renderChatHeaderActions(transcript)}
                      </header>
                      <div id="refining-transcript" class="refining-chat-box">${chatHtml}</div>
                      <form id="refining-form" class="refining-composer" novalidate>
                        <label class="refining-visually-hidden" for="refining-input">Instruction for the bot coach</label>
                        <textarea
                          id="refining-input"
                          class="refining-input"
                          name="message"
                          rows="1"
                          placeholder="e.g. For groups over 30, ask customers to call us instead of booking by message…"
                          aria-describedby="refining-input-hint"
                        ></textarea>
                        <button type="submit" class="btn btn-primary refining-send" id="refining-send">Send</button>
                      </form>
                    </section>
                    <div class="refining-rules-drawer" id="refining-rules-drawer">
                      <button
                        type="button"
                        class="refining-rules-drawer__toggle"
                        id="refining-rules-drawer-toggle"
                        aria-label="Hide rules panel"
                        aria-expanded="true"
                        aria-controls="refining-rules-panel"
                        title="Hide rules panel"
                      >
                        <svg class="refining-rules-drawer__icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                          <path d="M10 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                      </button>
                      <div class="refining-rules-drawer__track">
                      <aside id="refining-rules-panel" class="refining-panel refining-panel--rules" aria-label="Active bot rules">
                      <header class="refining-panel__header refining-panel__header--rules">
                        <div>
                          <h2 class="refining-panel__title">Active rules ${renderRulesBadge(rules)}</h2>
                        </div>
                        ${renderRulesHeaderActions(rules)}
                      </header>
                      <div id="refining-rules" class="refining-rules__body">${renderActiveRules(rules)}</div>
                      <header class="refining-panel__header refining-panel__header--rules" style="margin-top:20px;">
                        <div>
                          <h2 class="refining-panel__title">Booking questions</h2>
                        </div>
                      </header>
                      <div id="refining-booking-fields" class="refining-rules__body">${renderBookingFields(settings)}</div>
                      </aside>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </main>
          </div>
        </div>
        <script>
          (function () {
            const form = document.getElementById("refining-form");
            const input = document.getElementById("refining-input");
            const sendBtn = document.getElementById("refining-send");
            const transcriptEl = document.getElementById("refining-transcript");
            const rulesEl = document.getElementById("refining-rules");
            const bookingFieldsEl = document.getElementById("refining-booking-fields");
            const sendLabel = sendBtn?.textContent || "Send";
            const INPUT_MIN_HEIGHT = 48;
            const layoutEl = document.getElementById("refining-layout");
            const drawerToggle = document.getElementById("refining-rules-drawer-toggle");
            const RULES_PANEL_STORAGE_KEY = "refining-rules-panel-collapsed";

            function setRulesPanelCollapsed(collapsed) {
              if (!layoutEl || !drawerToggle) return;
              layoutEl.classList.toggle("is-rules-collapsed", collapsed);
              drawerToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
              drawerToggle.setAttribute("aria-label", collapsed ? "Show rules panel" : "Hide rules panel");
              drawerToggle.title = collapsed ? "Show rules panel" : "Hide rules panel";
              try {
                localStorage.setItem(RULES_PANEL_STORAGE_KEY, collapsed ? "1" : "0");
              } catch {}
            }

            function isRulesPanelCollapsed() {
              try {
                return localStorage.getItem(RULES_PANEL_STORAGE_KEY) === "1";
              } catch {
                return false;
              }
            }

            drawerToggle?.addEventListener("click", function () {
              setRulesPanelCollapsed(!layoutEl.classList.contains("is-rules-collapsed"));
            });

            if (isRulesPanelCollapsed()) {
              setRulesPanelCollapsed(true);
            }

            function notify(message, type) {
              if (window.Toast && typeof window.Toast.show === "function") {
                window.Toast.show(message, type || "info");
                return;
              }
              alert(message);
            }

            function updateRulesBadge() {
              const badge = document.querySelector(".refining-rules__count");
              if (!badge || !rulesEl) return;
              const count = rulesEl.querySelectorAll(".refining-rules__item").length;
              badge.textContent = String(count);
              badge.classList.toggle("refining-rules__count--empty", count === 0);
              if (count === 0 && !rulesEl.querySelector(".refining-rules__empty")) {
                rulesEl.innerHTML = '<p class="refining-rules__empty">No active rules yet. Instructions you give the coach will appear here and apply to live WhatsApp chats.</p>';
              }
              const clearBtn = document.getElementById("refining-clear-all");
              if (clearBtn) clearBtn.hidden = count === 0;
            }

            async function removeRule(index, { clearAll = false } = {}) {
              const resp = await fetch("/api/refining/rules/remove", {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                credentials: "include",
                body: JSON.stringify(clearAll ? { clearAll: true } : { index }),
              });
              const data = await resp.json().catch(() => ({}));
              if (!resp.ok) throw new Error(data.error || "Could not remove rule.");
              if (data.rulesHtml) rulesEl.innerHTML = data.rulesHtml;
              updateRulesBadge();
              notify(clearAll ? "All rules removed." : "Rule removed.", "success");
            }

            function updateClearChatButton() {
              const btn = document.getElementById("refining-clear-chat");
              if (!btn || !transcriptEl) return;
              btn.hidden = !!transcriptEl.querySelector(".refining-empty");
            }

            document.getElementById("refining-clear-chat")?.addEventListener("click", async function () {
              if (!confirm("Clear the coach chat history? Your active rules will stay saved.")) return;
              const btn = this;
              btn.disabled = true;
              try {
                const resp = await fetch("/api/refining/chat/clear", {
                  method: "POST",
                  headers: { Accept: "application/json" },
                  credentials: "include",
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) throw new Error(data.error || "Could not clear chat.");
                if (data.transcriptHtml) transcriptEl.innerHTML = data.transcriptHtml;
                updateClearChatButton();
                notify("Chat cleared.", "success");
                input?.focus();
              } catch (err) {
                notify(err?.message || "Could not clear chat.", "error");
              } finally {
                btn.disabled = false;
              }
            });

            rulesEl?.addEventListener("click", async function (e) {
              const btn = e.target.closest(".refining-rules__remove");
              if (!btn || btn.disabled) return;
              e.preventDefault();
              const index = Number(btn.getAttribute("data-rule-index"));
              if (!Number.isInteger(index) || index < 0) return;
              btn.disabled = true;
              try {
                await removeRule(index);
              } catch (err) {
                notify(err?.message || "Could not remove rule.", "error");
                btn.disabled = false;
              }
            });

            document.getElementById("refining-clear-all")?.addEventListener("click", async function () {
              if (!confirm("Remove all active rules?")) return;
              const btn = this;
              btn.disabled = true;
              try {
                await removeRule(-1, { clearAll: true });
              } catch (err) {
                notify(err?.message || "Could not clear rules.", "error");
              } finally {
                btn.disabled = false;
              }
            });

            async function removeBookingField(fieldId) {
              const resp = await fetch("/api/refining/booking-fields/remove", {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                credentials: "include",
                body: JSON.stringify({ id: fieldId }),
              });
              const data = await resp.json().catch(() => ({}));
              if (!resp.ok) throw new Error(data.error || "Could not remove booking question.");
              if (data.bookingFieldsHtml && bookingFieldsEl) {
                bookingFieldsEl.innerHTML = data.bookingFieldsHtml;
              }
              notify("Booking question removed.", "success");
            }

            bookingFieldsEl?.addEventListener("click", async function (e) {
              const btn = e.target.closest(".refining-rules__remove[data-field-id]");
              if (!btn || btn.disabled) return;
              e.preventDefault();
              const fieldId = btn.getAttribute("data-field-id");
              if (!fieldId) return;
              if (!confirm("Remove this booking question? The bot will stop asking it during reservations.")) return;
              btn.disabled = true;
              try {
                await removeBookingField(fieldId);
              } catch (err) {
                notify(err?.message || "Could not remove booking question.", "error");
                btn.disabled = false;
              }
            });

            function scrollChatToBottom() {
              if (!transcriptEl) return;
              transcriptEl.scrollTop = transcriptEl.scrollHeight;
            }

            function ensureChatContainer() {
              const empty = transcriptEl.querySelector(".refining-empty");
              if (empty) empty.remove();
              let chat = transcriptEl.querySelector(".chat");
              if (!chat) {
                transcriptEl.innerHTML = '<div class="chat"></div>';
                chat = transcriptEl.querySelector(".chat");
              }
              return chat;
            }

            function appendUserBubble(text) {
              const chat = ensureChatContainer();
              const row = document.createElement("div");
              row.className = "row user";
              const bubble = document.createElement("div");
              bubble.className = "bubble user";
              String(text || "").split("\\n").forEach(function (line, index) {
                if (index > 0) bubble.appendChild(document.createElement("br"));
                bubble.appendChild(document.createTextNode(line));
              });
              row.appendChild(bubble);
              chat.appendChild(row);
              updateClearChatButton();
            }

            function showTypingIndicator() {
              removeTypingIndicator();
              const chat = ensureChatContainer();
              const row = document.createElement("div");
              row.className = "row ai refining-typing-row";
              row.id = "refining-typing-indicator";
              const bubble = document.createElement("div");
              bubble.className = "bubble ai typing-indicator";
              bubble.setAttribute("aria-live", "polite");
              const dots = document.createElement("div");
              dots.className = "typing-dots";
              dots.setAttribute("aria-label", "Coach is typing");
              for (let i = 0; i < 3; i += 1) dots.appendChild(document.createElement("span"));
              bubble.appendChild(dots);
              row.appendChild(bubble);
              chat.appendChild(row);
            }

            function removeTypingIndicator() {
              document.getElementById("refining-typing-indicator")?.remove();
            }

            function resetInputHeight() {
              if (!input) return;
              input.style.height = INPUT_MIN_HEIGHT + "px";
              form?.classList.remove("is-multiline");
            }

            function syncInputHeight() {
              if (!input) return;
              input.style.height = INPUT_MIN_HEIGHT + "px";
              const nextHeight = Math.min(Math.max(input.scrollHeight, INPUT_MIN_HEIGHT), 140);
              input.style.height = nextHeight + "px";
              form?.classList.toggle("is-multiline", nextHeight > INPUT_MIN_HEIGHT);
            }

            input?.addEventListener("input", function () {
              syncInputHeight();
              this.classList.remove("is-invalid");
            });

            input?.addEventListener("keydown", function (e) {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                form?.requestSubmit();
              }
            });

            form?.addEventListener("submit", async function (e) {
              e.preventDefault();
              const message = (input?.value || "").trim();
              if (!message) {
                input?.classList.add("is-invalid");
                notify("Please enter an instruction before sending.", "warning");
                input?.focus();
                return;
              }
              const sentMessage = message;
              input.value = "";
              resetInputHeight();
              input.classList.remove("is-invalid");
              appendUserBubble(sentMessage);
              showTypingIndicator();
              scrollChatToBottom();
              sendBtn.disabled = true;
              sendBtn.textContent = "Sending…";
              try {
                const resp = await fetch("/api/refining/message", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Accept: "application/json" },
                  credentials: "include",
                  body: JSON.stringify({ message: sentMessage }),
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) throw new Error(data.error || "Could not save your instruction.");
                removeTypingIndicator();
                if (data.transcriptHtml) transcriptEl.innerHTML = data.transcriptHtml;
                if (data.rulesHtml) {
                  rulesEl.innerHTML = data.rulesHtml;
                  updateRulesBadge();
                }
                if (data.bookingFieldsHtml && bookingFieldsEl) {
                  bookingFieldsEl.innerHTML = data.bookingFieldsHtml;
                }
                if (data.saved && data.removed) {
                  notify("Rule removed.", "success");
                } else if (data.bookingsBlocked) {
                  notify("Enable Bookings in Settings before adding booking questions.", "info");
                } else if (data.clarifying) {
                  notify("Answer the follow-up so I can save a precise rule.", "info");
                } else if (data.saved) {
                  notify("Instruction saved.", "success");
                }
                scrollChatToBottom();
                updateClearChatButton();
              } catch (err) {
                removeTypingIndicator();
                notify(err?.message || "Could not send your message. Please try again.", "error");
              } finally {
                sendBtn.disabled = false;
                sendBtn.textContent = sendLabel;
                input?.focus();
              }
            });

            scrollChatToBottom();
            updateClearChatButton();
            resetInputHeight();
            input?.focus();

            const initialMessage = new URLSearchParams(window.location.search).get("message");
            if (initialMessage && input && form) {
              input.value = initialMessage;
              syncInputHeight();
              const cleanUrl = new URL(window.location.href);
              cleanUrl.searchParams.delete("message");
              window.history.replaceState({}, "", cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
              form.requestSubmit();
            }
          })();
        </script>
      </body></html>
    `);
  });

  app.post("/api/refining/message", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const userMsg = String(req.body?.message || "").trim();
    if (!userMsg) return res.status(400).json({ error: "Message is required" });

    try {
      const settings = await getSettingsForUser(userId);
      const history = settings?.refining_transcript || "";
      const isSuggestionRequest = isRefiningSuggestionRequest(userMsg);
      const [kbContext, businessContext] = await Promise.all([
        retrieveCoachKbContext(userId, userMsg, history, { fullCatalog: isSuggestionRequest }),
        buildCoachBusinessContext(settings),
      ]);
      const coach = await refiningCoachReply(userMsg, history, {
        tone: settings?.ai_tone,
        style: settings?.ai_style,
        blockedTopics: settings?.ai_blocked_topics,
        currentRules: settings?.ai_refining_rules || "",
        kbItems: kbContext,
        businessContext: businessContext || "",
        isSuggestionRequest,
        bookingsEnabled: isBookingsEnabled(settings),
      });

      const directives = parseRefiningDirectives(coach);
      const { visible, rules, saved, needsClarification, removed, bookingsBlocked } = await applyRefiningDirectives(userId, directives);

      const newTranscript = `${history}${history ? "\n\n" : ""}You: ${userMsg}\nAI: ${visible}`;
      await upsertSettingsForUser(userId, {
        ...settings,
        refining_transcript: newTranscript,
        ai_refining_rules: rules || settings?.ai_refining_rules || null,
      });
      const updatedSettings = await getSettingsForUser(userId);

      return res.json({
        ok: true,
        reply: visible,
        saved: !!saved,
        removed: !!removed,
        bookingsBlocked: !!bookingsBlocked,
        clarifying: !!needsClarification,
        transcriptHtml: renderTranscriptAsBubbles(newTranscript),
        rulesHtml: renderActiveRules(rules),
        rulesCount: parseRulesList(rules).length,
        bookingFieldsHtml: renderBookingFields(updatedSettings),
      });
    } catch (err) {
      console.error("[refining] message error:", err?.message || err);
      return res.status(500).json({ error: "Could not process your request." });
    }
  });

  app.post("/api/refining/chat/clear", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    try {
      const settings = await getSettingsForUser(userId);
      await upsertSettingsForUser(userId, {
        ...settings,
        refining_transcript: "",
      });

      return res.json({
        ok: true,
        transcriptHtml: renderRefiningEmptyChat(),
      });
    } catch (err) {
      console.error("[refining] clear chat error:", err?.message || err);
      return res.status(500).json({ error: "Could not clear chat." });
    }
  });

  app.post("/api/refining/rules/remove", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    try {
      const settings = await getSettingsForUser(userId);
      const current = settings?.ai_refining_rules || "";
      const clearAll = !!req.body?.clearAll;

      let nextRules = current;
      let nextEnforced = settings?.ai_refining_enforced_json ?? null;
      if (clearAll) {
        nextRules = clearAllRefiningRules().rules;
        nextEnforced = mergeEnforcedRules(nextEnforced, { clearAll: true });
      } else {
        const index = Number(req.body?.index);
        const rulesList = listRefiningRules(current);
        const removedText = rulesList[index] || "";
        const result = removeRuleAtIndex(current, index);
        if (!result.ok) {
          return res.status(400).json({ error: "Rule not found." });
        }
        nextRules = result.rules;
        if (removedText) {
          nextEnforced = removeEnforcedRulesMatchingNeedle(nextEnforced, removedText);
        }
      }

      await upsertSettingsForUser(userId, {
        ...settings,
        ai_refining_rules: nextRules || null,
        ai_refining_enforced_json: nextEnforced,
      });

      return res.json({
        ok: true,
        rulesHtml: renderActiveRules(nextRules),
        rulesCount: listRefiningRules(nextRules).length,
      });
    } catch (err) {
      console.error("[refining] remove rule error:", err?.message || err);
      return res.status(500).json({ error: "Could not remove rule." });
    }
  });

  app.post("/api/refining/booking-fields/remove", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const fieldId = String(req.body?.id || req.body?.fieldId || "").trim();
    if (!fieldId) {
      return res.status(400).json({ error: "Field id is required." });
    }

    try {
      const settings = await getSettingsForUser(userId);
      const result = removeBookingFieldFromSettings(settings, fieldId);
      if (!result.ok) {
        if (result.error === "name_required") {
          return res.status(400).json({ error: "The name question cannot be removed." });
        }
        return res.status(400).json({ error: "Booking question not found." });
      }

      await upsertSettingsForUser(userId, {
        ...settings,
        booking_fields_json: result.booking_fields_json,
      });
      const updatedSettings = await getSettingsForUser(userId);

      return res.json({
        ok: true,
        bookingFieldsHtml: renderBookingFields(updatedSettings),
      });
    } catch (err) {
      console.error("[refining] remove booking field error:", err?.message || err);
      return res.status(500).json({ error: "Could not remove booking question." });
    }
  });
}
