import { ensureAuthed, getCurrentUserId, getSignedInEmail, clerkClient } from "../middleware/auth.mjs";
import { getOnboarding } from "../services/onboarding.mjs";
import { getSettingsForUser, upsertSettingsForUser } from "../services/settings.mjs";
import { renderSidebar, renderTopbar } from "../utils.mjs";
import { wipeUserData } from "../services/userDeletion.mjs";
import {
  Calendar,
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

export default function registerSettingsRoutes(app, options = {}) {
  const protect = options.csrfProtection || ((req, _res, next) => next());
  const csrfTokenMiddleware = options.csrfTokenMiddleware || ((req, _res, next) => next());

  app.get("/settings", ensureAuthed, protect, csrfTokenMiddleware, async (req, res) => {
    const userId = getCurrentUserId(req);
    const s = await getSettingsForUser(userId);
    const plan = await getUserPlan(userId);
    const isUpgraded = isPlanUpgraded(plan);
    const effectiveConversationMode = isUpgraded ? (s.conversation_mode || 'full') : 'escalation';
    const ob = await getOnboarding(userId);
    const email = await getSignedInEmail(req);
    const q = req.query || {};
    const calendars = await Calendar.find({ user_id: userId }).select('_id display_name account_email calendar_id').sort({ _id: 1 }).lean();
    const staff = await Staff.find({ user_id: userId }).select('_id name timezone slot_minutes calendar_id working_hours_json').sort({ _id: -1 }).limit(50).lean();
    const staffToEdit = (q.edit_staff ? await Staff.findOne({ _id: String(q.edit_staff), user_id: userId }).lean().catch(() => null) : null);
    const quickReplies = await getQuickReplies(userId);
    const quickReplyCategories = await getQuickReplyCategories(userId);
    const smtpEnvConfigured = !!(process.env.SMTP_USER && process.env.SMTP_PASS);
    const csrfToken = res.locals.csrfToken || '';
    const csrfField = `<input type="hidden" name="_csrf" value="${escapeAttr(csrfToken)}">`;
    const csrfTokenJson = JSON.stringify(csrfToken);
    // Prevent caching to avoid showing cached authenticated pages after logout
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html><head><title>Code Orbit - Settings</title><link rel="stylesheet" href="/styles.css">
        <style>
          /* Lightweight accordion styling, clean white cards with no borders */
          .section { border: none; background:#ffffff; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
          .section h3 { margin: 0 0 8px 0; display:flex; align-items:center; gap:8px; cursor:pointer; }
          .section .section-body { margin-top: 8px; }
          .section.collapsed .section-body { display: none; }
          .caret { width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-top: 7px solid #6b7280; transition: transform .15s ease; }
          .section:not(.collapsed) .caret { transform: rotate(180deg); }
          .toolbar-btn { background:#f3f4f6; border:none; border-radius:9999px; padding:6px 10px; font-size:12px; cursor:pointer; }
          .toolbar-btn:hover { background:#e5e7eb; }
        </style>
      </head><body>
        
        <script src="/auth-utils.js"></script>
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
          // Accordion helper: wrap section content and allow toggle per section
          const ACCORDION_STORE_KEY = 'settings:accordion:v1';
          function readAccordionPrefs(){ try{ return JSON.parse(localStorage.getItem(ACCORDION_STORE_KEY)||'{}'); }catch(_){ return {}; } }
          function writeAccordionPrefs(p){ try{ localStorage.setItem(ACCORDION_STORE_KEY, JSON.stringify(p||{})); }catch(_){} }
          function initAccordions(){
            const prefs = readAccordionPrefs();
            const sections = document.querySelectorAll('.section');
            sections.forEach(sec => {
              const header = sec.querySelector('h3');
              if(!header) return;
              // Wrap body once
              if (!sec.querySelector('.section-body')) {
                const body = document.createElement('div');
                body.className = 'section-body';
                const nodes = Array.from(sec.childNodes).slice(Array.from(sec.childNodes).indexOf(header)+1);
                nodes.forEach(n => body.appendChild(n));
                sec.appendChild(body);
              }
              // Add caret if missing
              if (!header.querySelector('.caret')) { const caret = document.createElement('span'); caret.className='caret'; header.prepend(caret); }
              // Apply persisted state
              const id = sec.getAttribute('id');
              if (id && prefs[id] === true) sec.classList.add('collapsed');
              header.addEventListener('click', () => {
                sec.classList.toggle('collapsed');
                const id2 = sec.getAttribute('id');
                if (id2) { const p = readAccordionPrefs(); p[id2] = sec.classList.contains('collapsed'); writeAccordionPrefs(p); }
              });
            });
          }
          function expandAll(){
            const p = readAccordionPrefs();
            document.querySelectorAll('.section').forEach(s=>{ s.classList.remove('collapsed'); const id=s.id; if(id){ p[id]=false; } });
            writeAccordionPrefs(p);
          }
          function collapseAll(){
            const p = readAccordionPrefs();
            document.querySelectorAll('.section').forEach(s=>{ s.classList.add('collapsed'); const id=s.id; if(id){ p[id]=true; } });
            writeAccordionPrefs(p);
          }
          window.addEventListener('DOMContentLoaded', initAccordions);
        </script>
        <div class="container">
          ${renderTopbar(`<a href="/dashboard">Dashboard</a> / Settings`, email)}
          <div class="layout">
            ${renderSidebar('settings', { showBookings: !!(s?.bookings_enabled), isUpgraded })}
            <main class="main">
            <div class="main-content">
              <div id="settings-nav" style="position:sticky; top:0; z-index:5; padding:8px; margin-bottom:12px;">
                <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center;">
                  <a href="#account" style="text-decoration:none; background:#f3f4f6; border:none; padding:6px 10px; border-radius:9999px; color:#111827; font-size:12px;">Account</a>
                  <a href="#whatsapp" style="text-decoration:none; background:#f3f4f6; border:none; padding:6px 10px; border-radius:9999px; color:#111827; font-size:12px;">WhatsApp</a>
                  <a href="#conversation" style="text-decoration:none; background:#f3f4f6; border:none; padding:6px 10px; border-radius:9999px; color:#111827; font-size:12px;">Conversation</a>
                  <a href="#greeting" style="text-decoration:none; background:#f3f4f6; border:none; padding:6px 10px; border-radius:9999px; color:#111827; font-size:12px;">Greeting</a>
                  <a href="#holidays" style="text-decoration:none; background:#f3f4f6; border:none; padding:6px 10px; border-radius:9999px; color:#111827; font-size:12px;">Holidays</a>
                  <a href="#bookings_section" style="text-decoration:none; background:#f3f4f6; border:none; padding:6px 10px; border-radius:9999px; color:#111827; font-size:12px;">Bookings</a>
                  <a href="#email" style="text-decoration:none; background:#f3f4f6; border:none; padding:6px 10px; border-radius:9999px; color:#111827; font-size:12px;">Email</a>
                  <a href="#staff" style="text-decoration:none; background:#f3f4f6; border:none; padding:6px 10px; border-radius:9999px; color:#111827; font-size:12px;">Staff</a>
                  <a href="#quick-replies" style="text-decoration:none; background:#f3f4f6; border:none; padding:6px 10px; border-radius:9999px; color:#111827; font-size:12px;">Quick Replies</a>
                  <a href="#danger" style="text-decoration:none; background:#f3f4f6; border:none; padding:6px 10px; border-radius:9999px; color:#111827; font-size:12px;">Danger</a>
                  <button style="text-decoration:none; background:#f3f4f6; border:none; padding:6px 10px; border-radius:9999px; color:#111827; font-size:12px;" type="button" onclick="expandAll()">Expand all</button>
                  <button style="text-decoration:none; background:#f3f4f6; border:none; padding:6px 10px; border-radius:9999px; color:#111827; font-size:12px;" type="button" onclick="collapseAll()">Collapse all</button>
                  <button style="margin-left:auto; background:#2563eb; border:none; padding:6px 16px; border-radius:9999px; color:white; font-size:12px; font-weight:500; cursor:pointer;" type="submit" form="settings-main-form">Save</button>
                </div>
              </div>
                <div class="chat-box-settings">
                <form id="settings-main-form" method="post" action="/settings" onsubmit="event.preventDefault(); checkAuthThenSubmit(this).then(valid => { if(valid) this.submit(); }); return false;">
                  ${csrfField}
                  <div class="section" id="account">
                    <h3>Personal Information</h3>
                    <div class="grid-2">
                      <label>Name
                        <input placeholder="John Doe" class="settings-field" name="name" value="${s.name || ''}"/>
                      </label>
                      <label>Email
                        <div style="display: flex; align-items: center; gap: 8px;">
                          <input type="email" name="new_email" value="${email}" class="settings-field" form="email-start-form" required />
                          <button type="submit" form="email-start-form" class="btn-primary">Update</button>
                        </div>
                      </label>
                        ${q.email_update === 'sent' ? `
                        <form method="post" action="/settings/email/verify" style="display:flex; gap:8px; align-items:center; margin-top:6px;">
                          <input type="hidden" name="email_id" value="${q.email_id || ''}"/>
                          <input type="text" name="code" placeholder="6-digit code" class="settings-field" required />
                          <button type="submit" class="btn-primary">Verify & set as primary</button>
                          <button type="submit" class="btn-ghost" formaction="/settings/email/resend">Resend code</button>
                        </form>
                        ` : ''}
                        ${q.email_update === 'done' ? `<div class="small" style="color:#065f46; margin-top:6px;">Email updated successfully.</div>` : ''}
                        ${q.email_error ? `<div class="small" style="color:#991b1b; margin-top:6px;">${q.email_error}</div>` : ''}
                      </div>
                      <label>Business Name
                        <input placeholder="My Business" class="settings-field" name="business_name" value="${s.business_name || ''}"/>
                      </label>
                    </div>
                  <div class="section" id="whatsapp">
                    <h3>WhatsApp Setup</h3>
                    <div class="grid-2">
                      <label>Phone Number ID
                        <input placeholder="8***************" class="settings-field" name="phone_number_id" value="${s.phone_number_id || ''}"/>
                      </label>
                      <label>WABA ID
                        <input placeholder="2208283003006315" class="settings-field" name="waba_id" value="${s.waba_id || ''}"/>
                      </label>
                      <label>Business Phone
                        <input placeholder="1***************" class="settings-field" name="business_phone" value="${s.business_phone || ''}"/>
                      </label>
                    </div>
                    <div class="grid-2">
                      <label>WhatsApp Token
                        <div class="input-row">
                          <input id="wa_token" type="password" placeholder="E***************" class="settings-field" name="whatsapp_token" value="${s.whatsapp_token || ''}"/>
                          <button type="button" class="btn-ghost" onclick="toggleReveal('wa_token')"><img src="/show-password.svg" alt="Reveal"/></button>
                          <button type="button" class="btn-ghost" onclick="copyValue('wa_token')"><img src="/copy-icon.svg" alt="Copy"/></button>
                        </div>
                      </label>
                      <label>App Secret
                        <div class="input-row">
                          <input id="app_secret" type="password" placeholder="c***************" class="settings-field" name="app_secret" value="${s.app_secret || ''}"/>
                          <button type="button" class="btn-ghost" onclick="toggleReveal('app_secret')"><img src="/show-password.svg" alt="Reveal"/></button>
                          <button type="button" class="btn-ghost" onclick="copyValue('app_secret')"><img src="/copy-icon.svg" alt="Copy"/></button>
                        </div>
                      </label>
                    </div>
                    <label>Verify Token
                      <input placeholder="***************" class="settings-field" name="verify_token" value="${s.verify_token || ''}"/>
                    </label>
                  </div>

                  <div class="section" id="website">
                    <h3>Website</h3>
                    <label>Website URL
                      <input placeholder="https://www.example.com" class="settings-field" name="website_url" value="${s.website_url || ''}"/>
                    </label>
                    <label style="margin-top:8px;">Terms of Service URL
                      <input placeholder="https://www.example.com/terms" class="settings-field" name="terms_url" value="${s.terms_url || ''}"/>
                    </label>
                  </div>

                  <div class="section" id="ai">
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
                  <div class="section" id="conversation">
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
                      <div class="small" style="margin-top:4px; margin-left:24px;">The chatbot uses your knowledge base to answer questions and handles reservations, bookings, and complex interactions automatically.</div>
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
              <div class="small" style="color:#6b7280;">This message will be sent after the greeting when support is available.</div>
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
                  <div class="section" id="greeting">
                    <h3>Greeting</h3>
                    <label>Entry Greeting
                      <input placeholder="Hello! How can I help you today?" class="settings-field" name="entry_greeting" value="${s.entry_greeting || 'Hello! How can I help you today?'}"/>
                    </label>
                  </div>
                  <div class="section" id="holidays">
                    <h3>Holidays & Closures</h3>
                    <div class="small" style="margin-bottom:8px;">Add holiday name, date and business closed time window.</div>
                    <div id="holiday-rows" style="display:grid; grid-template-columns: 1.2fr 0.8fr 0.5fr 0.5fr auto; gap:8px; align-items:center;">
                      <div style="font-size:12px; color:#6b7280;">Name</div>
                      <div style="font-size:12px; color:#6b7280;">Date (YYYY-MM-DD)</div>
                      <div style="font-size:12px; color:#6b7280;">Start (HH:MM)</div>
                      <div style="font-size:12px; color:#6b7280;">End (HH:MM)</div>
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
                  <div class="section" id="bookings_section" style="${s.conversation_mode === 'escalation' ? 'display:none;' : ''}">
                    <h3>Bookings</h3>
                    <label>
                      <input type="hidden" name="bookings_enabled" value="0"/>
                      <input type="checkbox" name="bookings_enabled" value="1" ${s.bookings_enabled ? 'checked' : ''}/> Enable bookings via WhatsApp & dashboard
                    </label>
                    <div class="grid-2" style="margin-top:8px;">
                      <label>Reschedule min lead (minutes)
                        <input class="settings-field" type="number" min="0" step="5" name="reschedule_min_lead_minutes" value="${Number(s.reschedule_min_lead_minutes||60)}"/>
                      </label>
                      <label>Cancel min lead (minutes)
                        <input class="settings-field" type="number" min="0" step="5" name="cancel_min_lead_minutes" value="${Number(s.cancel_min_lead_minutes||60)}"/>
                      </label>
                    </div>
                    <div class="section" style="margin-top:8px;">
                      <h4 style="margin:0 0 6px 0;">Reminders</h4>
                      <label>
                        <input type="hidden" name="reminders_enabled" value="0"/>
                        <input type="checkbox" name="reminders_enabled" value="1" ${s.reminders_enabled && s.bookings_enabled ? 'checked' : ''} ${!s.bookings_enabled ? 'disabled' : ''}/> Enable reminders (requires bookings)
                      </label>
                      <div class="small">Choose one or more windows. If booking is the same day and window is 1D, no reminder is sent.</div>
                      <div style="display:flex; gap:12px; margin-top:6px;">
                        ${['2h','4h','1d'].map(w => {
                          const current = (() => { try { return JSON.parse(s.reminder_windows||'[]'); } catch { return []; } })();
                          const on = current.includes(w);
                          return `<label><input type="checkbox" name="reminder_windows" value="${w}" ${on ? 'checked' : ''} ${!s.bookings_enabled ? 'disabled' : ''}/> ${w.toUpperCase()}</label>`;
                        }).join('')}
                      </div>
                    </div>
                  </div>
                  <div class="section" id="email">
                    <h3>Email Notifications</h3>
                    <label>
                      <input type="hidden" name="escalation_email_enabled" value="0"/>
                      <input type="checkbox" name="escalation_email_enabled" value="1" ${s.escalation_email_enabled ? 'checked' : ''}/> Send email when customer escalates to support
                    </label>
                    <div class="small" style="margin-top:8px;">Get notified via email when a customer requests to speak with a human.</div>
                    <div class="small" style="margin-top:12px;">
                      Notifications will be sent to your account email (${email || 'not set'}).
                      To change it, update your email in <strong>Personal Information</strong> above.
                    </div>
                    
                    <div style="margin-top:16px; padding-top:16px;">
                      <h4 style="margin:0 0 8px 0;">SMTP Configuration</h4>
                      ${smtpEnvConfigured ? `
                        <div class="small" style="margin-bottom:12px;">
                          Email is configured by the workspace. Messages will be sent from
                          <strong>${s.smtp_user || process.env.SMTP_USER || 'configured sender'}</strong>.
                          To change the sender, update environment variables on the server.
                        </div>
                      ` : `
                        <div class="small" style="margin-bottom:12px;">Configure your email provider settings. For Gmail, use an App Password.</div>
                        <div class="grid-2" style="gap:12px;">
                          <label>SMTP Host
                            <input placeholder="smtp.gmail.com" class="settings-field" name="smtp_host" value="${s.smtp_host || ''}"/>
                          </label>
                          <label>SMTP Port
                            <input type="number" placeholder="587" class="settings-field" name="smtp_port" value="${s.smtp_port || '587'}"/>
                          </label>
                        </div>
                        <label style="margin-top:12px;">
                          <input type="hidden" name="smtp_secure" value="0"/>
                          <input type="checkbox" name="smtp_secure" value="1" ${Number(s.smtp_secure) === 1 ? 'checked' : ''}/> Use secure connection (SSL/TLS - port 465)
                        </label>
                        <div class="small">Check this if using port 465. Leave unchecked for port 587 (STARTTLS).</div>
                        <label style="margin-top:12px;">SMTP Username/Email
                          <input placeholder="your-email@gmail.com" class="settings-field" name="smtp_user" value="${s.smtp_user || ''}"/>
                        </label>
                        <label style="margin-top:12px;">SMTP Password
                          <div style="position:relative;">
                            <input type="password" id="smtp_pass" placeholder="App Password or SMTP password" class="settings-field" name="smtp_pass" value="${s.smtp_pass || ''}" style="padding-right:80px;"/>
                            <button type="button" onclick="toggleReveal('smtp_pass')" class="btn-ghost" style="position:absolute; right:8px; top:50%; transform:translateY(-50%); padding:4px 8px; font-size:12px;">Show</button>
                          </div>
                        </label>
                        <div class="small">
                          For Gmail: Create an App Password at <a href="https://myaccount.google.com/apppasswords" target="_blank" style="color:#4F46E5;">myaccount.google.com/apppasswords</a>
                        </div>
                      `}
                    </div>
                  </div>
                </form>
                <!-- Separate email form (not nested) to avoid interfering with settings submission -->
                <form id="email-start-form" method="post" action="/settings/email/start" style="display:none;">${csrfField}</form>
                <div class="section" id="staff">
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
                      <label>Calendar
                        <select class="settings-field" name="calendar_id">
                          <option value="">— None (local only) —</option>
                          ${(calendars||[]).map(c => `<option value="${String(c._id)}">${(c.display_name||c.account_email||c.calendar_id||('Calendar'))}</option>`).join('')}
                        </select>
                      </label>
                      <div style="grid-column: 1 / -1; display:grid; gap:6px;">
                        <div class="small" style="margin:0 0 6px 0;">Working Hours (use HH:MM-HH:MM, comma-separated)</div>
                        ${['mon','tue','wed','thu','fri','sat','sun'].map((d,i)=>`
                          <div style=\"display:grid; grid-template-columns: 72px 1fr; gap:8px; align-items:center;\">
                            <div style=\"text-transform:uppercase; font-size:12px; color:#6b7280;\">${['MON','TUE','WED','THU','FRI','SAT','SUN'][i]}</div>
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
                            <div class="item-preview small">${r.timezone || 'UTC'} · ${r.slot_minutes||30}m ${r.calendar_id ? '(Calendar linked)' : ''}</div>
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
                      <label>Calendar
                        <select class="settings-field" name="calendar_id">
                          <option value="">— None (local only) —</option>
                          ${(calendars||[]).map(c => `<option value="${String(c._id)}" ${String(staffToEdit.calendar_id||'')===String(c._id)?'selected':''}>${(c.display_name||c.account_email||c.calendar_id||('Calendar'))}</option>`).join('')}
                        </select>
                      </label>
                      <div style="grid-column: 1 / -1; display:grid; gap:6px;">
                        <div class="small" style="margin:0 0 6px 0;">Working Hours (use HH:MM-HH:MM, comma-separated)</div>
                        ${(()=>{ let wh={}; try{wh=JSON.parse(staffToEdit.working_hours_json||'{}')}catch{}; const days=['mon','tue','wed','thu','fri','sat','sun']; const labels=['MON','TUE','WED','THU','FRI','SAT','SUN']; return days.map((d,i)=>{ const v=Array.isArray(wh[d])?wh[d].join(', '):''; return `<div style=\"display:grid; grid-template-columns: 72px 1fr; gap:8px; align-items:center;\"><div style=\"text-transform:uppercase; font-size:12px; color:#6b7280;\">${labels[i]}</div><input class=\"settings-field\" name=\"hours_${d}\" value=\"${v}\" placeholder=\"09:00-17:00, 18:00-20:00\" /></div>`}).join(''); })()}
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
                <div class="section" id="quick-replies">
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
                            <button type="button" class="btn-ghost active" onclick="filterQuickRepliesSettings('All')" style="background: #007bff; color: white; border: none; padding: 4px 8px; margin-right: 4px; border-radius: 4px; font-size: 0.8em; cursor: pointer;">
                              All (${quickReplies.length})
                            </button>
                            ${quickReplyCategories.map(cat => `
                              <button type="button" class="btn-ghost" onclick="filterQuickRepliesSettings('${cat.category}')" style="background: #e9ecef; color: #495057; border: none; padding: 4px 8px; margin-right: 4px; border-radius: 4px; font-size: 0.8em; cursor: pointer;">
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
                                  <div style="color: #666; font-size: 0.9em; line-height: 1.4;">${reply.text}</div>
                                  ${reply.usage_count > 0 ? `<div style="font-size: 0.8em; color: #6c757d; margin-top: 4px;">Used ${reply.usage_count} times</div>` : ''}
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
                <div class="section" id="danger" style="margin-top:16px; border:1px solid #fee2e2; background:#fef2f2;">
                  <h3 style="margin-top:0; display:flex; align-items:center; gap:8px; color:#b91c1c;">
                    <span style="width:8px;height:8px;border-radius:999px;background:#ef4444;"></span>
                    Danger zone
                  </h3>
                  <div class="small" style="margin-bottom:8px; color:#7f1d1d;">
                    These actions are irreversible. Please proceed with caution.
                  </div>
                  <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
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
      // Preflight FTS integrity; rebuild if necessary BEFORE delete to avoid error noise
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

      // Now perform the delete
      const del = db.prepare(`DELETE FROM kb_items WHERE user_id = ?`).run(userId);
      console.log("[KB][CLEAR] deleted rows", { changes: del?.changes || 0 });
      const remaining = db.prepare(`SELECT COUNT(1) AS c FROM kb_items WHERE user_id = ?`).get(userId)?.c || 0;
      console.log("[KB][CLEAR] remaining rows", { remaining });
    } catch (e) {
      console.error("[KB][CLEAR] final error", e?.message || e);
    }
    return res.redirect(303, '/settings');
  });

  // Staff: fresh implementation
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

  app.post("/settings/staff", ensureAuthed, protect, async (req, res) => {
    const userId = getCurrentUserId(req);
    const name = String(req.body?.name || '').trim();
    if (!name) return res.redirect(303, '/settings');
    let timezone = normalizeTimezoneLabel(String(req.body?.timezone || '').trim() || null);
    const slotMinutes = Number(req.body?.slot_minutes || 30) || 30;
    const calIdRaw = (req.body?.calendar_id || '').toString().trim();
    const calendarId = calIdRaw ? String(calIdRaw) : null;
    const workingJson = parseWorkingHoursFromFields(req.body);
    try {
      // Dedupe guard: if an identical staff document already exists, skip creating another
      const exists = await Staff.findOne({ user_id: userId, name, timezone, slot_minutes: slotMinutes, calendar_id: calendarId, working_hours_json: workingJson || '{}' }).lean();
      if (!exists) {
        await Staff.create({ user_id: userId, name, calendar_id: calendarId, timezone, slot_minutes: slotMinutes, working_hours_json: workingJson || '{}' });
      }
    } catch {}
    return res.redirect(303, '/settings');
  });

  app.post("/settings/staff/:id", ensureAuthed, protect, async (req, res) => {
    const userId = getCurrentUserId(req);
    const id = String(req.params.id || '');
    if (!id) return res.redirect(303, '/settings');
    const name = String(req.body?.name || '').trim();
    if (!name) return res.redirect(303, '/settings');
    let timezone = normalizeTimezoneLabel(String(req.body?.timezone || '').trim() || null);
    const slotMinutes = Number(req.body?.slot_minutes || 30) || 30;
    const calIdRaw = (req.body?.calendar_id || '').toString().trim();
    const calendarId = calIdRaw ? String(calIdRaw) : null;
    const workingJson = parseWorkingHoursFromFields(req.body);
    try {
      await Staff.findOneAndUpdate({ _id: id, user_id: userId }, { name, calendar_id: calendarId, timezone, slot_minutes: slotMinutes, working_hours_json: workingJson || '{}' }, { new: true });
    } catch {}
    return res.redirect(303, '/settings?edit_staff=');
  });

  app.post("/settings/staff/:id/delete", ensureAuthed, protect, async (req, res) => {
    const userId = getCurrentUserId(req);
    const id = String(req.params.id || '');
    if (!id) return res.redirect(303, '/settings');
    try { await Staff.findOneAndDelete({ _id: id, user_id: userId }); } catch {}
    return res.redirect(303, '/settings');
  });

  app.post("/danger/wipe", ensureAuthed, protect, async (req, res) => {
    const userId = getCurrentUserId(req);
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
  });

  app.post("/settings", ensureAuthed, protect, async (req, res) => {
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
    if (planName === "free") {
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
  });

  // WhatsApp token status check (used by Inbox modal)
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
          // Consider other non-OK statuses as unknown but not necessarily invalid
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

  // Update WhatsApp token (AJAX from Inbox modal)
  app.post("/api/settings/wa-token", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const newTokenRaw = (req.body?.whatsapp_token || '').toString();
    const newToken = newTokenRaw.trim();
    if (!newToken) return res.status(400).json({ success: false, error: 'Token is required' });
    try {
      // Optionally validate against phone_number_id if set
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

  // Lightweight API for dashboard setup tasks (step 2 modal)
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

  // Start email update: create email address and send verification
  app.post("/settings/email/start", ensureAuthed, protect, async (req, res) => {
    const userId = getCurrentUserId(req);
    const newEmail = String(req.body?.new_email || '').trim();
    if (!newEmail) return res.redirect(303, '/settings?email_error=Missing+email');
    try {
      const created = await clerkClient.users.createEmailAddress({ userId, emailAddress: newEmail });
      try { await clerkClient.users.prepareEmailAddressVerification({ userId, emailAddressId: created.id, strategy: 'email_code' }); } catch {}
      return res.redirect(303, `/settings?email_update=sent&email_id=${encodeURIComponent(created.id)}`);
    } catch (e) {
      const msg = encodeURIComponent(e?.errors?.[0]?.message || e?.message || 'Failed to start email update');
      return res.redirect(303, `/settings?email_error=${msg}`);
    }
  });

  // Resend verification code
  app.post("/settings/email/resend", ensureAuthed, protect, async (req, res) => {
    const userId = getCurrentUserId(req);
    const emailId = String(req.body?.email_id || '').trim();
    if (!emailId) return res.redirect(303, '/settings?email_error=Missing+email_id');
    try {
      await clerkClient.users.prepareEmailAddressVerification({ userId, emailAddressId: emailId, strategy: 'email_code' });
      return res.redirect(303, `/settings?email_update=sent&email_id=${encodeURIComponent(emailId)}`);
    } catch (e) {
      const msg = encodeURIComponent(e?.errors?.[0]?.message || e?.message || 'Failed to resend code');
      return res.redirect(303, `/settings?email_error=${msg}`);
    }
  });

  // Verify code and set as primary
  app.post("/settings/email/verify", ensureAuthed, protect, async (req, res) => {
    const userId = getCurrentUserId(req);
    const emailId = String(req.body?.email_id || '').trim();
    const code = String(req.body?.code || '').trim();
    if (!emailId || !code) return res.redirect(303, '/settings?email_error=Missing+verification+data');
    try {
      await clerkClient.users.verifyEmailAddress({ userId, emailAddressId: emailId, code });
      await clerkClient.users.updateUser(userId, { primaryEmailAddressId: emailId });
      return res.redirect(303, '/settings?email_update=done');
    } catch (e) {
      const msg = encodeURIComponent(e?.errors?.[0]?.message || e?.message || 'Verification failed');
      return res.redirect(303, `/settings?email_error=${msg}&email_update=sent&email_id=${encodeURIComponent(emailId)}`);
    }
  });

  // Staff management temporarily disabled (endpoints removed)

  // Quick Replies API endpoints
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
