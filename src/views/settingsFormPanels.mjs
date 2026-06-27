import { escapeHtml } from "../utils.mjs";
import { isPlacesConfigured } from "../services/places.mjs";
import { renderHolidayClosureFields } from "./holidayClosures.mjs";
import { Staff } from "../schemas/mongodb.mjs";
import { getUserPlan, isPlanUpgraded } from "../services/usage.mjs";
import { buildConnectionStatus } from "../services/whatsappConnect.mjs";
import {
  loadPlanBillingContext,
  renderPlanBillingPanel,
  renderPlanBillingScripts,
} from "./planBilling.mjs";

function escapeAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function buildSettingsPanelContext(userId, s, planRow) {
  const plan = planRow || await getUserPlan(userId);
  const isUpgraded = isPlanUpgraded(plan);
  const allowFreeBookings = String(process.env.ALLOW_BOOKINGS_ON_FREE || "").toLowerCase() === "true";
  const effectiveConversationMode = (isUpgraded || allowFreeBookings) ? (s.conversation_mode || "full") : "escalation";
  const bookingsActive = effectiveConversationMode === "full";
  const bookingsLocked = !bookingsActive;
  const businessCategories = (() => { try { return JSON.parse(s.business_categories_json || "[]"); } catch { return []; } })();
  const businessCategoriesValue = Array.isArray(businessCategories) ? businessCategories.join(", ") : "";
  let googleProfileSyncedAt = "";
  let googleProfileName = "";
  try {
    if (s.google_business_json) {
      const snap = JSON.parse(s.google_business_json);
      googleProfileSyncedAt = snap?.syncedAt ? String(snap.syncedAt).slice(0, 10) : "";
      googleProfileName = snap?.profile?.name ? String(snap.profile.name) : "";
    }
  } catch {}
  const staffCount = await Staff.countDocuments({ user_id: userId });
  return {
    s,
    plan,
    isUpgraded,
    effectiveConversationMode,
    bookingsLocked,
    businessCategoriesValue,
    bookingMaxPerDay: Number(s?.booking_max_per_day || 0),
    bookingDaysAhead: Number(s?.booking_days_ahead || 60),
    bookingSlotMinutes: Number(s?.booking_display_interval_minutes || 30),
    capacityWindow: Number(s?.booking_capacity_window_minutes || 60),
    capacityLimit: Number(s?.booking_capacity_limit || 0),
    waitlistEnabled: !!s?.waitlist_enabled,
    servicesJson: String(s?.services_json || "[]"),
    staffCount,
    waConnection: buildConnectionStatus(s),
    placesConfigured: isPlacesConfigured(),
    businessAddressValue: escapeAttr(s.business_address || ""),
    businessLatValue: s.business_latitude != null && s.business_latitude !== "" ? escapeAttr(String(s.business_latitude)) : "",
    businessLngValue: s.business_longitude != null && s.business_longitude !== "" ? escapeAttr(String(s.business_longitude)) : "",
    businessPlaceIdValue: escapeAttr(s.business_place_id || ""),
    waPhoneNumberIdValue: escapeAttr(s.phone_number_id || ""),
    waBusinessPhoneValue: escapeAttr(s.business_phone || ""),
    waTokenValue: escapeAttr(s.whatsapp_token || ""),
    waVerifyTokenValue: escapeAttr(s.verify_token || ""),
    googleProfileSyncedAt,
    googleProfileName,
  };
}

export function renderBusinessPanel(ctx) {
  const {
    s, businessCategoriesValue, businessAddressValue, businessLatValue, businessLngValue,
    businessPlaceIdValue, placesConfigured, googleProfileSyncedAt, googleProfileName,
    isUpgraded, effectiveConversationMode, bookingsLocked, staffCount,
    bookingDaysAhead, bookingMaxPerDay, bookingSlotMinutes, capacityWindow, capacityLimit,
    waitlistEnabled, servicesJson, waConnection, waPhoneNumberIdValue, waBusinessPhoneValue,
    waTokenValue, waVerifyTokenValue,
  } = ctx;

  return `                    <h3>Business Information</h3>
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
                      <div id="address-selected-hint" class="small settings-status--success" style="margin-top:4px; display:${businessLatValue && businessLngValue ? 'block' : 'none'};">Map pin saved for this address.</div>
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
                          var wrap = document.getElementById('address-autocomplete-wrap');
                          if (!wrap || !wrap.contains(ev.target)) hideList();
                        });
                      })();
                    </script>` : ''}
                    ${placesConfigured ? `
                    <div class="settings-card settings-card--subtle google-business-import">
                      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap;">
                        <div>
                          <div class="settings-card__title">Import from Google Business</div>
                          <div class="small" style="max-width:520px;">
                            Search your listing on Google to import name, address, phone, website, hours, categories, and reviews into settings and your Knowledge Base.
                          </div>
                          ${googleProfileSyncedAt ? `<div class="small settings-status--success" style="margin-top:8px;">Last imported${googleProfileName ? ` (${escapeHtml(googleProfileName)})` : ""}: ${escapeHtml(googleProfileSyncedAt)}</div>` : ""}
                        </div>
                      </div>
                      <div style="position:relative; margin-top:12px;">
                        <input id="google-business-search" class="settings-field" placeholder="Search your business on Google..." autocomplete="off" />
                        <div id="google-business-suggestions" style="display:none; position:absolute; left:0; right:0; top:100%; z-index:25; background:#fff; border:1px solid #e2e8f0; border-radius:8px; box-shadow:0 8px 24px rgba(15,23,42,.12); max-height:260px; overflow:auto;"></div>
                      </div>
                      <div id="google-business-preview" class="settings-card settings-card--accent" style="display:none; margin-top:14px;">
                        <div class="settings-card__title">Preview</div>
                        <div id="google-business-preview-body" class="small" style="white-space:pre-wrap;"></div>
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
                          search.value = (btn.querySelector('div') && btn.querySelector('div').textContent) || search.value;
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
                    </div>`}`;
}

export function renderWhatsAppPanel(ctx) {
  const {
    s, businessCategoriesValue, businessAddressValue, businessLatValue, businessLngValue,
    businessPlaceIdValue, placesConfigured, googleProfileSyncedAt, googleProfileName,
    isUpgraded, effectiveConversationMode, bookingsLocked, staffCount,
    bookingDaysAhead, bookingMaxPerDay, bookingSlotMinutes, capacityWindow, capacityLimit,
    waitlistEnabled, servicesJson, waConnection, waPhoneNumberIdValue, waBusinessPhoneValue,
    waTokenValue, waVerifyTokenValue,
  } = ctx;

  return `                    <h3>WhatsApp Setup</h3>

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

                      <p class="small wa-connect-card__hint-next" id="wa-connect-next-step" ${waConnection.connected ? 'hidden' : ''}>
                        Use <strong>Connect WhatsApp</strong> to sign in with Meta (requires <strong>HTTPS</strong>).
                        Or expand <strong>Manual setup</strong> below to paste your Phone number ID and access token from Meta Business Suite.
                      </p>
                    </div>

                    <details class="wa-manual-setup" id="wa-manual-setup">
                      <summary class="wa-manual-setup__summary">Manual setup</summary>
                      <p class="small wa-manual-setup__hint">
                        Paste credentials from Meta → WhatsApp → API setup. Required: <strong>Phone number ID</strong> and <strong>WhatsApp token</strong>.
                        WABA ID and business phone are optional — we will try to fill them from Meta when you connect.
                      </p>
                      <label>Phone Number ID
                        <input placeholder="8***************" class="settings-field" name="phone_number_id" value="${waPhoneNumberIdValue}"/>
                      </label>
                      <label>WABA ID
                        <input placeholder="2208283003006315" class="settings-field" name="waba_id" value="${s.waba_id || ''}"/>
                      </label>
                      <label>Business Phone
                        <input placeholder="1***************" class="settings-field" name="business_phone" value="${waBusinessPhoneValue}"/>
                      </label>
                      <label>WhatsApp Token
                        <div class="input-row">
                          <input id="wa_token" type="password" placeholder="E***************" class="settings-field" name="whatsapp_token" value="${waTokenValue}"/>
                          <button type="button" class="btn-ghost" onclick="toggleReveal('wa_token')" aria-label="Reveal token"><img src="/show-password.svg" alt=""/></button>
                          <button type="button" class="btn-ghost" onclick="copyValue('wa_token')" aria-label="Copy token"><img src="/copy-icon.svg" alt=""/></button>
                        </div>
                      </label>
                      <label>Verify Token
                        <input placeholder="Auto-generated on connect" class="settings-field" name="verify_token" value="${waVerifyTokenValue}"/>
                      </label>
                      <div class="wa-manual-setup__actions">
                        <button type="button" class="btn-primary" id="wa-manual-connect-btn">Connect manually</button>
                        <p class="small wa-manual-setup__save-note">You can also save these fields with <strong>Save changes</strong> at the top of the page.</p>
                      </div>
                    </details>

                    <div class="settings-card settings-card--subtle" style="margin-top:20px;">
                      <h4 class="settings-card__title">Staff WhatsApp Group</h4>
                      <p class="small" style="margin:0 0 12px 0;">
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
                          ? `<span class="settings-status--success">Connected</span> — <code style="font-size:11px;">${String(s.staff_whatsapp_group_id).slice(0, 24)}${String(s.staff_whatsapp_group_id).length > 24 ? '…' : ''}</code>`
                          : `<span class="settings-status--warning">Not connected</span>`}
                      </div>
                      <div id="staff-group-support" class="small" style="margin-bottom:12px;"></div>
                      <button type="button" class="btn-ghost" id="staff-group-check" style="margin-bottom:12px;">Check Groups API support</button>
                      <div class="settings-callout settings-callout--warning" style="margin-bottom:12px;">
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
                            const resp = await window.authManager.authenticatedFetch('/api/settings/staff-group/disconnect', {
                              method: 'POST',
                              headers: { Accept: 'application/json' }
                            });
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
                    </div>`;
}

export function renderAiConfigurationPanel(ctx) {
  const {
    s, businessCategoriesValue, businessAddressValue, businessLatValue, businessLngValue,
    businessPlaceIdValue, placesConfigured, googleProfileSyncedAt, googleProfileName,
    isUpgraded, effectiveConversationMode, bookingsLocked, staffCount,
    bookingDaysAhead, bookingMaxPerDay, bookingSlotMinutes, capacityWindow, capacityLimit,
    waitlistEnabled, servicesJson, waConnection, waPhoneNumberIdValue, waBusinessPhoneValue,
    waTokenValue, waVerifyTokenValue,
  } = ctx;

  return `                    <h3>AI Configuration</h3>

                    <h4 class="settings-subheading">Conversation mode</h4>
                    <p class="small settings-lead" style="margin-bottom:12px;">Choose how the chatbot should respond to customer messages:</p>
                    <label class="settings-radio-card${!isUpgraded ? ' settings-radio-card--locked' : ''}">
                      <input type="radio" name="conversation_mode" value="full" ${effectiveConversationMode === 'full' ? 'checked' : ''} ${!isUpgraded ? 'disabled' : ''} />
                      <strong>Full AI Assistant (Knowledge Base + Bookings)</strong>
                      ${!isUpgraded ? `<span class="small settings-upgrade-badge">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                          <circle cx="12" cy="16" r="1"/>
                          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                        </svg>
                        Upgrade to enable
                      </span>` : ''}
                      <div class="small">Answers from your knowledge base and handles reservations in natural conversation — the bot collects date, time, name, and party size without forms or slot menus.</div>
                    </label>
                    <label class="settings-radio-card">
                      <input type="radio" name="conversation_mode" value="escalation" ${effectiveConversationMode === 'escalation' ? 'checked' : ''} />
                      <strong>Simple Escalation Mode</strong>
                      <div class="small">The chatbot immediately escalates customers to human support. If support is available (within working hours), it escalates right away. If not, it informs the customer when support will be available next.</div>
                    </label>
                    <div class="small settings-callout settings-callout--info settings-escalation-info${effectiveConversationMode === 'escalation' ? '' : ' hidden'}" id="escalation_info">
                      <strong>Note:</strong> In Simple Escalation Mode, the bot will use your <strong>Staff working hours</strong> (configured below) to determine when customer support is available. Make sure you have at least one staff member configured with working hours.
                    </div>

                    <div class="settings-card settings-card--subtle settings-escalation-panel${effectiveConversationMode === 'escalation' ? '' : ' hidden'}" id="escalation_messages">
                      <h4 class="settings-card__title">Escalation Messages</h4>

                      <label class="settings-field-label">
                        <div class="small">Additional Message (during working hours)</div>
                        <input class="settings-field" type="text" name="escalation_additional_message" placeholder="Got it. I'm connecting you with a human. Please wait a moment." value="${s.escalation_additional_message || ''}" />
                        <div class="small">This message is sent when support is available during escalation.</div>
                      </label>

                      <label class="settings-field-label">
                        <div class="small">Out of Hours Message</div>
                        <input class="settings-field" type="text" name="escalation_out_of_hours_message" placeholder="We are out of our working time we will reach you as soon as we can" value="${s.escalation_out_of_hours_message || ''}" />
                        <div class="small">This message will be sent when support is not available.</div>
                      </label>

                      <label class="settings-field-label">
                        <div class="small">Escalation Questions (one per line)</div>
                        <textarea class="settings-field" name="escalation_questions_json" placeholder="What's your name?&#10;What's the reason for contacting support today?&#10;What's your phone number?" rows="4">${(() => {
                          try {
                            const questions = JSON.parse(s.escalation_questions_json || '[]');
                            return questions.join('\n');
                          } catch {
                            return '';
                          }
                        })()}</textarea>
                        <div class="small">Enter each question on a new line. These questions will be asked during the escalation process.</div>
                      </label>
                    </div>

                    <h4 class="settings-subheading settings-subheading--divider">AI preferences</h4>
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
                    </label>`;
}

export function renderHolidaysPanel(ctx) {
  const {
    s, businessCategoriesValue, businessAddressValue, businessLatValue, businessLngValue,
    businessPlaceIdValue, placesConfigured, googleProfileSyncedAt, googleProfileName,
    isUpgraded, effectiveConversationMode, bookingsLocked, staffCount,
    bookingDaysAhead, bookingMaxPerDay, bookingSlotMinutes, capacityWindow, capacityLimit,
    waitlistEnabled, servicesJson, waConnection, waPhoneNumberIdValue, waBusinessPhoneValue,
    waTokenValue, waVerifyTokenValue,
  } = ctx;

  return `                    <h3>Holidays & Closures</h3>
                    ${renderHolidayClosureFields(s.holidays_rules_json || '[]', s.closed_dates_json || '[]')}`;
}

export function renderBookingsPanel(ctx) {
  const {
    s, businessCategoriesValue, businessAddressValue, businessLatValue, businessLngValue,
    businessPlaceIdValue, placesConfigured, googleProfileSyncedAt, googleProfileName,
    isUpgraded, effectiveConversationMode, bookingsLocked, staffCount,
    bookingDaysAhead, bookingMaxPerDay, bookingSlotMinutes, capacityWindow, capacityLimit,
    waitlistEnabled, servicesJson, waConnection, waPhoneNumberIdValue, waBusinessPhoneValue,
    waTokenValue, waVerifyTokenValue,
  } = ctx;

  return `                    <h3>Reservations</h3>
                    ${bookingsLocked ? `
                      <div class="settings-callout settings-callout--danger">
                        Reservations are available in <strong>Full AI Assistant</strong> mode only. Switch mode in <a class="settings-link" href="/settings#ai_configuration">AI Configuration</a>, or <a class="settings-link" href="/settings#billing">upgrade your plan</a> if Full mode is locked.
                      </div>
                      <input type="hidden" name="bookings_enabled" value="0"/>
                    ` : `
                      <input type="hidden" name="bookings_enabled" value="1"/>
                      <p class="small settings-lead">
                        Customers book by chatting naturally (e.g. &ldquo;nesër në orën 8&rdquo;). The AI confirms availability, then collects name, party size, and occasion — no scripted questions or slot pickers.
                      </p>

                      <div class="settings-card settings-card--subtle" style="margin-bottom:18px;">
                        <div class="settings-card__title">Setup checklist</div>
                        <ul class="settings-checklist">
                          <li>${staffCount ? `${staffCount} staff member${staffCount === 1 ? '' : 's'} configured` : '<strong>Add staff</strong> with working hours in the <a class="settings-link" href="#staff">Staff</a> section below'}</li>
                        </ul>
                      </div>

                      <h4 class="settings-subheading">Scheduling rules</h4>
                      <div class="grid-2">
                        <label>How far ahead customers can book (days)
                          <input type="number" min="1" max="365" step="1" class="settings-field" name="booking_days_ahead" value="${bookingDaysAhead}" />
                          <span class="small">e.g. 60 = up to two months ahead</span>
                        </label>
                        <label>Max reservations per staff per day
                          <input type="number" min="0" max="500" step="1" class="settings-field" name="booking_max_per_day" value="${bookingMaxPerDay}" />
                          <span class="small">0 = unlimited</span>
                        </label>
                        <label style="grid-column: 1 / -1;">Slot minutes
                          <input type="number" min="5" max="240" step="5" class="settings-field" name="booking_display_interval_minutes" value="${bookingSlotMinutes}" />
                          <span class="small">How long each booking lasts and how often times are offered (e.g. 30 = 9:00, 9:30, 10:00…)</span>
                        </label>
                      </div>

                      <details class="settings-details booking-advanced">
                        <summary>Advanced options</summary>
                        <div class="settings-details__body">
                          <div>
                            <div class="settings-subheading">Capacity limits</div>
                            <p class="small" style="margin:0 0 10px 0;">Optional caps for busy periods (e.g. restaurant covers per hour).</p>
                            <div class="grid-2">
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
                          var servicesEl = document.getElementById('services_json');
                          var sArr = parseJson(servicesEl ? servicesEl.value : '', []);
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
                    `}`;
}

export function renderBillingPanelHtml(planBilling) {
  return `
    <h3>Plan & billing</h3>
    <p class="settings-section__lead">Monitor usage, manage pay-as-you-go, and change your subscription.</p>
    <div class="plan-content settings-plan-billing">
      ${renderPlanBillingPanel(planBilling)}
    </div>
  `.trim();
}

export async function buildLazyFormPanelHtml(panelId, userId, settings, planRow) {
  const ctx = await buildSettingsPanelContext(userId, settings, planRow);
  switch (panelId) {
    case "business":
      return renderBusinessPanel(ctx);
    case "whatsapp":
      return renderWhatsAppPanel(ctx);
    case "ai_configuration":
      return renderAiConfigurationPanel(ctx);
    case "holidays":
      return renderHolidaysPanel(ctx);
    case "bookings_section":
      return renderBookingsPanel(ctx);
    default:
      return null;
  }
}

export async function buildLazyBillingPanelPayload(userId) {
  const planBilling = await loadPlanBillingContext(userId);
  return {
    html: renderBillingPanelHtml(planBilling),
    stripeEnabled: !!planBilling.stripeEnabled,
    inlineScript: renderPlanBillingScripts(planBilling),
  };
}
