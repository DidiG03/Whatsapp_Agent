import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import {
  renderSidebar,
  renderTopbar,
  renderPageHeader,
  renderTranscriptAsBubbles,
  escapeHtml,
  getProfessionalHead,
} from "../utils.mjs";
import { getSettingsForUser, upsertSettingsForUser } from "../services/settings.mjs";
import { getPlanStatus } from "../services/usage.mjs";
import { refiningCoachReply } from "../services/ai.mjs";
import { parseRefiningDirectives, applyRefiningDirectives, removeRuleAtIndex, clearAllRefiningRules, listRefiningRules } from "../services/refiningDirectives.mjs";

function parseRulesList(rulesText = "") {
  return String(rulesText || "")
    .split(/\n+/)
    .map((line) => line.replace(/^[\-\d.)\s]+/, "").trim())
    .filter(Boolean);
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
      : `<div class="refining-empty">
          <p class="refining-empty__title">Start a coaching session</p>
          <p class="refining-empty__hint">Describe a situation or behaviour. If details are missing, the coach will ask follow-up questions before saving a rule.</p>
        </div>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.end(`
      <html>${getProfessionalHead("Refining")}<body class="refining-page">
        <div class="container">
          ${renderTopbar("Refining", email)}
          <div class="layout">
            ${renderSidebar("refining", { showBookings: !!isUpgraded, isUpgraded })}
            <main class="main">
              <div class="main-content refining-content">
                <div class="refining-shell">
                  <div class="refining-layout">
                    <section class="refining-panel refining-panel--chat" aria-label="Refining chat">
                      <header class="refining-panel__header">
                        <div>
                          <h2 class="refining-panel__title">Coach chat</h2>
                        </div>
                      </header>
                      <div id="refining-transcript" class="refining-chat-box">${chatHtml}</div>
                      <form id="refining-form" class="refining-composer" novalidate>
                        <label class="refining-visually-hidden" for="refining-input">Instruction for the bot coach</label>
                        <textarea
                          id="refining-input"
                          class="refining-input"
                          name="message"
                          rows="2"
                          placeholder="e.g. For groups over 30, ask customers to call us instead of booking by message…"
                          aria-describedby="refining-input-hint"
                        ></textarea>
                        <button type="submit" class="btn btn-primary refining-send" id="refining-send">Send</button>
                      </form>
                    </section>
                    <aside class="refining-panel refining-panel--rules" aria-label="Active bot rules">
                      <header class="refining-panel__header refining-panel__header--rules">
                        <div>
                          <h2 class="refining-panel__title">Active rules ${renderRulesBadge(rules)}</h2>
                        </div>
                        ${renderRulesHeaderActions(rules)}
                      </header>
                      <div id="refining-rules" class="refining-rules__body">${renderActiveRules(rules)}</div>
                    </aside>
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
            const sendLabel = sendBtn?.textContent || "Send";

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

            function scrollChatToBottom() {
              if (!transcriptEl) return;
              transcriptEl.scrollTop = transcriptEl.scrollHeight;
            }

            input?.addEventListener("input", function () {
              this.style.height = "auto";
              this.style.height = Math.min(this.scrollHeight, 140) + "px";
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
              sendBtn.disabled = true;
              sendBtn.textContent = "Sending…";
              try {
                const resp = await fetch("/api/refining/message", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Accept: "application/json" },
                  credentials: "include",
                  body: JSON.stringify({ message }),
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) throw new Error(data.error || "Could not save your instruction.");
                if (data.transcriptHtml) transcriptEl.innerHTML = data.transcriptHtml;
                if (data.rulesHtml) {
                  rulesEl.innerHTML = data.rulesHtml;
                  updateRulesBadge();
                }
                if (data.saved && data.removed) {
                  notify("Rule removed.", "success");
                } else if (data.clarifying) {
                  notify("Answer the follow-up so I can save a precise rule.", "info");
                } else if (data.saved) {
                  notify("Instruction saved.", "success");
                }
                input.value = "";
                input.style.height = "auto";
                input.classList.remove("is-invalid");
                scrollChatToBottom();
              } catch (err) {
                notify(err?.message || "Could not send your message. Please try again.", "error");
              } finally {
                sendBtn.disabled = false;
                sendBtn.textContent = sendLabel;
                input?.focus();
              }
            });

            scrollChatToBottom();
            input?.focus();
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
      const coach = await refiningCoachReply(userMsg, history, {
        tone: settings?.ai_tone,
        style: settings?.ai_style,
        blockedTopics: settings?.ai_blocked_topics,
        currentRules: settings?.ai_refining_rules || "",
      });

      const directives = parseRefiningDirectives(coach);
      const { visible, rules, saved, needsClarification, removed } = await applyRefiningDirectives(userId, directives);

      const newTranscript = `${history}${history ? "\n\n" : ""}You: ${userMsg}\nAI: ${visible}`;
      await upsertSettingsForUser(userId, {
        ...settings,
        refining_transcript: newTranscript,
        ai_refining_rules: rules || settings?.ai_refining_rules || null,
      });

      return res.json({
        ok: true,
        reply: visible,
        saved: !!saved,
        removed: !!removed,
        clarifying: !!needsClarification,
        transcriptHtml: renderTranscriptAsBubbles(newTranscript),
        rulesHtml: renderActiveRules(rules),
        rulesCount: parseRulesList(rules).length,
      });
    } catch (err) {
      console.error("[refining] message error:", err?.message || err);
      return res.status(500).json({ error: "Could not process your request." });
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
      if (clearAll) {
        nextRules = clearAllRefiningRules().rules;
      } else {
        const index = Number(req.body?.index);
        const result = removeRuleAtIndex(current, index);
        if (!result.ok) {
          return res.status(400).json({ error: "Rule not found." });
        }
        nextRules = result.rules;
      }

      await upsertSettingsForUser(userId, {
        ...settings,
        ai_refining_rules: nextRules || null,
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
}
