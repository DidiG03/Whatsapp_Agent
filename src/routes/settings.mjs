import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { clerkClient } from "../middleware/auth.mjs";
import { adminWhitelist } from "../middleware/security.mjs";
import { getOnboarding } from "../services/onboarding.mjs";
import { getSettingsForUser, upsertSettingsForUser } from "../services/settings.mjs";
import { renderSidebar, renderTopbar } from "../utils.mjs";
import { getSignedInEmail } from "../middleware/auth.mjs";
import { Calendar, Staff } from "../schemas/mongodb.mjs";
import { getQuickReplies, getQuickReplyCategories, createQuickReply, updateQuickReply, deleteQuickReply, reorderQuickReplies } from "../services/quickReplies.mjs";

export default function registerSettingsRoutes(app) {
  app.get("/settings", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const s = await getSettingsForUser(userId);
    const ob = await getOnboarding(userId);
    const email = await getSignedInEmail(req);
    const q = req.query || {};
    const calendars = await Calendar.find({ user_id: userId }).select('_id display_name account_email calendar_id').sort({ _id: 1 }).lean();
    const staff = await Staff.find({ user_id: userId }).select('_id name timezone slot_minutes calendar_id').sort({ _id: -1 }).limit(50).lean();
    const quickReplies = await getQuickReplies(userId);
    const quickReplyCategories = await getQuickReplyCategories(userId);
    // Prevent caching to avoid showing cached authenticated pages after logout
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html><head><title>Code Orbit - Settings</title><link rel="stylesheet" href="/styles.css"></head><body>
        <script src="/notifications.js"></script>
        <script src="/auth-utils.js"></script>
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
        </script>
        <div class="container">
          ${renderTopbar(`<a href="/dashboard">Dashboard</a> / Settings`, email)}
          <div class="layout">
            ${renderSidebar('settings')}
            <main class="main">
              <div class="main-content">
                <div class="card chat-box-settings">
                <form method="post" action="/settings" onsubmit="event.preventDefault(); checkAuthThenSubmit(this).then(valid => { if(valid) this.submit(); }); return false;">
                  <div class="section">
                    <h3>Personal Information</h3>
                    <div class="grid-2">
                      <label>Name
                        <input placeholder="John Doe" class="settings-field" name="name" value="${s.name || ''}"/>
                      </label>
                      <label>Email
                        <div style="display: flex; align-items: center; gap: 8px;">
                          <input type="email" name="new_email" value="${email}" class="settings-field" form="email-start-form" required />
                          <button type="submit" form="email-start-form">Update</button>
                        </div>
                      </label>
                        ${q.email_update === 'sent' ? `
                        <form method="post" action="/settings/email/verify" style="display:flex; gap:8px; align-items:center; margin-top:6px;">
                          <input type="hidden" name="email_id" value="${q.email_id || ''}"/>
                          <input type="text" name="code" placeholder="6-digit code" class="settings-field" required />
                          <button type="submit">Verify & set as primary</button>
                          <button type="submit" formaction="/settings/email/resend">Resend code</button>
                        </form>
                        ` : ''}
                        ${q.email_update === 'done' ? `<div class="small" style="color:#065f46; margin-top:6px;">Email updated successfully.</div>` : ''}
                        ${q.email_error ? `<div class="small" style="color:#991b1b; margin-top:6px;">${q.email_error}</div>` : ''}
                      </div>
                      <label>Business Name
                        <input placeholder="My Business" class="settings-field" name="business_name" value="${s.business_name || ''}"/>
                      </label>
                    </div>
                  <div class="section">
                    <h3>WhatsApp Setup</h3>
                    <div class="grid-2">
                      <label>Phone Number ID
                        <input placeholder="8***************" class="settings-field" name="phone_number_id" value="${s.phone_number_id || ''}"/>
                      </label>
                      <label>Business Phone
                        <input placeholder="1***************" class="settings-field" name="business_phone" value="${s.business_phone || ''}"/>
                      </label>
                    </div>
                    <div class="grid-2">
                      <label>WhatsApp Token
                        <div class="input-row">
                          <input id="wa_token" type="password" placeholder="E***************" class="settings-field" name="whatsapp_token" value="${s.whatsapp_token || ''}"/>
                          <button type="button" style="border:none;" class="btn-ghost" onclick="toggleReveal('wa_token')"><img src="/show-password.svg" alt="Reveal"/></button>
                          <button type="button" class="btn-ghost" style="border:none;" onclick="copyValue('wa_token')"><img src="/copy-icon.svg" alt="Copy"/></button>
                        </div>
                      </label>
                      <label>App Secret
                        <div class="input-row">
                          <input id="app_secret" type="password" placeholder="c***************" class="settings-field" name="app_secret" value="${s.app_secret || ''}"/>
                          <button type="button" style="border:none;" class="btn-ghost" onclick="toggleReveal('app_secret')"><img src="/show-password.svg" alt="Reveal"/></button>
                          <button type="button" class="btn-ghost" style="border:none;" onclick="copyValue('app_secret')"><img src="/copy-icon.svg" alt="Copy"/></button>
                        </div>
                      </label>
                    </div>
                    <label>Verify Token
                      <input placeholder="***************" class="settings-field" name="verify_token" value="${s.verify_token || ''}"/>
                    </label>
                  </div>

                  <div class="section">
                    <h3>Website</h3>
                    <label>Website URL
                      <input placeholder="https://www.example.com" class="settings-field" name="website_url" value="${s.website_url || ''}"/>
                    </label>
                  </div>

                  <div class="section">
                    <h3>WhatsApp Templates</h3>
                    <div class="grid-2">
                      <label>Template Name
                        <input placeholder="welcome_back" class="settings-field" name="wa_template_name" value="${s.wa_template_name || ''}"/>
                      </label>
                      <label>Template Language
                        <input placeholder="en_US" class="settings-field" name="wa_template_language" value="${s.wa_template_language || 'en_US'}"/>
                      </label>
                    </div>
                    <div class="small">Used when last user message is older than 24h.</div>
                  </div>

                  <div class="section">
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
                  <div class="section">
                    <h3>Conversation Mode</h3>
                    <div class="small" style="margin-bottom:12px;">Choose how the chatbot should respond to customer messages:</div>
                    <label style="display:block; margin-bottom:12px; padding:12px; border:1px solid #e5e7eb; border-radius:6px; cursor:pointer; ${(s.conversation_mode || 'full') === 'full' ? 'background:#f0f9ff; border-color:#3b82f6;' : ''}">
                      <input type="radio" name="conversation_mode" value="full" ${(s.conversation_mode || 'full') === 'full' ? 'checked' : ''} style="margin-right:8px;"/>
                      <strong>Full AI Assistant (Knowledge Base + Bookings)</strong>
                      <div class="small" style="margin-top:4px; margin-left:24px;">The chatbot uses your knowledge base to answer questions and handles reservations, bookings, and complex interactions automatically.</div>
                    </label>
                    <label style="display:block; margin-bottom:12px; padding:12px; border:1px solid #e5e7eb; border-radius:6px; cursor:pointer; ${s.conversation_mode === 'escalation' ? 'background:#f0f9ff; border-color:#3b82f6;' : ''}">
                      <input type="radio" name="conversation_mode" value="escalation" ${s.conversation_mode === 'escalation' ? 'checked' : ''} style="margin-right:8px;"/>
                      <strong>Simple Escalation Mode</strong>
                      <div class="small" style="margin-top:4px; margin-left:24px;">The chatbot immediately escalates customers to human support. If support is available (within working hours), it escalates right away. If not, it informs the customer when support will be available next.</div>
                    </label>
          <div class="small" style="margin-top:12px; padding:12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; ${s.conversation_mode === 'escalation' ? '' : 'display:none;'}" id="escalation_info">
            <strong>Note:</strong> In Simple Escalation Mode, the bot will use your <strong>Staff working hours</strong> (configured below) to determine when customer support is available. Make sure you have at least one staff member configured with working hours.
          </div>
          
          <!-- Escalation Mode Messages -->
          <div style="margin-top:16px; padding:12px; background:#f0f9ff; border:1px solid #bfdbfe; border-radius:6px; ${s.conversation_mode === 'escalation' ? '' : 'display:none;'}" id="escalation_messages">
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
                  <div class="section">
                    <h3>Greeting</h3>
                    <label>Entry Greeting
                      <input placeholder="Hello! How can I help you today?" class="settings-field" name="entry_greeting" value="${s.entry_greeting || 'Hello! How can I help you today?'}"/>
                    </label>
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
                  <div class="section">
                    <h3>Email Notifications</h3>
                    <label>
                      <input type="hidden" name="escalation_email_enabled" value="0"/>
                      <input type="checkbox" name="escalation_email_enabled" value="1" ${s.escalation_email_enabled ? 'checked' : ''}/> Send email when customer escalates to support
                    </label>
                    <div class="small" style="margin-top:8px;">Get notified via email when a customer requests to speak with a human.</div>
                    <label style="margin-top:12px;">Notification Email (optional)
                      <input placeholder="${email || 'Your account email'}" class="settings-field" name="escalation_email" value="${s.escalation_email || ''}"/>
                    </label>
                    <div class="small">Leave blank to use your account email (${email || 'not set'}).</div>
                    
                    <div class="section" style="margin-top:16px; border-top: 1px solid #e5e7eb; padding-top:16px;">
                      <h4 style="margin:0 0 8px 0;">SMTP Configuration</h4>
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
                          <button type="button" onclick="toggleReveal('smtp_pass')" style="position:absolute; right:8px; top:50%; transform:translateY(-50%); background:transparent; border:none; padding:4px 8px; cursor:pointer; color:#6b7280; font-size:12px;">Show</button>
                        </div>
                      </label>
                      <div class="small">
                        For Gmail: Create an App Password at <a href="https://myaccount.google.com/apppasswords" target="_blank" style="color:#4F46E5;">myaccount.google.com/apppasswords</a>
                      </div>
                    </div>
                  </div>
                  <button type="submit" style="width:100%;">Save</button>
                </form>
                <!-- Separate email form (not nested) to avoid interfering with settings submission -->
                <form id="email-start-form" method="post" action="/settings/email/start" style="display:none;"></form>
                <div class="section" style="display:flex; gap:10px; align-items:center;">
                  <form method="post" action="/kb/clear" style="margin:0;display:inline;">
                    <button type="submit" style="background:#fee2e2;color:#b91c1c;border:1px solid #fecaca">Clear Knowledge Base</button>
                  </form>
                  <form method="post" action="/danger/wipe" style="margin:0;display:inline;" onsubmit="return confirm('Delete all data for this account? This cannot be undone.');">
                    <button type="submit" style="background:#fee2e2;color:#991b1b;border:1px solid #fecaca">Delete my account data</button>
                  </form>
                </div>
                <div class="section">
                  <h3>Staff</h3>
                  <div class="card" style="margin-bottom:12px;">
                    <form method="post" action="/settings/staff" onsubmit="return checkAuthThenSubmit(this)" style="display:grid; grid-template-columns: repeat(2, 1fr); gap:8px;">
                      <label>Name
                        <input class="settings-field" name="name" placeholder="Dr. Jane Doe" required />
                      </label>
                      <label>Timezone
                        <input class="settings-field" name="timezone" placeholder="America/New_York" value="${s.timezone || ''}" />
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
                      <div style="grid-column: 1 / -1;">
                        <div class="small" style="margin:0 0 6px 0;">Working Hours</div>
                        <input type="hidden" name="working_hours_json" id="wh_json" />
                        <div id="wh_builder" class="card" style="padding:10px; display:grid; gap:10px;">
                          <div class="wh-row" data-day="mon" style="display:flex; gap:8px; align-items:center;">
                            <div style="width:72px; text-transform:uppercase; font-size:12px; color:#6b7280;">MON</div>
                            <div class="wh-slots" style="display:flex; flex-wrap:wrap; gap:8px;"></div>
                            <button type="button" class="btn-ghost wh-add" style="border:none;">Add</button>
                          </div>
                          <div class="wh-row" data-day="tue" style="display:flex; gap:8px; align-items:center;">
                            <div style="width:72px; text-transform:uppercase; font-size:12px; color:#6b7280;">TUE</div>
                            <div class="wh-slots" style="display:flex; flex-wrap:wrap; gap:8px;"></div>
                            <button type="button" class="btn-ghost wh-add" style="border:none;">Add</button>
                          </div>
                          <div class="wh-row" data-day="wed" style="display:flex; gap:8px; align-items:center;">
                            <div style="width:72px; text-transform:uppercase; font-size:12px; color:#6b7280;">WED</div>
                            <div class="wh-slots" style="display:flex; flex-wrap:wrap; gap:8px;"></div>
                            <button type="button" class="btn-ghost wh-add" style="border:none;">Add</button>
                          </div>
                          <div class="wh-row" data-day="thu" style="display:flex; gap:8px; align-items:center;">
                            <div style="width:72px; text-transform:uppercase; font-size:12px; color:#6b7280;">THU</div>
                            <div class="wh-slots" style="display:flex; flex-wrap:wrap; gap:8px;"></div>
                            <button type="button" class="btn-ghost wh-add" style="border:none;">Add</button>
                          </div>
                          <div class="wh-row" data-day="fri" style="display:flex; gap:8px; align-items:center;">
                            <div style="width:72px; text-transform:uppercase; font-size:12px; color:#6b7280;">FRI</div>
                            <div class="wh-slots" style="display:flex; flex-wrap:wrap; gap:8px;"></div>
                            <button type="button" class="btn-ghost wh-add" style="border:none;">Add</button>
                          </div>
                          <div class="wh-row" data-day="sat" style="display:flex; gap:8px; align-items:center;">
                            <div style="width:72px; text-transform:uppercase; font-size:12px; color:#6b7280;">SAT</div>
                            <div class="wh-slots" style="display:flex; flex-wrap:wrap; gap:8px;"></div>
                            <button type="button" class="btn-ghost wh-add" style="border:none;">Add</button>
                          </div>
                          <div class="wh-row" data-day="sun" style="display:flex; gap:8px; align-items:center;">
                            <div style="width:72px; text-transform:uppercase; font-size:12px; color:#6b7280;">SUN</div>
                            <div class="wh-slots" style="display:flex; flex-wrap:wrap; gap:8px;"></div>
                            <button type="button" class="btn-ghost wh-add" style="border:none;">Add</button>
                          </div>
                        </div>
                        <div class="small" style="margin-top:6px; color:#6b7280;">Example: 09:00-17:00. Add multiple ranges per day if needed.</div>
                      </div>
                      <div style="grid-column: 1 / -1; display:flex; gap:8px;">
                        <button type="submit">Add Staff</button>
                      </div>
                    </form>
                  </div>
                  <script>
                    (function(){
                      var builder = document.getElementById('wh_builder');
                      var hidden = document.getElementById('wh_json');
                      if(!builder || !hidden) return;
                      var form = builder.closest('form');
                      if(!form) return;

                      function makeSlotEl(){
                        var wrap = document.createElement('div');
                        wrap.style.display = 'flex';
                        wrap.style.gap = '6px';
                        wrap.style.alignItems = 'center';
                        var input = document.createElement('input');
                        input.className = 'settings-field';
                        input.type = 'text';
                        input.placeholder = '09:00-17:00';
                        input.style.width = '140px';
                        var del = document.createElement('button');
                        del.type = 'button';
                        del.className = 'btn-ghost';
                        del.style.border = 'none';
                        del.innerHTML = '<img src="/delete-icon.svg" alt="Delete"/>';
                        del.addEventListener('click', function(){
                          var parent = wrap.parentElement; if(parent) parent.removeChild(wrap);
                        });
                        wrap.appendChild(input);
                        wrap.appendChild(del);
                        return wrap;
                      }

                      builder.querySelectorAll('.wh-row').forEach(function(row){
                        var add = row.querySelector('.wh-add');
                        var slots = row.querySelector('.wh-slots');
                        if(add){
                          add.addEventListener('click', function(){
                            if(slots.querySelectorAll('input.settings-field').length >= 6) return;
                            slots.appendChild(makeSlotEl());
                          });
                        }
                        // Ensure at least one input is present so the user can type directly
                        if (slots && slots.querySelectorAll('input.settings-field').length === 0) {
                          slots.appendChild(makeSlotEl());
                        }
                      });

                      form.addEventListener('submit', function(){
                        var out = {};
                        builder.querySelectorAll('.wh-row').forEach(function(row){
                          var day = row.getAttribute('data-day');
                          var vals = [];
                          row.querySelectorAll('input.settings-field').forEach(function(i){
                            var v = String(i.value||'').trim();
                            // Accept hyphen or en dash and 1–2 digit hours
                            var m = /^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/.exec(v);
                            if(m){
                              var norm = (m[1].padStart(2,'0') + ':' + m[2] + '-' + m[3].padStart(2,'0') + ':' + m[4]);
                              vals.push(norm);
                            }
                          });
                          if(vals.length) out[day] = vals;
                        });
                        hidden.value = JSON.stringify(out);
                      });
                    })();
                    
                    // Toggle escalation info, escalation messages, and bookings section based on mode selection
                    var radios = document.querySelectorAll('input[name="conversation_mode"]');
                    var infoBox = document.getElementById('escalation_info');
                    var escalationMessages = document.getElementById('escalation_messages');
                    var bookingsSection = document.getElementById('bookings_section');
                    radios.forEach(function(r){
                      r.addEventListener('change', function(){
                        if(infoBox) infoBox.style.display = r.value === 'escalation' ? '' : 'none';
                        if(escalationMessages) escalationMessages.style.display = r.value === 'escalation' ? '' : 'none';
                        if(bookingsSection) bookingsSection.style.display = r.value === 'escalation' ? 'none' : '';
                      });
                    });
                  </script>
                  
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
                      
                      textField.value = text;
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
                  
                  <div class="card">
                    <div class="small" style="margin-bottom:8px;">Existing staff</div>
                    ${staff.length ? `<ul class="list">${staff.map(r => `
                      <li class="inbox-item">
                        <div style="display: flex; align-items: space-between; gap: 12px;">
                          <div class="wa-col">
                            <div class="wa-top"><div class="wa-name">${r.name}</div></div>
                            <div class="item-preview small">${r.timezone || 'UTC'} · ${r.slot_minutes||30}m ${r.calendar_id ? '(Calendar linked)' : ''}</div>
                          </div>
                          <form method="post" action="/settings/staff/${String(r._id)}/delete" onsubmit="return checkAuthThenSubmit(this)" style="margin-left:auto;">
                            <button type="submit" style="border:none;" class="btn-ghost" style="color:#991b1b;"><img src="/delete-icon.svg" alt="Delete"/></button>
                          </form>
                        </div>
                      </li>
                    `).join('')}</ul>` : '<div class="small">No staff yet</div>'}
                  </div>
                </div>
              </div>
              
              <!-- Quick Replies Section -->
              <div class="section">
                <h3>Quick Replies</h3>
                <div class="card" style="margin-bottom:12px;">
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
                          <button type="button" class="quick-reply-category active" onclick="filterQuickRepliesSettings('All')" style="background: #007bff; color: white; border: none; padding: 4px 8px; margin-right: 4px; border-radius: 4px; font-size: 0.8em; cursor: pointer;">
                            All (${quickReplies.length})
                          </button>
                          ${quickReplyCategories.map(cat => `
                            <button type="button" class="quick-reply-category" onclick="filterQuickRepliesSettings('${cat.category}')" style="background: #e9ecef; color: #495057; border: none; padding: 4px 8px; margin-right: 4px; border-radius: 4px; font-size: 0.8em; cursor: pointer;">
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
                                <button type="button" onclick="editQuickReply(${reply.id}, '${reply.text.replace(/'/g, '\\\'').replace(/"/g, '&quot;')}', '${reply.category || 'General'}')" style="background: #007bff; color: white; border: none; padding: 4px 8px; border-radius: 4px; font-size: 0.8em; cursor: pointer;">Edit</button>
                                <button type="button" onclick="deleteQuickReply(${reply.id})" style="background: #dc3545; color: white; border: none; padding: 4px 8px; border-radius: 4px; font-size: 0.8em; cursor: pointer;">Delete</button>
                              </div>
                            </div>
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  ` : '<div class="small">No quick replies yet. Add your first one above!</div>'}
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
    return res.redirect('/settings');
  });

  app.post("/danger/wipe", ensureAuthed, adminWhitelist, async (req, res) => {
    const userId = getCurrentUserId(req);
    try {
      const wipe = db.transaction((uid) => {
        // 1) message_statuses: by message_id and by user_id (for safety)
        const msgIds = db.prepare(`SELECT id FROM messages WHERE user_id = ?`).all(uid).map(r => r.id);
        if (msgIds.length) {
          const ph = msgIds.map(() => '?').join(',');
          try { db.prepare(`DELETE FROM message_statuses WHERE message_id IN (${ph})`).run(...msgIds); } catch {}
        }
        try { db.prepare(`DELETE FROM message_statuses WHERE user_id = ?`).run(uid); } catch {}

        // 2) Messages
        try { db.prepare(`DELETE FROM messages WHERE user_id = ?`).run(uid); } catch {}

        // 3) Booking related
        try { db.prepare(`DELETE FROM booking_sessions WHERE user_id = ?`).run(uid); } catch {}
        try { db.prepare(`DELETE FROM appointments WHERE user_id = ?`).run(uid); } catch {}
        try { db.prepare(`DELETE FROM staff WHERE user_id = ?`).run(uid); } catch {}
        try { db.prepare(`DELETE FROM calendars WHERE user_id = ?`).run(uid); } catch {}
        try { db.prepare(`DELETE FROM contact_state WHERE user_id = ?`).run(uid); } catch {}
        try { db.prepare(`DELETE FROM customers WHERE user_id = ?`).run(uid); } catch {}

        // 4) Inbox state
        try { db.prepare(`DELETE FROM handoff WHERE user_id = ?`).run(uid); } catch {}

        // 5) KB & onboarding/settings (FTS is maintained by triggers)
        try { db.prepare(`DELETE FROM kb_items WHERE user_id = ?`).run(uid); } catch {}
        try { db.prepare(`DELETE FROM onboarding_state WHERE user_id = ?`).run(uid); } catch {}
        try { db.prepare(`DELETE FROM settings_multi WHERE user_id = ?`).run(uid); } catch {}

        // 6) Notifications, usage stats, user plans, and quick replies
        try { db.prepare(`DELETE FROM notifications WHERE user_id = ?`).run(uid); } catch {}
        try { db.prepare(`DELETE FROM usage_stats WHERE user_id = ?`).run(uid); } catch {}
        try { db.prepare(`DELETE FROM user_plans WHERE user_id = ?`).run(uid); } catch {}
        try { db.prepare(`DELETE FROM quick_replies WHERE user_id = ?`).run(uid); } catch {}
      });
      wipe(userId);
    } catch (e) {
      console.error('Wipe error:', e?.message || e);
    }
    return res.redirect('/logout');
  });

  app.post("/settings", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const values = {
      name: req.body?.name || null,
      phone_number_id: req.body?.phone_number_id || null,
      whatsapp_token: req.body?.whatsapp_token || null,
      verify_token: req.body?.verify_token || null,
      app_secret: req.body?.app_secret || null,
      business_phone: req.body?.business_phone || null,
      website_url: req.body?.website_url || null,
      ai_tone: req.body?.ai_tone || null,
      ai_blocked_topics: req.body?.ai_blocked_topics || null,
      ai_style: req.body?.ai_style || null,
      entry_greeting: req.body?.entry_greeting || null,
      bookings_enabled: (req.body?.bookings_enabled && req.body?.conversation_mode !== 'escalation') ? 1 : 0,
      reschedule_min_lead_minutes: req.body?.reschedule_min_lead_minutes ? Number(req.body.reschedule_min_lead_minutes) : null,
      cancel_min_lead_minutes: req.body?.cancel_min_lead_minutes ? Number(req.body.cancel_min_lead_minutes) : null,
      reminders_enabled: (req.body?.reminders_enabled && req.body?.bookings_enabled && req.body?.conversation_mode !== 'escalation') ? 1 : 0,
      escalation_email_enabled: req.body?.escalation_email_enabled ? 1 : 0,
      escalation_email: req.body?.escalation_email || null,
      smtp_host: req.body?.smtp_host || null,
      smtp_port: req.body?.smtp_port ? parseInt(req.body.smtp_port, 10) : 587,
      smtp_secure: (() => {
        const val = req.body?.smtp_secure;
        // Handle array case (when both hidden and checkbox values are sent)
        if (Array.isArray(val)) return val.includes('1') ? 1 : 0;
        return val === '1' || val === 1 ? 1 : 0;
      })(),
      smtp_user: req.body?.smtp_user || null,
      smtp_pass: req.body?.smtp_pass || null,
      reminder_windows: (() => {
        const v = req.body?.reminder_windows;
        const arr = Array.isArray(v) ? v : (v ? [v] : []);
        const clean = arr.map(x => String(x||'').toLowerCase()).filter(x => ['2h','4h','1d'].includes(x));
        return clean.length ? JSON.stringify(clean) : null;
      })(),
      wa_template_name: req.body?.wa_template_name || null,
      wa_template_language: req.body?.wa_template_language || null,
      conversation_mode: req.body?.conversation_mode || 'full',
      escalation_additional_message: req.body?.escalation_additional_message || null,
      escalation_out_of_hours_message: req.body?.escalation_out_of_hours_message || null,
      escalation_questions_json: (() => {
        const questions = String(req.body?.escalation_questions_json || '').trim();
        if (!questions) return null;
        const questionArray = questions.split('\n').map(q => q.trim()).filter(q => q.length > 0);
        return questionArray.length > 0 ? JSON.stringify(questionArray) : null;
      })(),
    };
    try {
      await upsertSettingsForUser(userId, values);
    } catch (e) {
      console.error('[POST /settings] upsert error', e?.message || e);
    }
    res.redirect("/settings");
  });

  // Start email update: create email address and send verification
  app.post("/settings/email/start", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const newEmail = String(req.body?.new_email || '').trim();
    if (!newEmail) return res.redirect('/settings?email_error=Missing+email');
    try {
      const created = await clerkClient.users.createEmailAddress({ userId, emailAddress: newEmail });
      try { await clerkClient.users.prepareEmailAddressVerification({ userId, emailAddressId: created.id, strategy: 'email_code' }); } catch {}
      return res.redirect(`/settings?email_update=sent&email_id=${encodeURIComponent(created.id)}`);
    } catch (e) {
      const msg = encodeURIComponent(e?.errors?.[0]?.message || e?.message || 'Failed to start email update');
      return res.redirect(`/settings?email_error=${msg}`);
    }
  });

  // Resend verification code
  app.post("/settings/email/resend", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const emailId = String(req.body?.email_id || '').trim();
    if (!emailId) return res.redirect('/settings?email_error=Missing+email_id');
    try {
      await clerkClient.users.prepareEmailAddressVerification({ userId, emailAddressId: emailId, strategy: 'email_code' });
      return res.redirect(`/settings?email_update=sent&email_id=${encodeURIComponent(emailId)}`);
    } catch (e) {
      const msg = encodeURIComponent(e?.errors?.[0]?.message || e?.message || 'Failed to resend code');
      return res.redirect(`/settings?email_error=${msg}`);
    }
  });

  // Verify code and set as primary
  app.post("/settings/email/verify", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const emailId = String(req.body?.email_id || '').trim();
    const code = String(req.body?.code || '').trim();
    if (!emailId || !code) return res.redirect('/settings?email_error=Missing+verification+data');
    try {
      await clerkClient.users.verifyEmailAddress({ userId, emailAddressId: emailId, code });
      await clerkClient.users.updateUser(userId, { primaryEmailAddressId: emailId });
      return res.redirect('/settings?email_update=done');
    } catch (e) {
      const msg = encodeURIComponent(e?.errors?.[0]?.message || e?.message || 'Verification failed');
      return res.redirect(`/settings?email_error=${msg}&email_update=sent&email_id=${encodeURIComponent(emailId)}`);
    }
  });

  // Create staff
  app.post("/settings/staff", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const name = (req.body?.name || '').toString().trim();
    if (!name) return res.redirect('/settings');
    let timezone = (req.body?.timezone || '').toString().trim() || null;
    const slotMinutes = Number(req.body?.slot_minutes || 30) || 30;
    let workingJson = (req.body?.working_hours_json || '').toString().trim() || null;
    const calIdRaw = (req.body?.calendar_id || '').toString().trim();
    const calendarId = calIdRaw ? String(calIdRaw) : null;
    try {
      // Normalize timezone (basic mapping for common labels)
      if (timezone && !/\//.test(timezone)) {
        const map = { london: 'Europe/London', utc: 'UTC', ny: 'America/New_York', new_york: 'America/New_York' };
        const key = timezone.toLowerCase().replace(/\s+/g,'_');
        timezone = map[key] || timezone;
      }
      // Default working hours if none provided or empty object
      if (!workingJson || workingJson === '{}' || workingJson === 'null') {
        workingJson = '{"mon":["09:00-17:00"],"tue":["09:00-17:00"],"wed":["09:00-17:00"],"thu":["09:00-17:00"],"fri":["09:00-17:00"]}';
      }
      await Staff.create({ user_id: userId, name, calendar_id: calendarId, timezone, slot_minutes: slotMinutes, working_hours_json: workingJson });
    } catch {}
    return res.redirect('/settings');
  });

  // Delete staff
  app.post("/settings/staff/:id/delete", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const id = String(req.params.id || '');
    if (!id) return res.redirect('/settings');
    try { await Staff.findOneAndDelete({ _id: id, user_id: userId }); } catch {}
    return res.redirect('/settings');
  });

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
