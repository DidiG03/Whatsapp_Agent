import { ensureAuthed, getCurrentUserId, getSignedInEmail, clerkClient } from "../middleware/auth.mjs";
import { CLERK_ENABLED, META_APP_ID, META_EMBEDDED_SIGNUP_CONFIG_ID, META_EMBEDDED_SIGNUP_ENABLED, PUBLIC_BASE_URL } from "../config.mjs";
import { wrapAsync } from "../middleware/errors.mjs";
import { getSettingsForUser, upsertSettingsForUser } from "../services/settings.mjs";
import { getVercelWebAnalyticsSnippet, renderSidebar, renderTopbar, escapeHtml, getProfessionalHead, renderPageHeader } from "../utils.mjs";
import { wipeUserData } from "../services/userDeletion.mjs";
import { cancelBillingForUserDeletion } from "../services/stripe.mjs";
import {
  Staff,
  KBItem,
  Message,
  MessageStatus,
  BookingSession,
  Appointment,
  ContactState,
  Customer,
  Handoff,
  OnboardingState,
  SettingsMulti,
  Notification,
  UsageStats,
  UserPlan,
  QuickReply
} from "../schemas/mongodb.mjs";
import { createQuickReply, updateQuickReply, deleteQuickReply, reorderQuickReplies } from "../services/quickReplies.mjs";
import { getUserPlan, isPlanUpgraded } from "../services/usage.mjs";
import { validateSettingsPayload, preserveUnloadedPanelFields } from "../validators/settingsPayload.mjs";
import { enforceSettingsPolicy } from "../services/settingsPolicy.mjs";
import { recordSettingsAudit } from "../services/audit.mjs";
import { autocompleteAddress, getPlaceDetails, autocompleteBusiness, isPlacesConfigured } from "../services/places.mjs";
import { previewGoogleBusinessImport, applyGoogleBusinessImport } from "../services/googleBusinessImport.mjs";
import { checkWhatsAppGroupsSupport } from "../services/staffGroupsSupport.mjs";
import {
  buildConnectionStatus,
  completeManualWhatsAppConnection,
  completeWhatsAppConnection,
  disconnectWhatsApp,
  validateWhatsAppToken,
} from "../services/whatsappConnect.mjs";
import { parseWorkingHoursFromFields } from "../views/staffWorkingHours.mjs";
import { buildLazySettingsPanelPayload } from "../views/settingsLazyPanels.mjs";

export default function registerSettingsRoutes(app, options = {}) {
  const protect = options.csrfProtection || ((req, _res, next) => next());
  const csrfTokenMiddleware = options.csrfTokenMiddleware || ((req, _res, next) => next());

  app.get("/settings", ensureAuthed, protect, csrfTokenMiddleware, async (req, res) => {
    const userId = getCurrentUserId(req);
    const [plan, email] = await Promise.all([
      getUserPlan(userId).catch(() => ({ plan_name: "free" })),
      getSignedInEmail(req),
    ]);
    const isUpgraded = isPlanUpgraded(plan);
    const primaryEmail = email || "";
    const csrfToken = res.locals.csrfToken || '';
    const csrfField = `<input type="hidden" name="_csrf" value="${escapeAttr(csrfToken)}">`;
    const assetVer = process.env.STATIC_ASSETS_VERSION || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || 'dev';
    const metaConnectConfigJson = JSON.stringify({
      enabled: META_EMBEDDED_SIGNUP_ENABLED,
      appId: META_APP_ID || "",
      configId: META_EMBEDDED_SIGNUP_CONFIG_ID || "",
      graphVersion: "v21.0",
      publicBaseUrl: PUBLIC_BASE_URL || "",
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html>${getProfessionalHead("Settings", { sandbox: true, csrfToken: res.locals.csrfToken || '' })}<body class="settings-page">
        <script src="/settings-panels.js?v=${assetVer}"></script>
        <script src="/settings-lazy-panels.js?v=${assetVer}"></script>
        <script>window.__META_WA_CONNECT__ = ${metaConnectConfigJson};</script>
        <script src="/settings-page.js?v=${assetVer}" defer></script>
        <div class="container">
          ${renderTopbar('Settings', email)}
          <div class="layout">
            ${renderSidebar('settings', { showBookings: !!isUpgraded, isUpgraded })}
            <main class="main">
            <div class="main-content settings-page">
              <div class="settings-shell">
              <div class="settings-toolbar">
                <div>
                  <h2 class="settings-toolbar__title">Settings</h2>
                  <p class="settings-toolbar__subtitle">Configure your workspace, WhatsApp bot, and bookings.</p>
                </div>
                <button class="btn btn-primary settings-toolbar__save" type="submit" form="settings-main-form">Save changes</button>
              </div>
              <div class="settings-layout">
              <nav id="settings-nav" class="settings-sidebar" aria-label="Settings sections">
                <div class="settings-sidebar__group">
                  <div class="settings-sidebar__label">General</div>
                  <button type="button" class="settings-sidebar__link is-active" data-settings-panel="account">Account</button>
                  <button type="button" class="settings-sidebar__link" data-settings-panel="billing">Plan & billing</button>
                  <button type="button" class="settings-sidebar__link" data-settings-panel="business">Business information</button>
                </div>
                <div class="settings-sidebar__group">
                  <div class="settings-sidebar__label">WhatsApp</div>
                  <button type="button" class="settings-sidebar__link" data-settings-panel="whatsapp">Connection</button>
                  <button type="button" class="settings-sidebar__link" data-settings-panel="ai_configuration">AI Configuration</button>
                </div>
                <div class="settings-sidebar__group">
                  <div class="settings-sidebar__label">Scheduling</div>
                  <button type="button" class="settings-sidebar__link" data-settings-panel="holidays">Holidays & closures</button>
                  <button type="button" class="settings-sidebar__link" data-settings-panel="bookings_section">Reservations</button>
                  <button type="button" class="settings-sidebar__link" data-settings-panel="staff">Staff</button>
                </div>
                <div class="settings-sidebar__group">
                  <div class="settings-sidebar__label">Messaging</div>
                  <button type="button" class="settings-sidebar__link" data-settings-panel="quick-replies">Quick replies</button>
                </div>
                <div class="settings-sidebar__group settings-sidebar__group--danger">
                  <button type="button" class="settings-sidebar__link settings-sidebar__link--danger" data-settings-panel="danger">Danger zone</button>
                </div>
              </nav>
              <div class="settings-shell__body">
                <div class="settings-content-header">
                  <h3 id="settings-panel-heading">Account</h3>
                </div>
                <div class="settings-panels">
                <div class="section settings-panel is-active" id="account">
                    <h3>Account</h3>
                    <div class="account-email-block">
                      <label>Current email
                        <input type="email" id="account-current-email" value="${escapeAttr(primaryEmail)}" class="settings-field" readonly disabled />
                      </label>
                      <p class="account-email-block__hint small" id="account-email-hint">
                        To change your primary email, add a new address and verify it with the code we send you.
                      </p>
                      ${CLERK_ENABLED ? `
                      <form id="account-email-form" class="account-email-form" data-clerk-enabled="true" novalidate>
                        <label>New email
                          <input type="email" id="account-new-email" autocomplete="email" class="settings-field" required />
                        </label>
                        <div id="account-email-verify-step" hidden>
                          <label>Verification code
                            <input type="text" id="account-email-code" inputmode="numeric" autocomplete="one-time-code" class="settings-field" placeholder="6-digit code" />
                          </label>
                          <p class="small account-email-block__hint" id="account-email-verify-hint"></p>
                        </div>
                        <div id="account-email-error" class="account-password-form__message account-password-form__message--error" hidden></div>
                        <div id="account-email-success" class="account-password-form__message account-password-form__message--success" hidden></div>
                        <div class="account-email-form__actions">
                          <button type="submit" class="btn-primary" id="account-email-submit">Send verification code</button>
                          <button type="button" class="btn-ghost" id="account-email-resend" hidden>Resend code</button>
                          <button type="button" class="btn-ghost" id="account-email-cancel" hidden>Cancel</button>
                        </div>
                      </form>
                      ` : `
                      <div class="small" style="color:#64748b;">Email management is unavailable because Clerk authentication is not configured.</div>
                      `}
                    </div>

                    <div class="account-security-block">
                      <div class="account-security-block__title">Password</div>
                      <p class="account-security-block__hint small" id="account-password-hint">
                        Set or update your sign-in password.
                      </p>
                      ${CLERK_ENABLED ? `
                      <form id="account-password-form" class="account-password-form" data-password-enabled="false" data-clerk-enabled="true" novalidate>
                        <label id="account-current-password-wrap" hidden>Current password
                          <div class="input-row">
                            <input type="password" id="account-current-password" autocomplete="current-password" class="settings-field" />
                            <button type="button" class="btn-ghost" onclick="toggleReveal('account-current-password')" aria-label="Show current password"><img src="/show-password.svg" alt=""/></button>
                          </div>
                        </label>
                        <label>New password
                          <div class="input-row">
                            <input type="password" id="account-new-password" autocomplete="new-password" class="settings-field" minlength="8" required />
                            <button type="button" class="btn-ghost" onclick="toggleReveal('account-new-password')" aria-label="Show new password"><img src="/show-password.svg" alt=""/></button>
                          </div>
                          <div class="small" style="color:#64748b; margin-top:4px;">At least 8 characters. Clerk may reject commonly used or compromised passwords.</div>
                        </label>
                        <label>Confirm new password
                          <div class="input-row">
                            <input type="password" id="account-confirm-password" autocomplete="new-password" class="settings-field" minlength="8" required />
                            <button type="button" class="btn-ghost" onclick="toggleReveal('account-confirm-password')" aria-label="Show confirm password"><img src="/show-password.svg" alt=""/></button>
                          </div>
                        </label>
                        <label class="account-password-form__checkbox">
                          <input type="checkbox" id="account-sign-out-sessions" checked />
                          <span>Sign out of all other devices after updating</span>
                        </label>
                        <div id="account-password-error" class="account-password-form__message account-password-form__message--error" hidden></div>
                        <div id="account-password-success" class="account-password-form__message account-password-form__message--success" hidden></div>
                        <button type="submit" class="btn-primary" id="account-password-submit">Set password</button>
                      </form>
                      ` : `
                      <div class="small" style="color:#64748b;">Password management is unavailable because Clerk authentication is not configured.</div>
                      `}
                    </div>
                  </div>
                <form id="settings-main-form" method="post" action="/settings" onsubmit="event.preventDefault(); checkAuthThenSubmit(this).then(valid => { if(valid) this.submit(); }); return false;">
                  ${csrfField}
                  <input type="hidden" name="settings_panel" id="settings-active-panel" value="" />
                  <div class="section settings-panel" id="business" data-lazy-panel="business">
                    <div class="settings-lazy-panel__placeholder"><p class="small">Open this tab to load business information.</p></div>
                  </div>
                  <div class="section settings-panel" id="whatsapp" data-lazy-panel="whatsapp">
                    <div class="settings-lazy-panel__placeholder"><p class="small">Open this tab to load WhatsApp setup.</p></div>
                  </div>
                  <div class="section settings-panel" id="ai_configuration" data-lazy-panel="ai_configuration">
                    <div class="settings-lazy-panel__placeholder"><p class="small">Open this tab to load AI configuration.</p></div>
                  </div>
                  <div class="section settings-panel" id="holidays" data-lazy-panel="holidays">
                    <div class="settings-lazy-panel__placeholder"><p class="small">Open this tab to load holidays and closures.</p></div>
                  </div>
                  <div class="section settings-panel" id="bookings_section" data-lazy-panel="bookings_section">
                    <div class="settings-lazy-panel__placeholder"><p class="small">Open this tab to load reservations settings.</p></div>
                  </div>
                </form>
                <div class="section settings-panel" id="billing" data-lazy-panel="billing">
                  <div class="settings-lazy-panel__placeholder"><p class="small">Open this tab to load plan and billing.</p></div>
                </div>
                <!-- Separate email form (not nested) to avoid interfering with settings submission -->
                <div class="section settings-panel" id="staff" data-lazy-panel="staff">
                  <div class="settings-lazy-panel__placeholder"><p class="small">Open this tab to load staff.</p></div>
                </div>
                <div class="section settings-panel" id="quick-replies" data-lazy-panel="quick-replies">
                  <div class="settings-lazy-panel__placeholder"><p class="small">Open this tab to load quick replies.</p></div>
                </div>
                <!-- Danger Section -->
                <div class="section settings-panel section--danger" id="danger">
                  <h3 class="settings-section__title settings-section__title--danger">Danger zone</h3>
                  <p class="settings-section__lead settings-section__lead--danger">These actions are irreversible. Please proceed with caution.</p>
                  <div class="settings-danger-actions">
                    <form method="post" action="/kb/clear" style="margin:0;display:inline;">
                      <button type="submit" class="btn-danger">Clear Knowledge Base</button>
                    </form>
                    <form method="post" action="/danger/wipe" style="margin:0;display:inline;" onsubmit="return confirm('Delete all data for this account? This cannot be undone.');">
                      <button type="submit" class="btn-danger">
                        <img src="/delete-icon.svg" alt="Delete" style="width:16px;height:16px;margin-right:8px;"/>
                        Delete my account data
                      </button>
                    </form>
                  </div>
                </div>
                </div>
              </div>
              </div>
            </div>
            </div>
              
            </main>
          </div>
        </div>

      </body></html>
    `);
  });

  app.post("/kb/clear", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    try {
      console.log("[KB][CLEAR] requested by", { userId });
      try {
        db.prepare("INSERT INTO kb_items_fts(kb_items_fts) VALUES ('integrity-check')").run();
      } catch {
        console.warn('[KB][CLEAR] FTS integrity-check failed; rebuilding');
        try { db.prepare("INSERT INTO kb_items_fts(kb_items_fts) VALUES ('rebuild')").run(); } catch {}
        try {
          db.exec(`DROP TABLE IF EXISTS kb_items_fts;`);
          db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_items_fts USING fts5(
            title,
            content,
            content='kb_items',
            content_rowid='id'
          );`);
          db.exec(`INSERT INTO kb_items_fts(rowid, title, content) SELECT id, title, content FROM kb_items;`);
        } catch {}
      }
      const del = db.prepare(`DELETE FROM kb_items WHERE user_id = ?`).run(userId);
      console.log("[KB][CLEAR] deleted rows", { changes: del?.changes || 0 });
      const remaining = db.prepare(`SELECT COUNT(1) AS c FROM kb_items WHERE user_id = ?`).get(userId)?.c || 0;
      console.log("[KB][CLEAR] remaining rows", { remaining });
    } catch (e) {
      console.error("[KB][CLEAR] final error", e?.message || e);
    }
    return res.redirect(303, '/settings#danger');
  });
  function normalizeTimezoneLabel(tz) {
    if (!tz) return null;
    if (/\//.test(tz)) return tz;
    const map = { london: 'Europe/London', utc: 'UTC', ny: 'America/New_York', new_york: 'America/New_York' };
    const key = String(tz).toLowerCase().replace(/\s+/g, '_');
    return map[key] || tz;
  }

  function settingsRedirectPath(query, panel) {
    const id = String(panel || '').trim();
    const hash = id && /^[a-z0-9_-]+$/i.test(id) ? `#${id}` : '';
    return `/settings${query}${hash}`;
  }

  async function staffSlotMinutes(userId) {
    try {
      const settings = await getSettingsForUser(userId);
      return Number(settings?.booking_display_interval_minutes || 30) || 30;
    } catch {
      return 30;
    }
  }

  app.get("/api/settings/lazy-panel/:panelId", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const panelId = String(req.params.panelId || "").trim();
      const allowed = new Set([
        "staff",
        "quick-replies",
        "billing",
        "business",
        "whatsapp",
        "ai_configuration",
        "holidays",
        "bookings_section",
      ]);
      if (!allowed.has(panelId)) {
        return res.status(404).json({ success: false, error: "Unknown panel" });
      }
      const s = await getSettingsForUser(userId);
      const payload = await buildLazySettingsPanelPayload(panelId, userId, {
        editStaffId: req.query.edit_staff || null,
        timezone: s.timezone || "",
        settings: s,
      });
      if (!payload?.html) {
        return res.status(404).json({ success: false, error: "Unknown panel" });
      }
      return res.json({ success: true, ...payload });
    } catch (error) {
      console.error("[Settings] lazy panel failed:", error?.message || error);
      return res.status(500).json({ success: false, error: "Failed to load panel" });
    }
  });

  app.get("/api/settings/account-meta", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const email = await getSignedInEmail(req);
    let passwordEnabled = false;
    let signedInWithGoogle = false;
    let primaryEmail = email || "";
    if (CLERK_ENABLED && userId) {
      try {
        const clerkUser = await clerkClient.users.getUser(userId);
        passwordEnabled = clerkUser?.passwordEnabled === true;
        primaryEmail = clerkUser.emailAddresses?.find((entry) => entry.id === clerkUser.primaryEmailAddressId)?.emailAddress
          || clerkUser.emailAddresses?.[0]?.emailAddress
          || primaryEmail;
        signedInWithGoogle = (clerkUser.externalAccounts || []).some((account) => {
          const provider = String(account.provider || "").toLowerCase();
          return provider.includes("google");
        });
      } catch {}
    }
    return res.json({
      success: true,
      passwordEnabled,
      signedInWithGoogle,
      primaryEmail,
    });
  });

  app.post("/settings/staff", ensureAuthed, protect, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);
    const name = String(req.body?.name || '').trim();
    if (!name) return res.redirect(303, '/settings#staff');
    let timezone = normalizeTimezoneLabel(String(req.body?.timezone || '').trim() || null);
    const slotMinutes = await staffSlotMinutes(userId);
    const workingJson = parseWorkingHoursFromFields(req.body);
    try {
      const exists = await Staff.findOne({ user_id: userId, name, timezone, slot_minutes: slotMinutes, working_hours_json: workingJson || '{}' }).lean();
      if (!exists) {
        await Staff.create({ user_id: userId, name, timezone, slot_minutes: slotMinutes, working_hours_json: workingJson || '{}' });
      }
    } catch {}
    return res.redirect(303, '/settings#staff');
  }));

  app.post("/settings/staff/:id", ensureAuthed, protect, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);
    const id = String(req.params.id || '');
    if (!id) return res.redirect(303, '/settings#staff');
    const name = String(req.body?.name || '').trim();
    if (!name) return res.redirect(303, '/settings#staff');
    let timezone = normalizeTimezoneLabel(String(req.body?.timezone || '').trim() || null);
    const slotMinutes = await staffSlotMinutes(userId);
    const workingJson = parseWorkingHoursFromFields(req.body);
    try {
      await Staff.findOneAndUpdate({ _id: id, user_id: userId }, { name, timezone, slot_minutes: slotMinutes, working_hours_json: workingJson || '{}' }, { new: true });
    } catch {}
    return res.redirect(303, '/settings?edit_staff=#staff');
  }));

  app.post("/settings/staff/:id/delete", ensureAuthed, protect, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);
    const id = String(req.params.id || '');
    if (!id) return res.redirect(303, '/settings#staff');
    try { await Staff.findOneAndDelete({ _id: id, user_id: userId }); } catch {}
    return res.redirect(303, '/settings#staff');
  }));

  app.post("/danger/wipe", ensureAuthed, protect, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);

    try {
      const out = await cancelBillingForUserDeletion(userId);
      if (out?.attempted && out?.failed > 0) {
        console.error('[Wipe] Stripe cancellation failed:', out);
        return res.status(500).send(
          `Unable to cancel your subscription automatically, so we did not delete your account data. ` +
          `Please try again, or contact support if the issue persists.`
        );
      }
    } catch (e) {
      const stripeConfigured = !!process.env.STRIPE_SECRET_KEY;
      if (stripeConfigured) {
        console.error('[Wipe] Stripe cancellation error:', e?.message || e);
        return res.status(500).send(
          `Unable to cancel your subscription automatically, so we did not delete your account data. ` +
          `Please try again, or contact support if the issue persists.`
        );
      }
    }

    try {
      await wipeUserData(userId);
    } catch (e) {
      console.error('[Wipe] Mongo wipe error:', e?.message || e);
    }
    try {
      await clerkClient.users.deleteUser(userId);
    } catch (e) {
      console.error('[Wipe] Clerk delete error:', e?.errors?.[0]?.message || e?.message || e);
    }
    return res.redirect(303, '/logout');
  }));

  app.post("/settings", ensureAuthed, protect, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);
    const activePanel = String(req.body?.settings_panel || '').trim();
    const existingSettings = await getSettingsForUser(userId);
    const validation = validateSettingsPayload(req.body || {});
    if (!validation.success) {
      const summary = summarizeValidationError(validation.errors);
      return res.status(400).send(`Invalid settings payload: ${summary}`);
    }

    let planName = "free";
    try {
      const plan = await getUserPlan(userId);
      planName = String(plan?.plan_name || "free").toLowerCase();
    } catch {}

    let { filtered, deniedFields } = enforceSettingsPolicy(validation.data, { planName });
    filtered = preserveUnloadedPanelFields(filtered, req.body || {}, existingSettings);
    const allowFreeBookings = String(process.env.ALLOW_BOOKINGS_ON_FREE || '').toLowerCase() === 'true';
    if (planName === "free" && !allowFreeBookings) {
      filtered.conversation_mode = "escalation";
      filtered.bookings_enabled = false;
      filtered.reminders_enabled = false;
    }
    filtered.escalation_email = null;

    const diff = computeSettingsDiff(existingSettings, filtered);

    if (!diff.changed.length) {
      return res.redirect(303, settingsRedirectPath('?updated=0', activePanel));
    }

    try {
      await upsertSettingsForUser(userId, filtered);
      const actorEmail = await getSignedInEmail(req);
      await recordSettingsAudit({
        userId,
        actorId: userId,
        actorEmail,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        deniedFields,
        changes: diff.changed
      });
    } catch (error) {
      console.error('[POST /settings] upsert error', error?.message || error);
      if (error?.code === 'PHONE_NUMBER_ID_CONFLICT') {
        return res.redirect(303, settingsRedirectPath('?error=phone_number_id_in_use', activePanel));
      }
      return res.status(500).send("Failed to save settings");
    }

    res.redirect(303, settingsRedirectPath('?saved=1', activePanel));
  }));

  app.get("/api/places/autocomplete", ensureAuthed, wrapAsync(async (req, res) => {
    if (!isPlacesConfigured()) {
      return res.status(503).json({ success: false, error: "Google Maps is not configured" });
    }
    const q = String(req.query.q || "").trim();
    if (q.length < 2) {
      return res.json({ success: true, predictions: [] });
    }
    try {
      const predictions = await autocompleteAddress(q, { sessionToken: req.query.session });
      return res.json({ success: true, predictions });
    } catch (error) {
      console.error("[GET /api/places/autocomplete]", error?.message || error);
      return res.status(500).json({ success: false, error: "Autocomplete failed" });
    }
  }));

  app.get("/api/places/details", ensureAuthed, wrapAsync(async (req, res) => {
    if (!isPlacesConfigured()) {
      return res.status(503).json({ success: false, error: "Google Maps is not configured" });
    }
    const placeId = String(req.query.place_id || "").trim();
    if (!placeId) {
      return res.status(400).json({ success: false, error: "place_id is required" });
    }
    try {
      const place = await getPlaceDetails(placeId, { sessionToken: req.query.session });
      return res.json({ success: true, place });
    } catch (error) {
      console.error("[GET /api/places/details]", error?.message || error);
      return res.status(500).json({ success: false, error: "Place details failed" });
    }
  }));

  app.get("/api/google-business/search", ensureAuthed, wrapAsync(async (req, res) => {
    if (!isPlacesConfigured()) {
      return res.status(503).json({ success: false, error: "Google Maps is not configured" });
    }
    const q = String(req.query.q || "").trim();
    if (q.length < 2) {
      return res.json({ success: true, predictions: [] });
    }
    try {
      const predictions = await autocompleteBusiness(q, { sessionToken: req.query.session });
      return res.json({ success: true, predictions });
    } catch (error) {
      console.error("[GET /api/google-business/search]", error?.message || error);
      return res.status(500).json({ success: false, error: error?.message || "Business search failed" });
    }
  }));

  app.get("/api/google-business/preview", ensureAuthed, wrapAsync(async (req, res) => {
    if (!isPlacesConfigured()) {
      return res.status(503).json({ success: false, error: "Google Maps is not configured" });
    }
    const userId = getCurrentUserId(req);
    const placeId = String(req.query.place_id || "").trim();
    if (!placeId) {
      return res.status(400).json({ success: false, error: "place_id is required" });
    }
    try {
      const preview = await previewGoogleBusinessImport(userId, placeId, { sessionToken: req.query.session });
      return res.json({ success: true, preview });
    } catch (error) {
      console.error("[GET /api/google-business/preview]", error?.message || error);
      return res.status(500).json({ success: false, error: error?.message || "Preview failed" });
    }
  }));

  app.post("/api/google-business/import", ensureAuthed, wrapAsync(async (req, res) => {
    if (!isPlacesConfigured()) {
      return res.status(503).json({ success: false, error: "Google Maps is not configured" });
    }
    const userId = getCurrentUserId(req);
    const placeId = String(req.body?.place_id || "").trim();
    if (!placeId) {
      return res.status(400).json({ success: false, error: "place_id is required" });
    }
    try {
      const result = await applyGoogleBusinessImport(userId, placeId, { sessionToken: req.body?.session });
      return res.json({ success: true, result });
    } catch (error) {
      console.error("[POST /api/google-business/import]", error?.message || error);
      return res.status(500).json({ success: false, error: error?.message || "Import failed" });
    }
  }));

  app.get("/api/settings/whatsapp/status", ensureAuthed, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);
    const settings = await getSettingsForUser(userId);
    const status = buildConnectionStatus(settings);
    if (req.query.validate === "1") {
      if (!status.connected) {
        status.tokenStatus = "not_connected";
        status.tokenMessage = "WhatsApp is not connected.";
      } else {
        const check = await validateWhatsAppToken(settings.phone_number_id, settings.whatsapp_token);
        status.tokenStatus = check.valid ? "ok" : "invalid";
        status.tokenMessage = check.valid ? null : `Token validation failed (${check.status || "unknown"})`;
      }
    }
    return res.json(status);
  }));

  app.post("/api/settings/whatsapp/connect", ensureAuthed, protect, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);
    try {
      const result = await completeWhatsAppConnection(userId, req.body || {});
      const status = buildConnectionStatus(await getSettingsForUser(userId));
      return res.json({ ...result, status });
    } catch (error) {
      console.error("[POST /api/settings/whatsapp/connect]", error?.message || error, error?.meta || "");
      return res.status(400).json({
        success: false,
        error: error?.message || "Failed to connect WhatsApp",
      });
    }
  }));

  app.post("/api/settings/whatsapp/connect/manual", ensureAuthed, protect, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);
    try {
      const result = await completeManualWhatsAppConnection(userId, req.body || {});
      const status = buildConnectionStatus(await getSettingsForUser(userId));
      return res.json({ ...result, status });
    } catch (error) {
      console.error("[POST /api/settings/whatsapp/connect/manual]", error?.message || error, error?.meta || "");
      return res.status(400).json({
        success: false,
        error: error?.message || "Failed to connect WhatsApp manually",
      });
    }
  }));

  app.post("/api/settings/whatsapp/disconnect", ensureAuthed, protect, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);
    await disconnectWhatsApp(userId);
    return res.json({ success: true, status: buildConnectionStatus(await getSettingsForUser(userId)) });
  }));

  app.get("/api/settings/wa-token/status", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    try {
      const s = await getSettingsForUser(userId);
      if (!s?.whatsapp_token || !s?.phone_number_id) {
        return res.json({ status: 'missing', hasToken: !!s?.whatsapp_token, hasPhoneId: !!s?.phone_number_id });
      }
      try {
        const fetch = (await import('node-fetch')).default;
        const resp = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(String(s.phone_number_id))}`, {
          headers: { Authorization: `Bearer ${s.whatsapp_token}` }
        });
        if (resp.status === 401 || resp.status === 403) {
          return res.json({ status: 'invalid', code: resp.status });
        }
        if (!resp.ok) {
          return res.json({ status: 'unknown', code: resp.status });
        }
        return res.json({ status: 'ok' });
      } catch (e) {
        return res.json({ status: 'unknown', error: String(e?.message || e) });
      }
    } catch {
      return res.json({ status: 'unknown' });
    }
  });
  app.post("/api/settings/wa-token", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const newTokenRaw = (req.body?.whatsapp_token || '').toString();
    const newToken = newTokenRaw.trim();
    if (!newToken) return res.status(400).json({ success: false, error: 'Token is required' });
    try {
      const s = await getSettingsForUser(userId);
      if (s?.phone_number_id) {
        try {
          const fetch = (await import('node-fetch')).default;
          const resp = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(String(s.phone_number_id))}`, {
            headers: { Authorization: `Bearer ${newToken}` }
          });
          if (resp.status === 401 || resp.status === 403) {
            return res.status(400).json({ success: false, error: 'Invalid or expired token (401/403 from Graph)' });
          }
        } catch {}
      }
      await upsertSettingsForUser(userId, { whatsapp_token: newToken });
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e?.message || 'Failed to update token' });
    }
  });
  app.post("/api/settings/setup-task", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const updates = (req.body?.updates || {});
    const allowed = [
      'phone_number_id',
      'waba_id',
      'business_phone',
      'whatsapp_token',
      'app_secret',
      'verify_token'
    ];
    const clean = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        const v = (updates[key] ?? '').toString().trim();
        clean[key] = v || null;
      }
    }
    if (!Object.keys(clean).length) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }
    try {
      await upsertSettingsForUser(userId, clean);
      return res.json({ success: true });
    } catch (e) {
      console.error('[POST /api/settings/setup-task] upsert error', e?.message || e);
      if (e?.code === 'PHONE_NUMBER_ID_CONFLICT') {
        return res.status(409).json({ success: false, error: 'This WhatsApp phone number ID is already connected to another account.' });
      }
      return res.status(500).json({ success: false, error: 'Failed to save settings' });
    }
  });
  app.post("/api/settings/staff-group/disconnect", ensureAuthed, protect, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);
    await upsertSettingsForUser(userId, {
      staff_whatsapp_group_id: null,
      staff_whatsapp_group_enabled: false,
    });
    return res.json({ success: true });
  }));
  app.get("/api/settings/staff-group/support", ensureAuthed, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);
    const settings = await getSettingsForUser(userId);
    const result = await checkWhatsAppGroupsSupport(settings);
    return res.json(result);
  }));
  app.post("/api/quick-replies", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const { text, category } = req.body;
    
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, error: 'Quick reply text is required' });
    }
    
    try {
      const result = createQuickReply(userId, text.trim(), category || 'General');
      res.json({ success: true, id: result.id });
    } catch (error) {
      console.error('Error creating quick reply:', error);
      res.status(500).json({ success: false, error: 'Failed to create quick reply' });
    }
  });

  app.put("/api/quick-replies/:id", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const id = Number(req.params.id);
    const { text, category } = req.body;
    
    if (!id || !text || !text.trim()) {
      return res.status(400).json({ success: false, error: 'Quick reply ID and text are required' });
    }
    
    try {
      updateQuickReply(id, userId, text.trim(), category || 'General');
      res.json({ success: true });
    } catch (error) {
      console.error('Error updating quick reply:', error);
      res.status(500).json({ success: false, error: 'Failed to update quick reply' });
    }
  });

  app.delete("/api/quick-replies/:id", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const id = Number(req.params.id);
    
    if (!id) {
      return res.status(400).json({ success: false, error: 'Quick reply ID is required' });
    }
    
    try {
      deleteQuickReply(id, userId);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting quick reply:', error);
      res.status(500).json({ success: false, error: 'Failed to delete quick reply' });
    }
  });
}

function summarizeValidationError(flattened) {
  if (!flattened) return "validation failed";
  const fieldErrors = flattened.fieldErrors || {};
  const [fieldKey] = Object.keys(fieldErrors);
  if (fieldKey) {
    return `${fieldKey}: ${fieldErrors[fieldKey]?.[0] || "invalid"}`;
  }
  return flattened.formErrors?.[0] || "validation failed";
}

function computeSettingsDiff(previous = {}, next = {}) {
  const changed = [];
  for (const [key, value] of Object.entries(next)) {
    const before = previous?.[key];
    if (!deepEqual(coerceComparable(before), coerceComparable(value))) {
      changed.push({ field: key, before: before ?? null, after: value ?? null });
    }
  }
  return { changed };
}

function coerceComparable(value) {
  if (value === undefined) return null;
  if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function escapeAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
