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
import { getQuickReplies, getQuickReplyCategories, createQuickReply, updateQuickReply, deleteQuickReply, reorderQuickReplies } from "../services/quickReplies.mjs";
import { getUserPlan, isPlanUpgraded } from "../services/usage.mjs";
import { validateSettingsPayload } from "../validators/settingsPayload.mjs";
import { enforceSettingsPolicy } from "../services/settingsPolicy.mjs";
import { recordSettingsAudit } from "../services/audit.mjs";
import { autocompleteAddress, getPlaceDetails, autocompleteBusiness, isPlacesConfigured } from "../services/places.mjs";
import { previewGoogleBusinessImport, applyGoogleBusinessImport } from "../services/googleBusinessImport.mjs";
import { checkWhatsAppGroupsSupport } from "../services/staffGroupsSupport.mjs";
import {
  buildConnectionStatus,
  completeWhatsAppConnection,
  disconnectWhatsApp,
  validateWhatsAppToken,
} from "../services/whatsappConnect.mjs";

export default function registerSettingsRoutes(app, options = {}) {
  const protect = options.csrfProtection || ((req, _res, next) => next());
  const csrfTokenMiddleware = options.csrfTokenMiddleware || ((req, _res, next) => next());

  app.get("/settings", ensureAuthed, protect, csrfTokenMiddleware, async (req, res) => {
    const userId = getCurrentUserId(req);
    const s = await getSettingsForUser(userId);
    const plan = await getUserPlan(userId);
    const isUpgraded = isPlanUpgraded(plan);
    const allowFreeBookings = String(process.env.ALLOW_BOOKINGS_ON_FREE || '').toLowerCase() === 'true';
    const effectiveConversationMode = (isUpgraded || allowFreeBookings) ? (s.conversation_mode || 'full') : 'escalation';
    const bookingsActive = effectiveConversationMode === 'full';
    const bookingsLocked = !bookingsActive;
    const email = await getSignedInEmail(req);
    let passwordEnabled = false;
    let signedInWithGoogle = false;
    let primaryEmail = email || '';
    if (CLERK_ENABLED && userId) {
      try {
        const clerkUser = await clerkClient.users.getUser(userId);
        passwordEnabled = clerkUser?.passwordEnabled === true;
        primaryEmail = clerkUser.emailAddresses?.find((entry) => entry.id === clerkUser.primaryEmailAddressId)?.emailAddress
          || clerkUser.emailAddresses?.[0]?.emailAddress
          || primaryEmail;
        signedInWithGoogle = (clerkUser.externalAccounts || []).some((account) => {
          const provider = String(account.provider || '').toLowerCase();
          return provider.includes('google');
        });
      } catch {}
    }
    const q = req.query || {};
    const businessCategories = (() => { try { return JSON.parse(s.business_categories_json || '[]'); } catch { return []; } })();
    const businessCategoriesValue = Array.isArray(businessCategories) ? businessCategories.join(', ') : '';
    const bookingMaxPerDay = Number(s?.booking_max_per_day || 0);
    const bookingDaysAhead = Number(s?.booking_days_ahead || 60);
    const displayInterval = Number(s?.booking_display_interval_minutes || 30);
    const capacityWindow = Number(s?.booking_capacity_window_minutes || 60);
    const capacityLimit = Number(s?.booking_capacity_limit || 0);
    const waitlistEnabled = !!s?.waitlist_enabled;
    const servicesJson = String(s?.services_json || '[]');
    const staff = await Staff.find({ user_id: userId }).select('_id name timezone slot_minutes working_hours_json').sort({ _id: -1 }).limit(50).lean();
    const staffToEdit = (q.edit_staff ? await Staff.findOne({ _id: String(q.edit_staff), user_id: userId }).lean().catch(() => null) : null);
    const quickReplies = await getQuickReplies(userId);
    const quickReplyCategories = await getQuickReplyCategories(userId);
    const waConnection = buildConnectionStatus(s);
    const waWebhookUrl = `${PUBLIC_BASE_URL}/webhook`;
    const waVerifyToken = s.verify_token || "";
    const metaConnectConfigJson = JSON.stringify({
      enabled: META_EMBEDDED_SIGNUP_ENABLED,
      appId: META_APP_ID || "",
      configId: META_EMBEDDED_SIGNUP_CONFIG_ID || "",
      graphVersion: "v21.0",
    });
    const csrfToken = res.locals.csrfToken || '';
    const csrfField = `<input type="hidden" name="_csrf" value="${escapeAttr(csrfToken)}">`;
    const csrfTokenJson = JSON.stringify(csrfToken);
    const placesConfigured = isPlacesConfigured();
    const businessAddressValue = escapeAttr(s.business_address || "");
    const businessLatValue = s.business_latitude != null && s.business_latitude !== "" ? escapeAttr(String(s.business_latitude)) : "";
    const businessLngValue = s.business_longitude != null && s.business_longitude !== "" ? escapeAttr(String(s.business_longitude)) : "";
    const businessPlaceIdValue = escapeAttr(s.business_place_id || "");
    let googleProfileSyncedAt = "";
    let googleProfileName = "";
    try {
      if (s.google_business_json) {
        const snap = JSON.parse(s.google_business_json);
        googleProfileSyncedAt = snap?.syncedAt ? String(snap.syncedAt).slice(0, 10) : "";
        googleProfileName = snap?.profile?.name ? String(snap.profile.name) : "";
      }
    } catch {}
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html>${getProfessionalHead("Settings")}<body>
        <script>
          window.__CSRF_TOKEN__ = ${csrfTokenJson};
          document.addEventListener('DOMContentLoaded', function(){
            if (!window.__CSRF_TOKEN__) return;
            document.querySelectorAll('form').forEach(function(form){
              if (form.querySelector('input[name="_csrf"]')) return;
              const input = document.createElement('input');
              input.type = 'hidden';
              input.name = '_csrf';
              input.value = window.__CSRF_TOKEN__;
              form.appendChild(input);
            });
          });
        </script>
        <script>
          // Enhanced authentication check on page load
          (async function checkAuthOnLoad(){
            await window.authManager.checkAuthOnLoad();
          })();
          
          // Enhanced auth check for form submission
          async function checkAuthThenSubmit(form){
            return window.authManager.submitFormWithAuth(form);
          }
          function toggleReveal(id){
            const el=document.getElementById(id);
            if(!el) return; el.type = el.type === 'password' ? 'text' : 'password';
          }
          async function copyValue(id){
            const el=document.getElementById(id); if(!el) return;
            try{ await navigator.clipboard.writeText(el.value||''); }catch(e){}
          }
          // Settings panel navigation (one section visible at a time)
          const SETTINGS_PANEL_KEY = 'settings:activePanel:v1';
          function initSettingsPanels(){
            const panels = document.querySelectorAll('.settings-panel');
            const links = document.querySelectorAll('[data-settings-panel]');
            const heading = document.getElementById('settings-panel-heading');

            function showPanel(id){
              if (!id) return;
              const hasPanel = Array.from(panels).some((panel) => panel.id === id);
              if (!hasPanel) return;

              panels.forEach((panel) => {
                panel.classList.toggle('is-active', panel.id === id);
              });
              links.forEach((link) => {
                link.classList.toggle('is-active', link.getAttribute('data-settings-panel') === id);
              });

              const activeHeading = document.querySelector('.settings-panel.is-active h3, .settings-panel.is-active .settings-section__title');
              if (heading) heading.textContent = activeHeading?.textContent?.trim() || 'Settings';

              try { localStorage.setItem(SETTINGS_PANEL_KEY, id); } catch (_) {}
              if (window.history && window.history.replaceState) {
                window.history.replaceState(null, '', '#' + id);
              }
            }

            links.forEach((link) => {
              link.addEventListener('click', () => {
                showPanel(link.getAttribute('data-settings-panel'));
              });
            });

            window.addEventListener('hashchange', () => {
              const hash = (location.hash || '').replace(/^#/, '');
              if (hash) showPanel(hash);
            });

            const hash = (location.hash || '').replace(/^#/, '');
            let stored = null;
            try { stored = localStorage.getItem(SETTINGS_PANEL_KEY); } catch (_) {}
            const initial = (hash && document.getElementById(hash)) ? hash : (stored || 'account');
            showPanel(initial);
          }
          window.addEventListener('DOMContentLoaded', initSettingsPanels);

          function clerkAccountErrorMessage(error, fallback) {
            const errors = error?.errors;
            if (Array.isArray(errors) && errors.length) {
              const first = errors[0] || {};
              const code = String(first.code || '').toLowerCase();
              if (code.includes('reverification') || code === 'session_reverification_required') {
                return 'For your security, please sign out and sign in again, then retry.';
              }
              if (code === 'form_identifier_exists') {
                return 'That email is already linked to another account.';
              }
              return first.longMessage || first.message || fallback;
            }
            const message = String(error?.message || '').trim();
            if (/reverification|verification required/i.test(message)) {
              return 'For your security, please sign out and sign in again, then retry.';
            }
            return message || fallback;
          }

          function initAccountEmailForm() {
            const form = document.getElementById('account-email-form');
            if (!form) return;

            const clerkEnabled = form.dataset.clerkEnabled === 'true';
            const currentEmailInput = document.getElementById('account-current-email');
            const newEmailInput = document.getElementById('account-new-email');
            const codeInput = document.getElementById('account-email-code');
            const verifyStep = document.getElementById('account-email-verify-step');
            const verifyHint = document.getElementById('account-email-verify-hint');
            const errorEl = document.getElementById('account-email-error');
            const successEl = document.getElementById('account-email-success');
            const submitBtn = document.getElementById('account-email-submit');
            const resendBtn = document.getElementById('account-email-resend');
            const cancelBtn = document.getElementById('account-email-cancel');
            let pendingEmailAddress = null;
            let verifyMode = false;

            function setMessage(el, message) {
              if (!el) return;
              if (message) {
                el.textContent = message;
                el.hidden = false;
              } else {
                el.textContent = '';
                el.hidden = true;
              }
            }

            function setVerifyMode(enabled, targetEmail) {
              verifyMode = enabled;
              if (verifyStep) verifyStep.hidden = !enabled;
              if (resendBtn) resendBtn.hidden = !enabled;
              if (cancelBtn) cancelBtn.hidden = !enabled;
              if (newEmailInput) newEmailInput.readOnly = enabled;
              if (submitBtn) submitBtn.textContent = enabled ? 'Verify & set as primary' : 'Send verification code';
              if (verifyHint && targetEmail) {
                verifyHint.textContent = 'Enter the 6-digit code sent to ' + targetEmail + '.';
              }
              if (!enabled) {
                pendingEmailAddress = null;
                if (codeInput) codeInput.value = '';
              }
            }

            function getCurrentPrimaryEmail(user) {
              return String(user?.primaryEmailAddress?.emailAddress || currentEmailInput?.value || '').trim();
            }

            async function prepareEmailVerification(user, targetEmail) {
              const normalizedTarget = targetEmail.toLowerCase();
              const existing = (user.emailAddresses || []).find((entry) => {
                return String(entry.emailAddress || '').trim().toLowerCase() === normalizedTarget;
              });

              let emailAddress = existing || null;
              if (!emailAddress) {
                const created = await user.createEmailAddress({ email: targetEmail });
                await user.reload();
                emailAddress = user.emailAddresses.find((entry) => entry.id === created.id) || null;
              }

              if (!emailAddress) {
                throw new Error('Could not add the email address. Please try again.');
              }

              if (emailAddress.verification?.status === 'verified') {
                await user.update({ primaryEmailAddressId: emailAddress.id });
                await user.reload();
                return { alreadyVerified: true, emailAddress };
              }

              await emailAddress.prepareVerification({ strategy: 'email_code' });
              return { alreadyVerified: false, emailAddress };
            }

            cancelBtn?.addEventListener('click', () => {
              setMessage(errorEl, '');
              setMessage(successEl, '');
              setVerifyMode(false);
            });

            resendBtn?.addEventListener('click', async () => {
              setMessage(errorEl, '');
              setMessage(successEl, '');
              if (!pendingEmailAddress) return;
              if (resendBtn) {
                resendBtn.disabled = true;
                resendBtn.textContent = 'Sending...';
              }
              try {
                await window.authManager.initClerk();
                await pendingEmailAddress.prepareVerification({ strategy: 'email_code' });
                setMessage(successEl, 'Verification code resent.');
              } catch (error) {
                console.error('Email code resend failed:', error);
                setMessage(errorEl, clerkAccountErrorMessage(error, 'Failed to resend verification code.'));
              } finally {
                if (resendBtn) {
                  resendBtn.disabled = false;
                  resendBtn.textContent = 'Resend code';
                }
              }
            });

            form.addEventListener('submit', async (event) => {
              event.preventDefault();
              setMessage(errorEl, '');
              setMessage(successEl, '');

              if (!clerkEnabled) {
                setMessage(errorEl, 'Email changes require Clerk authentication.');
                return;
              }

              const targetEmail = String(newEmailInput?.value || '').trim();
              if (!targetEmail) {
                setMessage(errorEl, 'Enter a new email address.');
                newEmailInput?.focus();
                return;
              }

              if (submitBtn) {
                submitBtn.disabled = true;
              }

              try {
                await window.authManager.initClerk();
                const user = window.Clerk?.user;
                if (!user) {
                  window.authManager.handleUnauthorized();
                  return;
                }

                const currentEmail = getCurrentPrimaryEmail(user);
                if (targetEmail.toLowerCase() === currentEmail.toLowerCase()) {
                  setMessage(errorEl, 'That is already your current email address.');
                  return;
                }

                if (!verifyMode) {
                  if (submitBtn) submitBtn.textContent = 'Sending...';
                  const result = await prepareEmailVerification(user, targetEmail);
                  if (result.alreadyVerified) {
                    if (currentEmailInput) currentEmailInput.value = targetEmail;
                    setVerifyMode(false);
                    setMessage(successEl, 'Primary email updated successfully.');
                    if (window.history?.replaceState) {
                      window.history.replaceState(null, '', '/settings#account');
                    }
                    return;
                  }
                  pendingEmailAddress = result.emailAddress;
                  setVerifyMode(true, targetEmail);
                  setMessage(successEl, 'Verification code sent. Check your inbox.');
                  codeInput?.focus();
                  return;
                }

                const code = String(codeInput?.value || '').trim();
                if (!code) {
                  setMessage(errorEl, 'Enter the verification code from your email.');
                  codeInput?.focus();
                  return;
                }
                if (!pendingEmailAddress) {
                  setMessage(errorEl, 'Verification expired. Send a new code to continue.');
                  setVerifyMode(false);
                  return;
                }

                if (submitBtn) submitBtn.textContent = 'Verifying...';
                await pendingEmailAddress.attemptVerification({ code });
                await user.update({ primaryEmailAddressId: pendingEmailAddress.id });
                await user.reload();

                const updatedEmail = getCurrentPrimaryEmail(user);
                if (currentEmailInput && updatedEmail) currentEmailInput.value = updatedEmail;
                if (newEmailInput) newEmailInput.value = '';
                setVerifyMode(false);
                setMessage(successEl, 'Primary email updated successfully.');
                if (window.history?.replaceState) {
                  window.history.replaceState(null, '', '/settings#account');
                }
              } catch (error) {
                console.error('Email update failed:', error);
                setMessage(errorEl, clerkAccountErrorMessage(error, verifyMode
                  ? 'Verification failed. Check the code and try again.'
                  : 'Failed to start email update.'));
              } finally {
                if (submitBtn) {
                  submitBtn.disabled = false;
                  submitBtn.textContent = verifyMode ? 'Verify & set as primary' : 'Send verification code';
                }
              }
            });
          }

          function clerkPasswordErrorMessage(error) {
            return clerkAccountErrorMessage(error, 'Failed to update password.');
          }

          function initAccountPasswordForm() {
            const form = document.getElementById('account-password-form');
            if (!form) return;

            const passwordEnabled = form.dataset.passwordEnabled === 'true';
            const clerkEnabled = form.dataset.clerkEnabled === 'true';
            const errorEl = document.getElementById('account-password-error');
            const successEl = document.getElementById('account-password-success');
            const submitBtn = document.getElementById('account-password-submit');
            const currentInput = document.getElementById('account-current-password');
            const newInput = document.getElementById('account-new-password');
            const confirmInput = document.getElementById('account-confirm-password');
            const signOutCheckbox = document.getElementById('account-sign-out-sessions');

            function setMessage(el, message) {
              if (!el) return;
              if (message) {
                el.textContent = message;
                el.hidden = false;
              } else {
                el.textContent = '';
                el.hidden = true;
              }
            }

            function clearPasswordFields() {
              if (currentInput) currentInput.value = '';
              if (newInput) newInput.value = '';
              if (confirmInput) confirmInput.value = '';
            }

            form.addEventListener('submit', async (event) => {
              event.preventDefault();
              setMessage(errorEl, '');
              setMessage(successEl, '');

              if (!clerkEnabled) {
                setMessage(errorEl, 'Password changes require Clerk authentication.');
                return;
              }

              const newPassword = String(newInput?.value || '');
              const confirmPassword = String(confirmInput?.value || '');
              const currentPassword = String(currentInput?.value || '');

              if (passwordEnabled && !currentPassword) {
                setMessage(errorEl, 'Enter your current password.');
                currentInput?.focus();
                return;
              }
              if (!newPassword || newPassword.length < 8) {
                setMessage(errorEl, 'New password must be at least 8 characters.');
                newInput?.focus();
                return;
              }
              if (newPassword !== confirmPassword) {
                setMessage(errorEl, 'New password and confirmation do not match.');
                confirmInput?.focus();
                return;
              }
              if (passwordEnabled && currentPassword === newPassword) {
                setMessage(errorEl, 'New password must be different from your current password.');
                newInput?.focus();
                return;
              }

              const signOutOfOtherSessions = signOutCheckbox ? signOutCheckbox.checked : true;
              if (signOutOfOtherSessions && !window.confirm('You will be signed out of all other devices after this change. Continue?')) {
                return;
              }

              if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Updating...';
              }

              try {
                await window.authManager.initClerk();
                const user = window.Clerk?.user;
                if (!user) {
                  window.authManager.handleUnauthorized();
                  return;
                }

                const params = { newPassword, signOutOfOtherSessions };
                if (passwordEnabled) params.currentPassword = currentPassword;

                await user.updatePassword(params);
                clearPasswordFields();
                setMessage(successEl, passwordEnabled
                  ? 'Password updated successfully.'
                  : 'Password set successfully. You can now sign in with email and password.');
              } catch (error) {
                console.error('Password update failed:', error);
                setMessage(errorEl, clerkPasswordErrorMessage(error));
              } finally {
                if (submitBtn) {
                  submitBtn.disabled = false;
                  submitBtn.textContent = passwordEnabled ? 'Update password' : 'Set password';
                }
              }
            });
          }
          window.addEventListener('DOMContentLoaded', initAccountPasswordForm);
          window.addEventListener('DOMContentLoaded', initAccountEmailForm);

          window.__META_WA_CONNECT__ = ${metaConnectConfigJson};

          function initWhatsAppConnect() {
            const card = document.getElementById('wa-connect-card');
            if (!card) return;

            const config = window.__META_WA_CONNECT__ || {};
            const statusEl = document.getElementById('wa-connect-status');
            const errorEl = document.getElementById('wa-connect-error');
            const successEl = document.getElementById('wa-connect-success');
            const connectBtn = document.getElementById('wa-connect-btn');
            const disconnectBtn = document.getElementById('wa-connect-disconnect');
            const testBtn = document.getElementById('wa-connect-test');
            const detailsEl = document.getElementById('wa-connect-details');
            let pendingSignup = null;
            let pendingCode = null;

            function setInlineMessage(el, message) {
              if (!el) return;
              if (message) {
                el.textContent = message;
                el.hidden = false;
              } else {
                el.textContent = '';
                el.hidden = true;
              }
            }

            function renderStatus(data) {
              if (!data) return;
              const connected = !!data.connected;
              if (statusEl) {
                statusEl.innerHTML = connected
                  ? '<span class="wa-connect-status__dot wa-connect-status__dot--ok"></span><span><strong>Connected</strong></span>'
                  : '<span class="wa-connect-status__dot"></span><span><strong>Not connected</strong></span>';
              }
              if (connectBtn) connectBtn.textContent = connected ? 'Reconnect WhatsApp' : 'Connect WhatsApp';
              if (disconnectBtn) disconnectBtn.hidden = !connected;
              if (testBtn) testBtn.hidden = !connected;
              if (detailsEl) {
                detailsEl.hidden = !connected;
                const phoneId = document.getElementById('wa-connected-phone-id');
                const wabaId = document.getElementById('wa-connected-waba-id');
                const businessPhone = document.getElementById('wa-connected-business-phone');
                if (phoneId) phoneId.textContent = data.phoneNumberId || '—';
                if (wabaId) wabaId.textContent = data.wabaId || '—';
                if (businessPhone) businessPhone.textContent = data.businessPhone ? ('+' + String(data.businessPhone).replace(/\\D/g, '')) : '—';
              }
            }

            async function refreshStatus() {
              try {
                const resp = await window.authManager.authenticatedFetch('/api/settings/whatsapp/status', {
                  headers: { Accept: 'application/json' }
                });
                const data = await resp.json();
                if (resp.ok) renderStatus(data);
              } catch (_) {}
            }

            async function completeConnection() {
              if (!pendingCode || !pendingSignup?.phone_number_id) return;
              setInlineMessage(errorEl, '');
              setInlineMessage(successEl, '');
              if (connectBtn) {
                connectBtn.disabled = true;
                connectBtn.textContent = 'Connecting...';
              }
              try {
                const resp = await window.authManager.authenticatedFetch('/api/settings/whatsapp/connect', {
                  method: 'POST',
                  headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    code: pendingCode,
                    phone_number_id: pendingSignup.phone_number_id,
                    waba_id: pendingSignup.waba_id || null,
                    business_id: pendingSignup.business_id || null
                  })
                });
                const data = await resp.json();
                if (!resp.ok || !data.success) {
                  throw new Error(data.error || 'Failed to connect WhatsApp');
                }
                pendingSignup = null;
                pendingCode = null;
                setInlineMessage(successEl, 'WhatsApp connected successfully.');
                renderStatus(data.status || data);
                await refreshStatus();
                const verifyField = document.querySelector('input[name="verify_token"]');
                if (verifyField && data.verify_token) verifyField.value = data.verify_token;
                const phoneField = document.querySelector('input[name="phone_number_id"]');
                if (phoneField && data.phone_number_id) phoneField.value = data.phone_number_id;
                const wabaField = document.querySelector('input[name="waba_id"]');
                if (wabaField && data.waba_id) wabaField.value = data.waba_id;
                const businessPhoneField = document.querySelector('input[name="business_phone"]');
                if (businessPhoneField && data.business_phone) businessPhoneField.value = data.business_phone;
              } catch (error) {
                console.error('WhatsApp connect failed:', error);
                setInlineMessage(errorEl, error?.message || 'Failed to connect WhatsApp.');
              } finally {
                if (connectBtn) {
                  connectBtn.disabled = false;
                  connectBtn.textContent = 'Reconnect WhatsApp';
                }
              }
            }

            function tryCompleteConnection() {
              if (pendingCode && pendingSignup?.phone_number_id) {
                completeConnection();
              }
            }

            window.addEventListener('message', (event) => {
              if (!event.origin.endsWith('facebook.com')) return;
              try {
                const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
                if (payload?.type === 'WA_EMBEDDED_SIGNUP' && payload?.data) {
                  pendingSignup = payload.data;
                  tryCompleteConnection();
                }
              } catch (_) {}
            });

            function launchEmbeddedSignup() {
              if (!config.enabled) {
                setInlineMessage(errorEl, 'Embedded Signup is not configured. Add META_APP_ID, META_APP_SECRET, and META_EMBEDDED_SIGNUP_CONFIG_ID to your environment.');
                return;
              }
              if (!window.FB) {
                setInlineMessage(errorEl, 'Meta SDK is still loading. Please try again in a moment.');
                return;
              }
              setInlineMessage(errorEl, '');
              setInlineMessage(successEl, '');
              pendingSignup = null;
              pendingCode = null;
              window.FB.login((response) => {
                if (response?.authResponse?.code) {
                  pendingCode = response.authResponse.code;
                  tryCompleteConnection();
                  return;
                }
                if (response?.status === 'not_authorized' || response?.status === 'unknown') {
                  setInlineMessage(errorEl, 'Meta sign-in was cancelled.');
                }
              }, {
                config_id: config.configId,
                response_type: 'code',
                override_default_response_type: true,
                extras: { setup: {} }
              });
            }

            function loadFacebookSdk() {
              if (!config.enabled || !config.appId) return;
              window.fbAsyncInit = function() {
                window.FB.init({
                  appId: config.appId,
                  cookie: true,
                  xfbml: false,
                  version: config.graphVersion || 'v21.0'
                });
              };
              if (document.getElementById('facebook-jssdk')) return;
              const script = document.createElement('script');
              script.id = 'facebook-jssdk';
              script.async = true;
              script.defer = true;
              script.crossOrigin = 'anonymous';
              script.src = 'https://connect.facebook.net/en_US/sdk.js';
              document.body.appendChild(script);
            }

            connectBtn?.addEventListener('click', launchEmbeddedSignup);
            disconnectBtn?.addEventListener('click', async () => {
              if (!window.confirm('Disconnect WhatsApp from Code Orbit?')) return;
              setInlineMessage(errorEl, '');
              setInlineMessage(successEl, '');
              try {
                const resp = await window.authManager.authenticatedFetch('/api/settings/whatsapp/disconnect', {
                  method: 'POST',
                  headers: { Accept: 'application/json' }
                });
                const data = await resp.json();
                if (!resp.ok || !data.success) throw new Error(data.error || 'Disconnect failed');
                setInlineMessage(successEl, 'WhatsApp disconnected.');
                await refreshStatus();
              } catch (error) {
                setInlineMessage(errorEl, error?.message || 'Failed to disconnect WhatsApp.');
              }
            });
            testBtn?.addEventListener('click', async () => {
              setInlineMessage(errorEl, '');
              setInlineMessage(successEl, '');
              if (testBtn) {
                testBtn.disabled = true;
                testBtn.textContent = 'Testing...';
              }
              try {
                const resp = await window.authManager.authenticatedFetch('/api/settings/whatsapp/status?validate=1', {
                  headers: { Accept: 'application/json' }
                });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data.error || 'Connection test failed');
                if (data.tokenStatus === 'ok') {
                  setInlineMessage(successEl, 'Connection is healthy.');
                } else {
                  throw new Error(data.tokenMessage || 'Token is invalid or expired. Try reconnecting.');
                }
              } catch (error) {
                setInlineMessage(errorEl, error?.message || 'Connection test failed.');
              } finally {
                if (testBtn) {
                  testBtn.disabled = false;
                  testBtn.textContent = 'Test connection';
                }
              }
            });

            loadFacebookSdk();
            refreshStatus();
          }
          window.addEventListener('DOMContentLoaded', initWhatsAppConnect);
        </script>
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
                  <button type="button" class="settings-sidebar__link" data-settings-panel="business">Business information</button>
                </div>
                <div class="settings-sidebar__group">
                  <div class="settings-sidebar__label">WhatsApp</div>
                  <button type="button" class="settings-sidebar__link" data-settings-panel="whatsapp">Connection</button>
                  <button type="button" class="settings-sidebar__link" data-settings-panel="ai">AI preferences</button>
                  <button type="button" class="settings-sidebar__link" data-settings-panel="conversation">Conversation mode</button>
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
                      <p class="account-email-block__hint small">
                        ${signedInWithGoogle
                          ? 'You signed in with Google. To change your login email, add a new address, verify it, and it will become your primary email. Your Google sign-in will remain linked.'
                          : 'To change your primary email, add a new address and verify it with the code we send you.'}
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
                      <p class="account-security-block__hint small">
                        ${passwordEnabled
                          ? 'Update your sign-in password. For security, your current password is required.'
                          : 'You signed in without a password. Set one to also sign in with email and password.'}
                      </p>
                      ${CLERK_ENABLED ? `
                      <form id="account-password-form" class="account-password-form" data-password-enabled="${passwordEnabled ? 'true' : 'false'}" data-clerk-enabled="true" novalidate>
                        ${passwordEnabled ? `
                        <label>Current password
                          <div class="input-row">
                            <input type="password" id="account-current-password" autocomplete="current-password" class="settings-field" required />
                            <button type="button" class="btn-ghost" onclick="toggleReveal('account-current-password')" aria-label="Show current password"><img src="/show-password.svg" alt=""/></button>
                          </div>
                        </label>
                        ` : ''}
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
                        <button type="submit" class="btn-primary" id="account-password-submit">${passwordEnabled ? 'Update password' : 'Set password'}</button>
                      </form>
                      ` : `
                      <div class="small" style="color:#64748b;">Password management is unavailable because Clerk authentication is not configured.</div>
                      `}
                    </div>
                  </div>
                <form id="settings-main-form" method="post" action="/settings" onsubmit="event.preventDefault(); checkAuthThenSubmit(this).then(valid => { if(valid) this.submit(); }); return false;">
                  ${csrfField}
                  <div class="section settings-panel" id="business">
                    <h3>Business Information</h3>
                    <label>Business Name
                      <input placeholder="My Business" class="settings-field" name="business_name" value="${s.business_name || ''}"/>
                    </label>
                    <div class="grid-2" style="margin-top:8px;">
                      <label>Business Type
                        <select name="business_type" class="settings-field">
                          <option value="" ${(s.business_type||'')===''?'selected':''}></option>
                          <option value="Restaurant / Food" ${(s.business_type||'')==='Restaurant / Food'?'selected':''}>Restaurant / Food</option>
                          <option value="Retail / Ecommerce" ${(s.business_type||'')==='Retail / Ecommerce'?'selected':''}>Retail / Ecommerce</option>
                          <option value="Health / Wellness" ${(s.business_type||'')==='Health / Wellness'?'selected':''}>Health / Wellness</option>
                          <option value="Professional Services" ${(s.business_type||'')==='Professional Services'?'selected':''}>Professional Services</option>
                          <option value="Education" ${(s.business_type||'')==='Education'?'selected':''}>Education</option>
                          <option value="Real Estate" ${(s.business_type||'')==='Real Estate'?'selected':''}>Real Estate</option>
                          <option value="Automotive" ${(s.business_type||'')==='Automotive'?'selected':''}>Automotive</option>
                          <option value="Beauty / Salon" ${(s.business_type||'')==='Beauty / Salon'?'selected':''}>Beauty / Salon</option>
                          <option value="Nonprofit" ${(s.business_type||'')==='Nonprofit'?'selected':''}>Nonprofit</option>
                          <option value="Other" ${(s.business_type||'')==='Other'?'selected':''}>Other</option>
                        </select>
                      </label>
                      <label>Categories
                        <input placeholder="e.g., Italian, Takeout, Family-friendly" class="settings-field" name="business_categories" value="${businessCategoriesValue}"/>
                        <div class="small" style="color:#64748b; margin-top:4px;">Comma-separated; up to 20 categories.</div>
                      </label>
                    </div>
                    <label style="margin-top:8px;">Website URL
                      <input placeholder="https://www.example.com" class="settings-field" name="website_url" value="${s.website_url || ''}"/>
                    </label>
                    <label style="margin-top:8px;">Business Address
                      <div id="address-autocomplete-wrap" style="position:relative;">
                        <input id="business_address_input" placeholder="Start typing your address..." class="settings-field" name="business_address" value="${businessAddressValue}" autocomplete="off"/>
                        <div id="address-suggestions" style="display:none; position:absolute; left:0; right:0; top:100%; z-index:20; background:#fff; border:1px solid #e2e8f0; border-radius:8px; box-shadow:0 8px 24px rgba(15,23,42,.12); max-height:240px; overflow:auto;"></div>
                      </div>
                      <input type="hidden" name="business_latitude" id="business_latitude" value="${businessLatValue}"/>
                      <input type="hidden" name="business_longitude" id="business_longitude" value="${businessLngValue}"/>
                      <input type="hidden" name="business_place_id" id="business_place_id" value="${businessPlaceIdValue}"/>
                      <div class="small" style="color:#64748b; margin-top:4px;">
                        ${placesConfigured
                          ? "Type your address and pick a suggestion. Customers who ask for directions will receive a WhatsApp map pin."
                          : "Set GOOGLE_MAPS_API_KEY in your environment to enable address search and map pins for customers."}
                      </div>
                      <div id="address-selected-hint" class="small" style="color:#065f46; margin-top:4px; display:${businessLatValue && businessLngValue ? 'block' : 'none'};">Map pin saved for this address.</div>
                    </label>
                    ${placesConfigured ? `<script>
                      (function(){
                        const input = document.getElementById('business_address_input');
                        const list = document.getElementById('address-suggestions');
                        const latField = document.getElementById('business_latitude');
                        const lngField = document.getElementById('business_longitude');
                        const placeField = document.getElementById('business_place_id');
                        const hint = document.getElementById('address-selected-hint');
                        if (!input || !list) return;
                        let timer = null;
                        let sessionToken = crypto.randomUUID();
                        let selecting = false;

                        function clearCoords(){
                          if (selecting) return;
                          latField.value = '';
                          lngField.value = '';
                          placeField.value = '';
                          if (hint) hint.style.display = 'none';
                        }

                        function hideList(){
                          list.style.display = 'none';
                          list.innerHTML = '';
                        }

                        function showSuggestions(items){
                          if (!items.length) { hideList(); return; }
                          list.innerHTML = items.map(function(item){
                            return '<button type="button" class="address-suggestion" data-place-id="' + item.placeId.replace(/"/g, '&quot;') + '" style="display:block;width:100%;text-align:left;padding:10px 12px;border:0;background:#fff;cursor:pointer;border-bottom:1px solid #f1f5f9;">' + item.description.replace(/</g, '&lt;') + '</button>';
                          }).join('');
                          list.style.display = 'block';
                        }

                        async function fetchSuggestions(q){
                          try {
                            const resp = await fetch('/api/places/autocomplete?q=' + encodeURIComponent(q) + '&session=' + encodeURIComponent(sessionToken), { headers: { 'Accept': 'application/json' } });
                            const data = await resp.json();
                            if (!data.success) throw new Error(data.error || 'Autocomplete failed');
                            showSuggestions(Array.isArray(data.predictions) ? data.predictions : []);
                          } catch (err) {
                            console.error('Address autocomplete failed', err);
                            hideList();
                          }
                        }

                        async function selectPlace(placeId, label){
                          selecting = true;
                          try {
                            const resp = await fetch('/api/places/details?place_id=' + encodeURIComponent(placeId) + '&session=' + encodeURIComponent(sessionToken), { headers: { 'Accept': 'application/json' } });
                            const data = await resp.json();
                            if (!data.success || !data.place) throw new Error(data.error || 'Details failed');
                            input.value = data.place.address || label || input.value;
                            latField.value = String(data.place.latitude);
                            lngField.value = String(data.place.longitude);
                            placeField.value = data.place.placeId || placeId;
                            if (hint) hint.style.display = 'block';
                            sessionToken = crypto.randomUUID();
                          } catch (err) {
                            console.error('Address details failed', err);
                          } finally {
                            selecting = false;
                            hideList();
                          }
                        }

                        input.addEventListener('input', function(){
                          clearCoords();
                          const q = input.value.trim();
                          clearTimeout(timer);
                          if (q.length < 2) { hideList(); return; }
                          timer = setTimeout(function(){ fetchSuggestions(q); }, 250);
                        });

                        input.addEventListener('focus', function(){
                          const q = input.value.trim();
                          if (q.length >= 2) fetchSuggestions(q);
                        });

                        list.addEventListener('click', function(ev){
                          const btn = ev.target.closest('.address-suggestion');
                          if (!btn) return;
                          const placeId = btn.getAttribute('data-place-id');
                          const label = btn.textContent || '';
                          if (placeId) selectPlace(placeId, label);
                        });

                        document.addEventListener('click', function(ev){
                          if (!document.getElementById('address-autocomplete-wrap')?.contains(ev.target)) hideList();
                        });
                      })();
                    </script>` : ''}
                    ${placesConfigured ? `
                    <div class="google-business-import" style="margin-top:16px; padding:16px; border:1px solid #e2e8f0; border-radius:12px; background:#f8fafc;">
                      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap;">
                        <div>
                          <div style="font-weight:600; color:#0f172a; margin-bottom:4px;">Import from Google Business</div>
                          <div class="small" style="color:#64748b; max-width:520px;">
                            Search your listing on Google to import name, address, phone, website, hours, categories, and reviews into settings and your Knowledge Base.
                          </div>
                          ${googleProfileSyncedAt ? `<div class="small" style="color:#065f46; margin-top:8px;">Last imported${googleProfileName ? ` (${escapeHtml(googleProfileName)})` : ""}: ${escapeHtml(googleProfileSyncedAt)}</div>` : ""}
                        </div>
                      </div>
                      <div style="position:relative; margin-top:12px;">
                        <input id="google-business-search" class="settings-field" placeholder="Search your business on Google..." autocomplete="off" />
                        <div id="google-business-suggestions" style="display:none; position:absolute; left:0; right:0; top:100%; z-index:25; background:#fff; border:1px solid #e2e8f0; border-radius:8px; box-shadow:0 8px 24px rgba(15,23,42,.12); max-height:260px; overflow:auto;"></div>
                      </div>
                      <div id="google-business-preview" style="display:none; margin-top:14px; padding:14px; border:1px solid #dbeafe; border-radius:10px; background:#eff6ff;">
                        <div style="font-weight:600; color:#1e3a8a; margin-bottom:8px;">Preview</div>
                        <div id="google-business-preview-body" class="small" style="color:#1e3a8a; white-space:pre-wrap;"></div>
                        <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;">
                          <button type="button" class="btn-primary" id="google-business-import-btn">Import to bot</button>
                          <button type="button" class="btn-ghost" id="google-business-cancel-btn">Cancel</button>
                        </div>
                      </div>
                      <div id="google-business-status" class="small" style="margin-top:8px; color:#64748b;"></div>
                    </div>
                    <script>
                      (function(){
                        const search = document.getElementById('google-business-search');
                        const list = document.getElementById('google-business-suggestions');
                        const preview = document.getElementById('google-business-preview');
                        const previewBody = document.getElementById('google-business-preview-body');
                        const importBtn = document.getElementById('google-business-import-btn');
                        const cancelBtn = document.getElementById('google-business-cancel-btn');
                        const statusEl = document.getElementById('google-business-status');
                        if (!search || !list || !preview) return;
                        let timer = null;
                        let sessionToken = crypto.randomUUID();
                        let selectedPlaceId = null;

                        function setStatus(msg, tone){
                          if (!statusEl) return;
                          statusEl.textContent = msg || '';
                          statusEl.style.color = tone === 'error' ? '#991b1b' : tone === 'success' ? '#065f46' : '#64748b';
                        }

                        function hideSuggestions(){
                          list.style.display = 'none';
                          list.innerHTML = '';
                        }

                        function hidePreview(){
                          preview.style.display = 'none';
                          selectedPlaceId = null;
                          if (previewBody) previewBody.textContent = '';
                        }

                        function renderPreview(data){
                          if (!data) return;
                          const lines = [];
                          if (data.name) lines.push('Name: ' + data.name);
                          if (data.address) lines.push('Address: ' + data.address);
                          if (data.phone) lines.push('Phone: ' + data.phone);
                          if (data.website) lines.push('Website: ' + data.website);
                          if (data.rating != null) lines.push('Rating: ' + data.rating + (data.ratingCount ? ' (' + data.ratingCount + ' reviews)' : ''));
                          if (data.inferredBusinessType) lines.push('Business type: ' + data.inferredBusinessType);
                          if (Array.isArray(data.categories) && data.categories.length) lines.push('Categories: ' + data.categories.join(', '));
                          if (data.description) lines.push('\\nAbout:\\n' + data.description);
                          if (Array.isArray(data.openingHours) && data.openingHours.length) lines.push('\\nHours:\\n' + data.openingHours.join('\\n'));
                          if (Array.isArray(data.kbArticles) && data.kbArticles.length) {
                            lines.push('\\nKnowledge Base articles to update:\\n' + data.kbArticles.map(function(a){ return '- ' + a.title; }).join('\\n'));
                          }
                          previewBody.textContent = lines.join('\\n');
                          preview.style.display = 'block';
                        }

                        async function fetchBusinessSuggestions(q){
                          try {
                            const resp = await fetch('/api/google-business/search?q=' + encodeURIComponent(q) + '&session=' + encodeURIComponent(sessionToken), { headers: { 'Accept': 'application/json' } });
                            const data = await resp.json();
                            if (!data.success) throw new Error(data.error || 'Search failed');
                            const items = Array.isArray(data.predictions) ? data.predictions : [];
                            if (!items.length) { hideSuggestions(); return; }
                            list.innerHTML = items.map(function(item){
                              const label = (item.mainText || item.description || '').replace(/</g, '&lt;');
                              const sub = (item.secondaryText || '').replace(/</g, '&lt;');
                              return '<button type="button" class="google-business-suggestion" data-place-id="' + item.placeId.replace(/"/g, '&quot;') + '" style="display:block;width:100%;text-align:left;padding:10px 12px;border:0;background:#fff;cursor:pointer;border-bottom:1px solid #f1f5f9;"><div style="font-weight:600;color:#0f172a;">' + label + '</div>' + (sub ? '<div class="small" style="color:#64748b;">' + sub + '</div>' : '') + '</button>';
                            }).join('');
                            list.style.display = 'block';
                          } catch (err) {
                            console.error('Google business search failed', err);
                            hideSuggestions();
                            setStatus('Could not search Google. Try again.', 'error');
                          }
                        }

                        async function loadPreview(placeId){
                          setStatus('Loading business details...');
                          try {
                            const resp = await fetch('/api/google-business/preview?place_id=' + encodeURIComponent(placeId) + '&session=' + encodeURIComponent(sessionToken), { headers: { 'Accept': 'application/json' } });
                            const data = await resp.json();
                            if (!data.success || !data.preview) throw new Error(data.error || 'Preview failed');
                            selectedPlaceId = placeId;
                            renderPreview(data.preview);
                            setStatus('Review the preview, then import to update your bot.');
                          } catch (err) {
                            console.error('Google business preview failed', err);
                            hidePreview();
                            setStatus(err.message || 'Could not load business details.', 'error');
                          }
                        }

                        search.addEventListener('input', function(){
                          hidePreview();
                          selectedPlaceId = null;
                          const q = search.value.trim();
                          clearTimeout(timer);
                          if (q.length < 2) { hideSuggestions(); return; }
                          timer = setTimeout(function(){ fetchBusinessSuggestions(q); }, 250);
                        });

                        list.addEventListener('click', function(ev){
                          const btn = ev.target.closest('.google-business-suggestion');
                          if (!btn) return;
                          const placeId = btn.getAttribute('data-place-id');
                          if (!placeId) return;
                          search.value = btn.querySelector('div')?.textContent || search.value;
                          hideSuggestions();
                          loadPreview(placeId);
                        });

                        if (cancelBtn) cancelBtn.addEventListener('click', function(){
                          hidePreview();
                          setStatus('');
                        });

                        if (importBtn) importBtn.addEventListener('click', async function(){
                          if (!selectedPlaceId) return;
                          importBtn.disabled = true;
                          setStatus('Importing...');
                          try {
                            const resp = await fetch('/api/google-business/import', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                              body: JSON.stringify({ place_id: selectedPlaceId, session: sessionToken })
                            });
                            const data = await resp.json();
                            if (!data.success) throw new Error(data.error || 'Import failed');
                            setStatus('Imported successfully. Reloading...', 'success');
                            sessionToken = crypto.randomUUID();
                            setTimeout(function(){ window.location.href = '/settings?saved=1&google_import=1#business'; }, 700);
                          } catch (err) {
                            console.error('Google business import failed', err);
                            setStatus(err.message || 'Import failed.', 'error');
                          } finally {
                            importBtn.disabled = false;
                          }
                        });

                        document.addEventListener('click', function(ev){
                          if (!search.contains(ev.target) && !list.contains(ev.target)) hideSuggestions();
                        });
                      })();
                    </script>
                    ` : `
                    <div class="small" style="margin-top:12px; color:#64748b;">
                      Set <code>GOOGLE_MAPS_API_KEY</code> to enable Google Business import.
                    </div>`}
                  </div>
                  <div class="section settings-panel" id="whatsapp">
                    <h3>WhatsApp Setup</h3>

                    <div id="wa-connect-card" class="wa-connect-card">
                      <div class="wa-connect-card__header">
                        <div>
                          <div class="wa-connect-card__title">WhatsApp connection</div>
                          <p class="wa-connect-card__hint small">Each workspace connects its own WhatsApp Business account. You will sign in with <strong>your</strong> Meta/Facebook account and choose your business phone number — not the platform owner’s account.</p>
                        </div>
                        <div id="wa-connect-status" class="wa-connect-status">
                          <span class="wa-connect-status__dot ${waConnection.connected ? 'wa-connect-status__dot--ok' : ''}"></span>
                          <span><strong>${waConnection.connected ? 'Connected' : 'Not connected'}</strong></span>
                        </div>
                      </div>

                      <div id="wa-connect-details" class="wa-connect-details" ${waConnection.connected ? '' : 'hidden'}>
                        <div><span class="wa-connect-details__label">Phone number ID</span><code id="wa-connected-phone-id">${escapeHtml(String(s.phone_number_id || '—'))}</code></div>
                        <div><span class="wa-connect-details__label">WABA ID</span><code id="wa-connected-waba-id">${escapeHtml(String(s.waba_id || '—'))}</code></div>
                        <div><span class="wa-connect-details__label">Business phone</span><code id="wa-connected-business-phone">${s.business_phone ? escapeHtml('+' + String(s.business_phone).replace(/\D/g, '')) : '—'}</code></div>
                      </div>

                      <div id="wa-connect-error" class="account-password-form__message account-password-form__message--error" hidden></div>
                      <div id="wa-connect-success" class="account-password-form__message account-password-form__message--success" hidden></div>

                      <div class="wa-connect-card__actions">
                        <button type="button" class="btn-primary" id="wa-connect-btn">${waConnection.connected ? 'Reconnect WhatsApp' : 'Connect WhatsApp'}</button>
                        <button type="button" class="btn-ghost" id="wa-connect-test" ${waConnection.connected ? '' : 'hidden'}>Test connection</button>
                        <button type="button" class="btn-ghost" id="wa-connect-disconnect" ${waConnection.connected ? '' : 'hidden'}>Disconnect</button>
                      </div>

                      <div class="small wa-connect-card__setup-note">
                        Platform Meta app credentials (<code>META_APP_ID</code>, etc.) identify Code Orbit in Meta’s system only. Each customer still authorizes their own WhatsApp Business Account during connect.
                        ${META_EMBEDDED_SIGNUP_ENABLED ? '' : ' Set those env vars on the server to enable one-click connect, or use manual setup below.'}
                      </div>

                      <div class="small wa-connect-card__webhook-note">
                        <strong>Webhook URL:</strong> <code>${escapeHtml(waWebhookUrl)}</code>
                        ${waVerifyToken ? `<span style="margin-left:8px;"><strong>Verify token:</strong> <code>${escapeHtml(waVerifyToken)}</code></span>` : '<span style="margin-left:8px;">A verify token is generated automatically when you connect.</span>'}
                      </div>
                    </div>

                    <details class="wa-manual-setup">
                      <summary class="wa-manual-setup__summary">Advanced manual setup</summary>
                      <p class="small wa-manual-setup__hint">Use this only if Embedded Signup is unavailable or you are migrating an existing Meta app configuration.</p>
                      <label>Phone Number ID
                        <input placeholder="8***************" class="settings-field" name="phone_number_id" value="${s.phone_number_id || ''}"/>
                      </label>
                      <label>WABA ID
                        <input placeholder="2208283003006315" class="settings-field" name="waba_id" value="${s.waba_id || ''}"/>
                      </label>
                      <label>Business Phone
                        <input placeholder="1***************" class="settings-field" name="business_phone" value="${s.business_phone || ''}"/>
                      </label>
                      <label>WhatsApp Token
                        <div class="input-row">
                          <input id="wa_token" type="password" placeholder="E***************" class="settings-field" name="whatsapp_token" value="${s.whatsapp_token || ''}"/>
                          <button type="button" class="btn-ghost" onclick="toggleReveal('wa_token')" aria-label="Reveal token"><img src="/show-password.svg" alt=""/></button>
                          <button type="button" class="btn-ghost" onclick="copyValue('wa_token')" aria-label="Copy token"><img src="/copy-icon.svg" alt=""/></button>
                        </div>
                      </label>
                      <label>Verify Token
                        <input placeholder="Auto-generated on connect" class="settings-field" name="verify_token" value="${s.verify_token || ''}"/>
                      </label>
                    </details>

                    <div style="margin-top:20px; padding:16px; background:#f8fafc; border-radius:8px;">
                      <h4 style="margin:0 0 8px 0;">Staff WhatsApp Group</h4>
                      <p class="small" style="margin:0 0 12px 0; color:#64748b;">
                        Post new reservations to a staff group. The bot ignores all other group messages.
                        Requires Meta <strong>Groups API</strong> (Official Business Account, Cloud API-only number).
                      </p>
                      <label style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
                        <input type="hidden" name="staff_whatsapp_group_enabled" value="0"/>
                        <input type="checkbox" name="staff_whatsapp_group_enabled" value="1" ${s.staff_whatsapp_group_enabled ? 'checked' : ''}/>
                        Enable staff group booking alerts
                      </label>
                      <div class="small" style="margin-bottom:8px;">
                        <strong>Status:</strong>
                        ${s.staff_whatsapp_group_id
                          ? `<span style="color:#065f46;">Connected</span> — <code style="font-size:11px;">${String(s.staff_whatsapp_group_id).slice(0, 24)}${String(s.staff_whatsapp_group_id).length > 24 ? '…' : ''}</code>`
                          : `<span style="color:#92400e;">Not connected</span>`}
                      </div>
                      <div id="staff-group-support" class="small" style="margin-bottom:12px; color:#64748b;"></div>
                      <button type="button" class="btn-ghost" id="staff-group-check" style="margin-bottom:12px;">Check Groups API support</button>
                      <div class="small" style="margin-bottom:12px; padding:10px 12px; background:#eff6ff; border-radius:6px; color:#1e40af;">
                        <strong>Coexistence (WhatsApp app + bot):</strong> When staff reply from the WhatsApp Business app,
                        Code Orbit auto-enables <strong>Live mode</strong> for that customer (bot stays quiet).
                        Subscribe to <code>smb_message_echoes</code> (and optionally <code>message_echoes</code>) in Meta → Webhooks.
                      </div>
                      <div class="small" style="margin-bottom:12px; padding:10px 12px; background:#fff7ed; border-radius:6px; color:#9a3412;">
                        <strong>Important:</strong> Your business number (${s.business_phone ? `+${String(s.business_phone).replace(/\D/g, '')}` : 'configure Business Phone above'}) must appear as a <em>member</em> in the group before CONNECT works.
                        If the group shows only <strong>1 member</strong>, the bot is not in the group yet and CONNECT will do nothing.
                        A single grey checkmark on your message also means it was not delivered to the bot.
                      </div>
                      <ol class="small" style="margin:0 0 12px 18px; color:#64748b; padding:0;">
                        <li>Create or use a group where your business number is actually joined (2+ members)</li>
                        <li>Send <code>CONNECT</code> in that group</li>
                        <li>The bot replies once and saves the group ID automatically</li>
                      </ol>
                      <script>
                      (function(){
                        const statusEl = document.getElementById('staff-group-support');
                        const checkBtn = document.getElementById('staff-group-check');
                        if (!checkBtn || !statusEl) return;
                        checkBtn.addEventListener('click', async function(){
                          checkBtn.disabled = true;
                          statusEl.textContent = 'Checking Groups API…';
                          try {
                            const resp = await fetch('/api/settings/staff-group/support', { headers: { 'Accept': 'application/json' } });
                            const data = await resp.json();
                            if (!resp.ok) throw new Error(data.error || data.message || 'Check failed');
                            statusEl.innerHTML = data.supported
                              ? '<span style="color:#065f46;">✓ ' + (data.message || 'Groups API supported') + '</span>'
                              : '<span style="color:#991b1b;">✗ ' + (data.message || 'Groups API not available on this number') + '</span>';
                          } catch (err) {
                            statusEl.innerHTML = '<span style="color:#991b1b;">✗ ' + (err.message || 'Check failed') + '</span>';
                          } finally {
                            checkBtn.disabled = false;
                          }
                        });
                      })();
                      </script>
                      ${s.staff_whatsapp_group_id ? `
                      <button type="button" class="btn-ghost" id="staff-group-disconnect" style="margin-top:4px;">Disconnect group</button>
                      <script>
                      (function(){
                        const btn = document.getElementById('staff-group-disconnect');
                        if (!btn) return;
                        btn.addEventListener('click', async function(){
                          if (!confirm('Disconnect staff group notifications?')) return;
                          btn.disabled = true;
                          try {
                            const resp = await fetch('/api/settings/staff-group/disconnect', { method: 'POST', headers: { 'Accept': 'application/json' } });
                            const data = await resp.json();
                            if (!data.success) throw new Error(data.error || 'Disconnect failed');
                            window.location.href = '/settings?saved=1#whatsapp';
                          } catch (err) {
                            alert(err.message || 'Could not disconnect group');
                            btn.disabled = false;
                          }
                        });
                      })();
                      </script>
                      ` : ''}
                      <details style="margin-top:12px;">
                        <summary class="small" style="cursor:pointer; color:#64748b;">Advanced: paste group ID manually</summary>
                        <label style="display:block; margin-top:8px;">
                          Group ID
                          <input class="settings-field" name="staff_whatsapp_group_id" value="${(s.staff_whatsapp_group_id || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}" placeholder="Paste group_id from webhook logs"/>
                        </label>
                      </details>
                    </div>
                  </div>

                  <!-- Website section removed (Website URL moved to Business Information) -->

                  <div class="section settings-panel" id="ai">
                    <h3>AI Preferences</h3>
                    <div class="grid-2">
                      <label>AI Tone
                        <input placeholder="friendly, professional, playful" class="settings-field" name="ai_tone" value="${s.ai_tone || ''}"/>
                      </label>
                      <label>AI Blocked Topics
                        <input placeholder="refunds, medical" class="settings-field" name="ai_blocked_topics" value="${s.ai_blocked_topics || ''}"/>
                      </label>
                    </div>
                    <label>AI Style Notes
                      <input placeholder="use emojis, keep answers under 2 lines" class="settings-field" name="ai_style" value="${s.ai_style || ''}"/>
                    </label>
                  </div>
                  <div class="section settings-panel" id="conversation">
                    <h3>Conversation Mode</h3>
                    <div class="small" style="margin-bottom:12px;">Choose how the chatbot should respond to customer messages:</div>
                    <label style="display:block; margin-bottom:12px; padding:12px; border:none; border-radius:8px; ${!isUpgraded ? 'opacity:0.6; cursor:not-allowed; position:relative;' : 'cursor:pointer;'} ${effectiveConversationMode === 'full' ? 'background:#f0f9ff;' : ''}">
                      <input type="radio" name="conversation_mode" value="full" ${effectiveConversationMode === 'full' ? 'checked' : ''} ${!isUpgraded ? 'disabled' : ''} style="margin-right:8px;"/>
                      <strong>Full AI Assistant (Knowledge Base + Bookings)</strong>
                      ${!isUpgraded ? `<span class="small" style="margin-left:8px; color:#f59e0b; display:inline-flex; align-items:center; gap:4px;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                          <circle cx="12" cy="16" r="1"/>
                          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                        </svg>
                        Upgrade to enable
                      </span>` : ''}
                      <div class="small" style="margin-top:4px; margin-left:24px;">Answers from your knowledge base and handles reservations in natural conversation — the bot collects date, time, name, and party size without forms or slot menus.</div>
                    </label>
                    <label style="display:block; margin-bottom:12px; padding:12px; border:none; border-radius:8px; cursor:pointer; ${effectiveConversationMode === 'escalation' ? 'background:#f0f9ff;' : ''}">
                      <input type="radio" name="conversation_mode" value="escalation" ${effectiveConversationMode === 'escalation' ? 'checked' : ''} style="margin-right:8px;"/>
                      <strong>Simple Escalation Mode</strong>
                      <div class="small" style="margin-top:4px; margin-left:24px;">The chatbot immediately escalates customers to human support. If support is available (within working hours), it escalates right away. If not, it informs the customer when support will be available next.</div>
                    </label>
          <div class="small" style="margin-top:12px; padding:12px; background:#f8fafc; border:none; border-radius:6px; ${effectiveConversationMode === 'escalation' ? '' : 'display:none;'}" id="escalation_info">
            <strong>Note:</strong> In Simple Escalation Mode, the bot will use your <strong>Staff working hours</strong> (configured below) to determine when customer support is available. Make sure you have at least one staff member configured with working hours.
          </div>
          
          <!-- Escalation Mode Messages -->
          <div style="margin-top:16px; padding:12px; ${effectiveConversationMode === 'escalation' ? '' : 'display:none;'}" id="escalation_messages">
            <h4 style="margin:0 0 12px 0;">Escalation Messages</h4>
            
            <label style="display:block; margin-bottom:8px;">
              <div class="small" style="margin-bottom:4px;">Additional Message (during working hours)</div>
              <input class="settings-field" type="text" name="escalation_additional_message" placeholder="Got it. I'm connecting you with a human. Please wait a moment." value="${s.escalation_additional_message || ''}" style="margin-bottom:8px;"/>
              <div class="small" style="color:#6b7280;">This message is sent when support is available during escalation.</div>
            </label>
            
            <label style="display:block; margin-bottom:8px;">
              <div class="small" style="margin-bottom:4px;">Out of Hours Message</div>
              <input class="settings-field" type="text" name="escalation_out_of_hours_message" placeholder="We are out of our working time we will reach you as soon as we can" value="${s.escalation_out_of_hours_message || ''}" style="margin-bottom:8px;"/>
              <div class="small" style="color:#6b7280;">This message will be sent when support is not available.</div>
            </label>
            
            <label style="display:block; margin-bottom:8px;">
              <div class="small" style="margin-bottom:4px;">Escalation Questions (one per line)</div>
              <textarea class="settings-field" name="escalation_questions_json" placeholder="What's your name?&#10;What's the reason for contacting support today?&#10;What's your phone number?" rows="4" style="margin-bottom:8px;">${(() => {
                try {
                  const questions = JSON.parse(s.escalation_questions_json || '[]');
                  return questions.join('\n');
                } catch {
                  return '';
                }
              })()}</textarea>
              <div class="small" style="color:#6b7280;">Enter each question on a new line. These questions will be asked during the escalation process.</div>
            </label>
          </div>
                  </div>
                  <div class="section settings-panel" id="holidays">
                    <h3>Holidays & Closures</h3>
                    <div class="small" style="margin-bottom:8px;">Add holiday name, date and business closed time window.</div>
                    <div id="holiday-rows" style="display:grid; grid-template-columns: 1.2fr 0.8fr 0.5fr 0.5fr auto; gap:8px; align-items:center;">
                      <div class="text-xs" style="color:#6b7280;">Name</div>
                      <div class="text-xs" style="color:#6b7280;">Date (YYYY-MM-DD)</div>
                      <div class="text-xs" style="color:#6b7280;">Start (HH:MM)</div>
                      <div class="text-xs" style="color:#6b7280;">End (HH:MM)</div>
                      <div></div>
                      ${(() => { 
                        let rules=[]; 
                        try{ rules = JSON.parse(s.holidays_rules_json||'[]'); }catch{}
                        if(!Array.isArray(rules) || !rules.length){ rules = [{ name:'', date:'', start:'', end:'' }]; }
                        return rules.map((r,i)=>`
                          <input class=\"settings-field\" name=\"holiday_name\" value=\"${(r.name||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;')}\" placeholder=\"Christmas\" />
                          <input class=\"settings-field\" name=\"holiday_date\" value=\"${r.date||''}\" placeholder=\"2025-12-25\" />
                          <input class=\"settings-field\" name=\"holiday_start\" value=\"${r.start||''}\" placeholder=\"00:00\" />
                          <input class=\"settings-field\" name=\"holiday_end\" value=\"${r.end||''}\" placeholder=\"23:59\" />
                          <button type=\"button\" class=\"btn-ghost\" onclick=\"removeHolidayRow(this)\" style=\"border:none;\">Remove</button>
                        `).join('');
                      })()}
                    </div>
                    <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
                      <button type="button" onclick="addHolidayRow()" class="btn-primary">Add Holiday</button>
                      <div class="small">On matching dates and times the bot will send your Out of Hours Message.</div>
                    </div>
                    <script>
                      function addHolidayRow(){
                        const c = document.getElementById('holiday-rows');
                        const tpl = '<input class="settings-field" name="holiday_name" placeholder="Christmas" />'
                          + '<input class="settings-field" name="holiday_date" placeholder="2025-12-25" />'
                          + '<input class="settings-field" name="holiday_start" placeholder="00:00" />'
                          + '<input class="settings-field" name="holiday_end" placeholder="23:59" />'
                          + '<button type="button" class="btn-ghost" onclick="removeHolidayRow(this)">Remove</button>';
                        c.insertAdjacentHTML('beforeend', tpl);
                      }
                      function removeHolidayRow(btn){
                        const c = document.getElementById('holiday-rows');
                        const cells = Array.from(c.children);
                        const idx = cells.indexOf(btn);
                        if(idx >= 0){
                          // Each row is 5 elements
                          const rowStart = idx - 4;
                          for(let i=0;i<5;i++){
                            if(c.children[rowStart]) c.removeChild(c.children[rowStart]);
                          }
                        }
                      }
                    </script>
                    <div style="margin-top:16px;">
                      <h4 style="margin:0 0 6px 0;">Closed dates (full-day)</h4>
                      <div id="closedDatesList" class="list" style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;"></div>
                      <div class="input-inline" style="display:flex; gap:8px; align-items:center;">
                        <input type="date" id="closedDateInput" class="settings-field" style="max-width:220px;" />
                        <button type="button" class="btn-ghost" id="addClosedDateBtn">Add</button>
                      </div>
                      <textarea name="closed_dates_json" id="closed_dates_json" rows="2" style="display:none;">${(() => {
                        try { return (s.closed_dates_json || '[]').replace(/</g, '&lt;'); } catch { return '[]'; }
                      })()}</textarea>
                      <div class="small">Tip: click a chip to remove a date.</div>
                    </div>
                    <script>
                      (function(){
                        function parseJson(v, def){ try { return JSON.parse(String(v||'').trim()||'[]'); } catch(_) { return def; } }
                        function setHidden(id, arr){ document.getElementById(id).value = JSON.stringify(arr||[]); }
                        function chip(text){ var b=document.createElement('button'); b.type='button'; b.className='chip'; b.textContent=text; return b; }
                        var closedArr = parseJson(document.getElementById('closed_dates_json').value, []);
                        var closedList = document.getElementById('closedDatesList');
                        function renderClosed(){
                          closedList.innerHTML='';
                          (closedArr||[]).forEach(function(d,idx){
                            var c=chip(d);
                            c.onclick=function(){ closedArr.splice(idx,1); renderClosed(); };
                            closedList.appendChild(c);
                          });
                          setHidden('closed_dates_json', closedArr);
                        }
                        document.getElementById('addClosedDateBtn').onclick = function(){
                          var v=document.getElementById('closedDateInput').value;
                          if(!v) return;
                          if(!closedArr.includes(v)) closedArr.push(v);
                          document.getElementById('closedDateInput').value='';
                          renderClosed();
                        };
                        renderClosed();
                      })();
                    </script>
                  </div>
                  <div class="section settings-panel" id="bookings_section">
                    <h3>Reservations</h3>
                    ${bookingsLocked ? `
                      <div class="small" style="margin:0 0 16px 0; padding:12px 14px; border:1px dashed #fecaca; background:#fff1f2; color:#991b1b; border-radius:8px; line-height:1.5;">
                        Reservations are available in <strong>Full AI Assistant</strong> mode only. Switch conversation mode above, or <a href="/plan">upgrade your plan</a> if Full mode is locked.
                      </div>
                      <input type="hidden" name="bookings_enabled" value="0"/>
                    ` : `
                      <input type="hidden" name="bookings_enabled" value="1"/>
                      <p class="small" style="margin:0 0 16px 0; color:#374151; line-height:1.55;">
                        Customers book by chatting naturally (e.g. &ldquo;nesër në orën 8&rdquo;). The AI confirms availability, then collects name, party size, and occasion — no scripted questions or slot pickers.
                      </p>

                      <div style="padding:14px; background:#f8fafc; border-radius:10px; margin-bottom:18px;">
                        <div class="text-sm" style="font-weight:600; margin-bottom:10px;">Setup checklist</div>
                        <ul class="text-sm" style="margin:0; padding-left:18px; color:#374151; line-height:var(--line-height-relaxed);">
                          <li>${staff.length ? `${staff.length} staff member${staff.length === 1 ? '' : 's'} configured` : '<strong>Add staff</strong> with working hours in the <a href="#staff">Staff</a> section below'}</li>
                        </ul>
                      </div>

                      <h4 class="text-sm" style="margin:0 0 10px 0;">Scheduling rules</h4>
                      <div class="grid-2" style="gap:12px;">
                        <label>How far ahead customers can book (days)
                          <input type="number" min="1" max="365" step="1" class="settings-field" name="booking_days_ahead" value="${bookingDaysAhead}" />
                          <span class="small" style="color:#6b7280;">e.g. 60 = up to two months ahead</span>
                        </label>
                        <label>Max reservations per staff per day
                          <input type="number" min="0" max="500" step="1" class="settings-field" name="booking_max_per_day" value="${bookingMaxPerDay}" />
                          <span class="small" style="color:#6b7280;">0 = unlimited</span>
                        </label>
                        <label style="grid-column: 1 / -1;">Time slot step (for availability checks)
                          <select name="booking_display_interval_minutes" class="settings-field">
                            ${[15,20,30,40,60,90,120].map(v=>`<option value="${v}" ${displayInterval===v?'selected':''}>${v===60?'1 hour':(v===120?'2 hours':v+' minutes')}</option>`).join('')}
                          </select>
                          <span class="small" style="color:#6b7280;">Should match your typical appointment length. Staff slot minutes also apply.</span>
                        </label>
                      </div>

                      <details class="booking-advanced" style="margin-top:18px; padding:12px 14px; border:1px solid #e5e7eb; border-radius:10px; background:#fff;">
                        <summary class="text-sm" style="cursor:pointer; font-weight:600;">Advanced options</summary>
                        <div style="margin-top:14px; display:grid; gap:16px;">
                          <div>
                            <div class="text-sm" style="font-weight:600; margin-bottom:8px;">Capacity limits</div>
                            <p class="small" style="margin:0 0 10px 0; color:#6b7280;">Optional caps for busy periods (e.g. restaurant covers per hour).</p>
                            <div class="grid-2" style="gap:12px;">
                              <label>Time window
                                <select name="booking_capacity_window_minutes" class="settings-field">
                                  ${[30,60,90,120].map(v=>`<option value="${v}" ${capacityWindow===v?'selected':''}>${v===60?'1 hour':(v+' minutes')}</option>`).join('')}
                                </select>
                              </label>
                              <label>Max bookings in window
                                <input type="number" min="0" step="1" class="settings-field" name="booking_capacity_limit" value="${capacityLimit}" />
                                <span class="small" style="color:#6b7280;">0 = no limit</span>
                              </label>
                            </div>
                          </div>

                          <label style="display:flex; gap:8px; align-items:flex-start;">
                            <input type="hidden" name="waitlist_enabled" value="0"/>
                            <input type="checkbox" name="waitlist_enabled" value="1" ${waitlistEnabled ? 'checked' : ''} style="margin-top:3px;" />
                            <span>
                              <strong>Waitlist</strong>
                              <span class="small" style="display:block; color:#6b7280; margin-top:2px;">Notify customers if an earlier slot opens after a cancellation.</span>
                            </span>
                          </label>

                          <div>
                            <div class="text-sm" style="font-weight:600; margin-bottom:8px;">Changes &amp; cancellations</div>
                            <div class="grid-2" style="gap:12px;">
                              <label>Minimum notice to reschedule (minutes)
                                <input class="settings-field" type="number" min="0" step="5" name="reschedule_min_lead_minutes" value="${Number(s.reschedule_min_lead_minutes||60)}"/>
                              </label>
                              <label>Minimum notice to cancel (minutes)
                                <input class="settings-field" type="number" min="0" step="5" name="cancel_min_lead_minutes" value="${Number(s.cancel_min_lead_minutes||60)}"/>
                              </label>
                            </div>
                          </div>

                          <div>
                            <div class="text-sm" style="font-weight:600; margin-bottom:8px;">Service menu (optional)</div>
                            <p class="small" style="margin:0 0 8px 0; color:#6b7280;">If you offer named services, the AI can mention them when customers ask about options.</p>
                            <div id="servicesList" class="list" style="display:flex; flex-direction:column; gap:6px; margin-bottom:8px;"></div>
                            <div class="input-inline" style="display:flex; gap:8px; flex-wrap:wrap;">
                              <input type="text" id="serviceName" class="settings-field" placeholder="Name (e.g. Agrotourism lunch)" />
                              <input type="number" id="serviceMinutes" class="settings-field" placeholder="Minutes" min="5" step="5" style="max-width:120px;" />
                              <input type="text" id="servicePrice" class="settings-field" placeholder="Price (optional)" style="max-width:140px;" />
                              <button type="button" class="btn" id="addServiceBtn">Add</button>
                            </div>
                            <textarea name="services_json" id="services_json" rows="2" style="display:none;">${escapeHtml(servicesJson)}</textarea>
                          </div>

                          <div>
                            <div class="text-sm" style="font-weight:600; margin-bottom:8px;">Appointment reminders</div>
                            <label style="display:flex; gap:8px; align-items:flex-start; margin-bottom:8px;">
                              <input type="hidden" name="reminders_enabled" value="0"/>
                              <input type="checkbox" name="reminders_enabled" value="1" ${s.reminders_enabled ? 'checked' : ''} style="margin-top:3px;" />
                              <span class="small" style="color:#374151;">Send WhatsApp reminders before confirmed appointments</span>
                            </label>
                            <div class="small" style="margin-bottom:6px; color:#6b7280;">Reminder windows (same-day 1D reminders are skipped if too late):</div>
                            <div style="display:flex; gap:12px; flex-wrap:wrap;">
                              ${['2h','4h','1d'].map(w => {
                                const current = (() => { try { return JSON.parse(s.reminder_windows||'[]'); } catch { return []; } })();
                                const on = current.includes(w);
                                return `<label class="small"><input type="checkbox" name="reminder_windows" value="${w}" ${on ? 'checked' : ''}/> ${w.toUpperCase()}</label>`;
                              }).join('')}
                            </div>
                          </div>
                        </div>
                      </details>

                      <script>
                        (function(){
                          function parseJson(v, def){ try { return JSON.parse(String(v||'').trim()||'[]'); } catch(_) { return def; } }
                          function setHidden(id, arr){ var el=document.getElementById(id); if(el) el.value = JSON.stringify(arr||[]); }
                          var sArr = parseJson(document.getElementById('services_json')?.value, []);
                          var sList = document.getElementById('servicesList');
                          function renderSvcs(){
                            if(!sList) return;
                            sList.innerHTML='';
                            (sArr||[]).forEach(function(svc, idx){
                              var row=document.createElement('div'); row.style.display='flex'; row.style.gap='8px'; row.style.alignItems='center';
                              var span=document.createElement('div');
                              span.textContent=(svc.name||'') + (svc.minutes?(' · '+svc.minutes+' min'):'') + (svc.price?(' · '+svc.price):'');
                              span.style.flex='1'; span.className='kb-item';
                              var del=document.createElement('button'); del.type='button'; del.className='btn-ghost'; del.textContent='Remove';
                              del.onclick=function(){ sArr.splice(idx,1); renderSvcs(); };
                              row.appendChild(span); row.appendChild(del); sList.appendChild(row);
                            });
                            setHidden('services_json', sArr);
                          }
                          var addS=document.getElementById('addServiceBtn');
                          if(addS) addS.onclick=function(){
                            var n=document.getElementById('serviceName').value.trim();
                            var m=parseInt(document.getElementById('serviceMinutes').value,10);
                            var p=document.getElementById('servicePrice').value.trim();
                            if(!n || !m || m<=0) return;
                            sArr.push({ name:n, minutes:m, price:p||null });
                            document.getElementById('serviceName').value='';
                            document.getElementById('serviceMinutes').value='';
                            document.getElementById('servicePrice').value='';
                            renderSvcs();
                          };
                          renderSvcs();
                        })();
                      </script>
                    `}
                  </div>
                </form>
                <!-- Separate email form (not nested) to avoid interfering with settings submission -->
                <div class="section settings-panel" id="staff">
                  <h3>Staff</h3>
                  <div style="margin-bottom:12px;">
                    <form method="post" action="/settings/staff" onsubmit="event.preventDefault(); return checkAuthThenSubmit(this);" style="display:grid; grid-template-columns: repeat(2, 1fr); gap:8px;">
                      <label>Name
                        <input class="settings-field" name="name" placeholder="Jane Doe" required />
                      </label>
                      <label>Timezone
                        <input class="settings-field" name="timezone" placeholder="Europe/London" value="${s.timezone || ''}" />
                      </label>
                      <label>Slot Minutes
                        <input class="settings-field" type="number" min="5" max="240" step="5" name="slot_minutes" value="30" />
                      </label>
                      <div style="grid-column: 1 / -1; display:grid; gap:6px;">
                        <div class="small" style="margin:0 0 6px 0;">Working Hours (use HH:MM-HH:MM, comma-separated)</div>
                        ${['mon','tue','wed','thu','fri','sat','sun'].map((d,i)=>`
                          <div style=\"display:grid; grid-template-columns: 72px 1fr; gap:8px; align-items:center;\">
                            <div class=\"text-xs\" style=\"text-transform:uppercase; color:#6b7280;\">${['MON','TUE','WED','THU','FRI','SAT','SUN'][i]}</div>
                            <input class=\"settings-field\" name=\"hours_${d}\" placeholder=\"09:00-17:00, 18:00-20:00\" />
                          </div>
                        `).join('')}
                        <div class="small" style="margin-top:6px; color:#6b7280;">Examples: 09:00-14:00 or 09:00-12:00, 13:00-17:00</div>
                      </div>
                      <div style="grid-column: 1 / -1;">
                        <button type="submit" class="btn-primary">Add Staff</button>
                      </div>
                    </form>
                  </div>
                  <div>
                    <div class="small" style="margin-bottom:8px;">Existing staff</div>
                    ${staff.length ? `<ul class="list">${staff.map(r => `
                      <li class="inbox-item">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                          <div>
                            <div class="wa-top"><div class="wa-name">${r.name}</div></div>
                            <div class="item-preview small">${r.timezone || 'UTC'} · ${r.slot_minutes||30}m</div>
                          </div>
                          <div style="display:flex; gap:8px;">
                            <a href="/settings?edit_staff=${String(r._id)}" class="btn-ghost" style="background:#f3f4f6; padding:8px; border-radius:6px; cursor:pointer;">
                              <img src="/pencil-icon.svg" alt="Edit" style="width:16px;height:16px;"/>
                            </a>
                            <form method="post" action="/settings/staff/${String(r._id)}/delete" onsubmit="return checkAuthThenSubmit(this)" style="margin:0;">
                              <button type="submit" class="btn-ghost"><img src="/delete-icon.svg" alt="Delete"/></button>
                            </form>
                          </div>
                        </div>
                      </li>
                    `).join('')}</ul>` : '<div class="small">No staff yet</div>'}
                  </div>
                  ${staffToEdit ? `
                  <div style="margin-top:12px;">
                    <h3 style="margin-top:0;">Edit Staff</h3>
                    <form method="post" action="/settings/staff/${String(staffToEdit._id)}" onsubmit="event.preventDefault(); return checkAuthThenSubmit(this);" style="display:grid; grid-template-columns: repeat(2, 1fr); gap:8px;">
                      <label>Name
                        <input class="settings-field" name="name" value="${(staffToEdit.name||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}" required />
                      </label>
                      <label>Timezone
                        <input class="settings-field" name="timezone" value="${staffToEdit.timezone||''}" />
                      </label>
                      <label>Slot Minutes
                        <input class="settings-field" type="number" min="5" max="240" step="5" name="slot_minutes" value="${Number(staffToEdit.slot_minutes||30)}" />
                      </label>
                      <div style="grid-column: 1 / -1; display:grid; gap:6px;">
                        <div class="small" style="margin:0 0 6px 0;">Working Hours (use HH:MM-HH:MM, comma-separated)</div>
                        ${(()=>{ let wh={}; try{wh=JSON.parse(staffToEdit.working_hours_json||'{}')}catch{}; const days=['mon','tue','wed','thu','fri','sat','sun']; const labels=['MON','TUE','WED','THU','FRI','SAT','SUN']; return days.map((d,i)=>{ const v=Array.isArray(wh[d])?wh[d].join(', '):''; return `<div style=\"display:grid; grid-template-columns: 72px 1fr; gap:8px; align-items:center;\"><div class=\"text-xs\" style=\"text-transform:uppercase; color:#6b7280;\">${labels[i]}</div><input class=\"settings-field\" name=\"hours_${d}\" value=\"${v}\" placeholder=\"09:00-17:00, 18:00-20:00\" /></div>`}).join(''); })()}
                        <div class="small" style="margin-top:6px; color:#6b7280;">Examples: 09:00-14:00 or 09:00-12:00, 13:00-17:00</div>
                      </div>
                      <div style="grid-column: 1 / -1; display:flex; gap:8px; justify-content:flex-end;">
                        <a href="/settings" class="btn-ghost" style="text-decoration:none;">Cancel</a>
                        <button type="submit" class="btn-primary">Update Staff</button>
                      </div>
                    </form>
                  </div>
                  ` : ''}
                  <!-- Quick Replies JavaScript -->
                  <script>
                    let editingReplyId = null;
                    
                    function addQuickReply(event) {
                      event.preventDefault();
                      const form = event.target;
                      const formData = new FormData(form);
                      
                      // Check authentication first
                      fetch('/auth/status', { credentials: 'include' })
                        .then(response => response.json())
                        .then(authData => {
                          if (!authData.signedIn) {
                            alert('Please sign in to add quick replies');
                            window.location = '/auth';
                            return;
                          }
                          
                          // Proceed with adding quick reply
                          return fetch('/api/quick-replies', {
                            method: 'POST',
                            headers: { 
                              'Content-Type': 'application/json',
                              'Accept': 'application/json'
                            },
                            credentials: 'include',
                            body: JSON.stringify({
                              text: formData.get('text'),
                              category: formData.get('category')
                            })
                          });
                        })
                        .then(response => {
                          console.log('Quick reply response status:', response.status);
                          if (response && response.json) {
                            return response.json();
                          }
                          throw new Error('No response received');
                        })
                        .then(data => {
                          console.log('Quick reply response data:', data);
                          if (data && data.success) {
                            location.reload();
                          } else {
                            alert('Error: ' + (data?.error || 'Failed to add quick reply'));
                          }
                        })
                        .catch(error => {
                          console.error('Error:', error);
                          alert('Error adding quick reply: ' + error.message);
                        });
                    }
                    
                    function editQuickReply(id, text, category) {
                      editingReplyId = id;
                      const form = document.getElementById('quick-reply-form');
                      const textField = form.querySelector('textarea[name="text"]');
                      const categoryField = form.querySelector('select[name="category"]');
                      const submitButton = form.querySelector('button[type="submit"]');
                      
                      try { textField.value = decodeURIComponent(text); } catch(_) { textField.value = text; }
                      categoryField.value = category;
                      submitButton.textContent = 'Update Reply';
                      submitButton.onclick = function(e) { e.preventDefault(); updateQuickReply(); };
                      
                      textField.focus();
                      textField.scrollIntoView({ behavior: 'smooth' });
                    }
                    
                    function updateQuickReply() {
                      if (!editingReplyId) return;
                      
                      const form = document.getElementById('quick-reply-form');
                      const formData = new FormData(form);
                      
                      // Check authentication first
                      fetch('/auth/status', { credentials: 'include' })
                        .then(response => response.json())
                        .then(authData => {
                          if (!authData.signedIn) {
                            alert('Please sign in to update quick replies');
                            window.location = '/auth';
                            return;
                          }
                          
                          return fetch(\`/api/quick-replies/\${editingReplyId}\`, {
                            method: 'PUT',
                            headers: { 
                              'Content-Type': 'application/json',
                              'Accept': 'application/json'
                            },
                            credentials: 'include',
                            body: JSON.stringify({
                              text: formData.get('text'),
                              category: formData.get('category')
                            })
                          });
                        })
                        .then(response => {
                          if (response && response.json) {
                            return response.json();
                          }
                          throw new Error('No response received');
                        })
                        .then(data => {
                          if (data && data.success) {
                            location.reload();
                          } else {
                            alert('Error: ' + (data?.error || 'Failed to update quick reply'));
                          }
                        })
                        .catch(error => {
                          console.error('Error:', error);
                          alert('Error updating quick reply: ' + error.message);
                        });
                    }
                    
                    function deleteQuickReply(id) {
                      if (!confirm('Are you sure you want to delete this quick reply?')) return;
                      
                      // Check authentication first
                      fetch('/auth/status', { credentials: 'include' })
                        .then(response => response.json())
                        .then(authData => {
                          if (!authData.signedIn) {
                            alert('Please sign in to delete quick replies');
                            window.location = '/auth';
                            return;
                          }
                          
                          return fetch(\`/api/quick-replies/\${id}\`, {
                            method: 'DELETE',
                            headers: {
                              'Accept': 'application/json',
                              'Content-Type': 'application/json'
                            },
                            credentials: 'include'
                          });
                        })
                        .then(response => {
                          if (response && response.json) {
                            return response.json();
                          }
                          throw new Error('No response received');
                        })
                        .then(data => {
                          if (data && data.success) {
                            location.reload();
                          } else {
                            alert('Error: ' + (data?.error || 'Failed to delete quick reply'));
                          }
                        })
                        .catch(error => {
                          console.error('Error:', error);
                          alert('Error deleting quick reply: ' + error.message);
                        });
                    }
                    
                    function filterQuickRepliesSettings(category) {
                      const items = document.querySelectorAll('.quick-reply-item');
                      const buttons = document.querySelectorAll('.quick-reply-category');
                      
                      // Update button styles
                      buttons.forEach(btn => {
                        btn.style.background = '#e9ecef';
                        btn.style.color = '#495057';
                      });
                      
                      const activeButton = document.querySelector(\`[onclick="filterQuickRepliesSettings('\${category}')"]\`);
                      if (activeButton) {
                        activeButton.style.background = '#007bff';
                        activeButton.style.color = 'white';
                      }
                      
                      // Show/hide items
                      items.forEach(item => {
                        if (category === 'All' || item.dataset.category === category) {
                          item.style.display = 'block';
                        } else {
                          item.style.display = 'none';
                        }
                      });
                    }
                    
                    // Reset form when clicking outside edit mode
                    document.addEventListener('click', function(e) {
                      if (!e.target.closest('#quick-reply-form') && editingReplyId) {
                        editingReplyId = null;
                        const form = document.getElementById('quick-reply-form');
                        const submitButton = form.querySelector('button[type="submit"]');
                        submitButton.textContent = 'Add Reply';
                        submitButton.onclick = null;
                        form.reset();
                      }
                    });
                  </script>
                  
                </div>
                <!-- Quick Replies Section -->
                <div class="section settings-panel" id="quick-replies">
                  <h3>Quick Replies</h3>
                  <div style="margin-bottom:12px;">
                    <form id="quick-reply-form" onsubmit="return addQuickReply(event)" style="display:grid; grid-template-columns: 1fr auto auto; gap:8px; align-items:end;">
                      <div>
                        <label>Quick Reply Text
                          <textarea class="settings-field" name="text" placeholder="Thank you for your message! I'll get back to you shortly." required rows="2"></textarea>
                        </label>
                      </div>
                      <div>
                        <label>Category
                          <select class="settings-field" name="category">
                            <option value="General">General</option>
                            <option value="Confirmations">Confirmations</option>
                            <option value="Greetings">Greetings</option>
                            <option value="Questions">Questions</option>
                            <option value="Appointments">Appointments</option>
                            <option value="Support">Support</option>
                          </select>
                        </label>
                      </div>
                      <button type="submit" class="btn-primary">Add Reply</button>
                    </form>
                  </div>
                  <div class="card">
                    <div class="small" style="margin-bottom:8px;">Your Quick Replies</div>
                    ${quickReplies.length ? `
                      <div class="quick-replies-list">
                        ${quickReplyCategories.length > 0 ? `
                          <div class="quick-replies-categories" style="margin-bottom: 12px;">
                            <button type="button" class="btn-ghost text-2xs active" onclick="filterQuickRepliesSettings('All')" style="background: #007bff; color: white; border: none; padding: 4px 8px; margin-right: 4px; border-radius: 4px; cursor: pointer;">
                              All (${quickReplies.length})
                            </button>
                            ${quickReplyCategories.map(cat => `
                              <button type="button" class="btn-ghost text-2xs" onclick="filterQuickRepliesSettings('${cat.category}')" style="background: #e9ecef; color: #495057; border: none; padding: 4px 8px; margin-right: 4px; border-radius: 4px; cursor: pointer;">
                                ${cat.category} (${cat.count})
                              </button>
                            `).join('')}
                          </div>
                        ` : ''}
                        <div id="quick-replies-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 8px;">
                          ${quickReplies.map(reply => `
                            <div class="quick-reply-item" data-category="${reply.category || 'General'}" style="background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px; padding: 12px; position: relative;">
                              <div style="display: flex; justify-content: between; align-items: start; gap: 8px;">
                                <div style="flex: 1;">
                                  <div style="font-weight: 500; color: #495057; margin-bottom: 4px;">${reply.category || 'General'}</div>
                                  <div class="text-sm" style="color: #666; line-height: var(--line-height-snug);">${reply.text}</div>
                                  ${reply.usage_count > 0 ? `<div class="text-2xs" style="color: #6c757d; margin-top: 4px;">Used ${reply.usage_count} times</div>` : ''}
                                </div>
                                <div style="display: flex; gap: 4px;">
                                  <button type="button" onclick="editQuickReply(${reply.id}, '${encodeURIComponent(reply.text)}', '${reply.category || 'General'}')" style="background:#f0f9ff; padding:8px; border-radius:6px; cursor:pointer;" class="btn-ghost">
                                    <img src="/pencil-icon.svg" alt="Edit" style="width:16px;height:16px;"/>
                                  </button>
                                  <button type="button" onclick="deleteQuickReply(${reply.id})" style="background:#fef2f2; padding:8px; border-radius:6px; cursor:pointer;" class="btn-ghost">
                                    <img src="/delete-icon.svg" alt="Delete" style="width:16px;height:16px;margin-right:8px;"/>
                                  </button>
                                </div>
                              </div>
                            </div>
                          `).join('')}
                        </div>
                      </div>
                    ` : '<div class="small">No quick replies yet. Add your first one above!</div>'}
                  </div>
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
    return res.redirect(303, '/settings');
  });
  function normalizeTimezoneLabel(tz) {
    if (!tz) return null;
    if (/\//.test(tz)) return tz;
    const map = { london: 'Europe/London', utc: 'UTC', ny: 'America/New_York', new_york: 'America/New_York' };
    const key = String(tz).toLowerCase().replace(/\s+/g, '_');
    return map[key] || tz;
  }

  function parseWorkingHoursFromFields(body) {
    const days = ['mon','tue','wed','thu','fri','sat','sun'];
    const out = {};
    for (const d of days) {
      const raw = String(body['hours_' + d] || '').replace(/–/g, '-');
      const matches = [...raw.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
      const ranges = [];
      for (const m of matches) {
        const sh = Number(m[1]); const sm = Number(m[2]);
        const eh = Number(m[3]); const em = Number(m[4]);
        const valid = sh>=0 && sh<24 && eh>=0 && eh<24 && sm>=0 && sm<60 && em>=0 && em<60 && (eh*60+em)>(sh*60+sm);
        if (valid) ranges.push(`${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}-${String(eh).padStart(2,'0')}:${String(em).padStart(2,'0')}`);
      }
      if (ranges.length) out[d] = ranges;
    }
    return JSON.stringify(out);
  }

  app.post("/settings/staff", ensureAuthed, protect, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);
    const name = String(req.body?.name || '').trim();
    if (!name) return res.redirect(303, '/settings');
    let timezone = normalizeTimezoneLabel(String(req.body?.timezone || '').trim() || null);
    const slotMinutes = Number(req.body?.slot_minutes || 30) || 30;
    const workingJson = parseWorkingHoursFromFields(req.body);
    try {
      const exists = await Staff.findOne({ user_id: userId, name, timezone, slot_minutes: slotMinutes, working_hours_json: workingJson || '{}' }).lean();
      if (!exists) {
        await Staff.create({ user_id: userId, name, timezone, slot_minutes: slotMinutes, working_hours_json: workingJson || '{}' });
      }
    } catch {}
    return res.redirect(303, '/settings');
  }));

  app.post("/settings/staff/:id", ensureAuthed, protect, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);
    const id = String(req.params.id || '');
    if (!id) return res.redirect(303, '/settings');
    const name = String(req.body?.name || '').trim();
    if (!name) return res.redirect(303, '/settings');
    let timezone = normalizeTimezoneLabel(String(req.body?.timezone || '').trim() || null);
    const slotMinutes = Number(req.body?.slot_minutes || 30) || 30;
    const workingJson = parseWorkingHoursFromFields(req.body);
    try {
      await Staff.findOneAndUpdate({ _id: id, user_id: userId }, { name, timezone, slot_minutes: slotMinutes, working_hours_json: workingJson || '{}' }, { new: true });
    } catch {}
    return res.redirect(303, '/settings?edit_staff=');
  }));

  app.post("/settings/staff/:id/delete", ensureAuthed, protect, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);
    const id = String(req.params.id || '');
    if (!id) return res.redirect(303, '/settings');
    try { await Staff.findOneAndDelete({ _id: id, user_id: userId }); } catch {}
    return res.redirect(303, '/settings');
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

    const { filtered, deniedFields } = enforceSettingsPolicy(validation.data, { planName });
    const allowFreeBookings = String(process.env.ALLOW_BOOKINGS_ON_FREE || '').toLowerCase() === 'true';
    if (planName === "free" && !allowFreeBookings) {
      filtered.conversation_mode = "escalation";
      filtered.bookings_enabled = false;
      filtered.reminders_enabled = false;
    }
    filtered.escalation_email = null;

    const existingSettings = await getSettingsForUser(userId);
    const diff = computeSettingsDiff(existingSettings, filtered);

    if (!diff.changed.length) {
      return res.redirect(303, "/settings?updated=0");
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
      return res.status(500).send("Failed to save settings");
    }

    res.redirect(303, "/settings?saved=1");
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
    if (req.query.validate === "1" && status.connected) {
      const check = await validateWhatsAppToken(settings.phone_number_id, settings.whatsapp_token);
      status.tokenStatus = check.valid ? "ok" : "invalid";
      status.tokenMessage = check.valid ? null : `Token validation failed (${check.status || "unknown"})`;
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
