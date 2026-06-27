import { Staff } from "../schemas/mongodb.mjs";
import { getQuickReplies, getQuickReplyCategories } from "../services/quickReplies.mjs";
import { getUserPlan } from "../services/usage.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { escapeHtml } from "../utils.mjs";
import { renderStaffWorkingHoursFields } from "./staffWorkingHours.mjs";
import {
  buildLazyBillingPanelPayload,
  buildLazyFormPanelHtml,
} from "./settingsFormPanels.mjs";

function escapeAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderStaffPanelHtml({ staff = [], staffToEdit = null, timezone = "" } = {}) {
  const tz = escapeAttr(timezone || "");
  return `
    <h3>Staff</h3>
    <div style="margin-bottom:12px;">
      <form method="post" action="/settings/staff" onsubmit="event.preventDefault(); return checkAuthThenSubmit(this);" style="display:grid; grid-template-columns: repeat(2, 1fr); gap:8px;">
        <label>Name
          <input class="settings-field" name="name" placeholder="Jane Doe" required />
        </label>
        <label>Timezone
          <input class="settings-field" name="timezone" placeholder="Europe/London" value="${tz}" />
        </label>
        <div style="grid-column: 1 / -1;">
          ${renderStaffWorkingHoursFields('{}')}
        </div>
        <div style="grid-column: 1 / -1;">
          <button type="submit" class="btn-primary">Add Staff</button>
        </div>
      </form>
    </div>
    <div>
      <div class="small" style="margin-bottom:8px;">Existing staff</div>
      ${staff.length ? `<ul class="list">${staff.map((r) => `
        <li class="inbox-item">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
            <div>
              <div class="wa-top"><div class="wa-name">${escapeHtml(r.name || '')}</div></div>
              <div class="item-preview small">${escapeHtml(r.timezone || 'UTC')}</div>
            </div>
            <div style="display:flex; gap:8px;">
              <a href="/settings?edit_staff=${encodeURIComponent(String(r._id))}#staff" class="btn-ghost" style="background:#f3f4f6; padding:8px; border-radius:6px; cursor:pointer;">
                <img src="/pencil-icon.svg" alt="Edit" style="width:16px;height:16px;"/>
              </a>
              <form method="post" action="/settings/staff/${encodeURIComponent(String(r._id))}/delete" onsubmit="return checkAuthThenSubmit(this)" style="margin:0;">
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
      <form method="post" action="/settings/staff/${encodeURIComponent(String(staffToEdit._id))}" onsubmit="event.preventDefault(); return checkAuthThenSubmit(this);" style="display:grid; grid-template-columns: repeat(2, 1fr); gap:8px;">
        <label>Name
          <input class="settings-field" name="name" value="${escapeAttr(staffToEdit.name || '')}" required />
        </label>
        <label>Timezone
          <input class="settings-field" name="timezone" value="${escapeAttr(staffToEdit.timezone || '')}" />
        </label>
        <div style="grid-column: 1 / -1;">
          ${renderStaffWorkingHoursFields(staffToEdit.working_hours_json || '{}', { defaultOpenWeekdays: false })}
        </div>
        <div style="grid-column: 1 / -1; display:flex; gap:8px; justify-content:flex-end;">
          <a href="/settings#staff" class="btn-ghost" style="text-decoration:none;">Cancel</a>
          <button type="submit" class="btn-primary">Update Staff</button>
        </div>
      </form>
    </div>
    ` : ''}
  `.trim();
}

export function renderQuickRepliesPanelScripts() {
  return `
    <script>
      let editingReplyId = null;

      function addQuickReply(event) {
        event.preventDefault();
        const form = event.target;
        const formData = new FormData(form);
        fetch('/auth/status', { credentials: 'include' })
          .then(function(response) { return response.json(); })
          .then(function(authData) {
            if (!authData.signedIn) {
              alert('Please sign in to add quick replies');
              window.location = '/auth';
              return;
            }
            return fetch('/api/quick-replies', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                text: formData.get('text'),
                category: formData.get('category')
              })
            });
          })
          .then(function(response) { return response && response.json ? response.json() : null; })
          .then(function(data) {
            if (data && data.success) {
              if (window.settingsLazyPanels && window.settingsLazyPanels.reload) {
                window.settingsLazyPanels.reload('quick-replies');
              } else {
                location.reload();
              }
            } else {
              alert('Error: ' + ((data && data.error) || 'Failed to add quick reply'));
            }
          })
          .catch(function(error) {
            alert('Error adding quick reply: ' + (error && error.message ? error.message : error));
          });
      }

      function editQuickReply(id, text, category) {
        editingReplyId = id;
        const form = document.getElementById('quick-reply-form');
        if (!form) return;
        const textField = form.querySelector('textarea[name="text"]');
        const categoryField = form.querySelector('select[name="category"]');
        const submitButton = form.querySelector('button[type="submit"]');
        try { textField.value = decodeURIComponent(text); } catch (_) { textField.value = text; }
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
        fetch('/auth/status', { credentials: 'include' })
          .then(function(response) { return response.json(); })
          .then(function(authData) {
            if (!authData.signedIn) {
              alert('Please sign in to update quick replies');
              window.location = '/auth';
              return;
            }
            return fetch('/api/quick-replies/' + editingReplyId, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                text: formData.get('text'),
                category: formData.get('category')
              })
            });
          })
          .then(function(response) { return response && response.json ? response.json() : null; })
          .then(function(data) {
            if (data && data.success) {
              if (window.settingsLazyPanels && window.settingsLazyPanels.reload) {
                window.settingsLazyPanels.reload('quick-replies');
              } else {
                location.reload();
              }
            } else {
              alert('Error: ' + ((data && data.error) || 'Failed to update quick reply'));
            }
          })
          .catch(function(error) {
            alert('Error updating quick reply: ' + (error && error.message ? error.message : error));
          });
      }

      function deleteQuickReply(id) {
        if (!confirm('Are you sure you want to delete this quick reply?')) return;
        fetch('/auth/status', { credentials: 'include' })
          .then(function(response) { return response.json(); })
          .then(function(authData) {
            if (!authData.signedIn) {
              alert('Please sign in to delete quick replies');
              window.location = '/auth';
              return;
            }
            return fetch('/api/quick-replies/' + id, {
              method: 'DELETE',
              headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
              credentials: 'include'
            });
          })
          .then(function(response) { return response && response.json ? response.json() : null; })
          .then(function(data) {
            if (data && data.success) {
              if (window.settingsLazyPanels && window.settingsLazyPanels.reload) {
                window.settingsLazyPanels.reload('quick-replies');
              } else {
                location.reload();
              }
            } else {
              alert('Error: ' + ((data && data.error) || 'Failed to delete quick reply'));
            }
          })
          .catch(function(error) {
            alert('Error deleting quick reply: ' + (error && error.message ? error.message : error));
          });
      }

      function filterQuickRepliesSettings(category) {
        const items = document.querySelectorAll('.quick-reply-item');
        const buttons = document.querySelectorAll('.quick-replies-categories button');
        buttons.forEach(function(btn) {
          btn.style.background = '#e9ecef';
          btn.style.color = '#495057';
        });
        const activeButton = document.querySelector('[onclick="filterQuickRepliesSettings(\\'' + category + '\\')"]');
        if (activeButton) {
          activeButton.style.background = '#007bff';
          activeButton.style.color = 'white';
        }
        items.forEach(function(item) {
          item.style.display = (category === 'All' || item.dataset.category === category) ? 'block' : 'none';
        });
      }

      document.addEventListener('click', function(e) {
        if (!e.target.closest('#quick-reply-form') && editingReplyId) {
          editingReplyId = null;
          const form = document.getElementById('quick-reply-form');
          if (!form) return;
          const submitButton = form.querySelector('button[type="submit"]');
          submitButton.textContent = 'Add Reply';
          submitButton.onclick = null;
          form.reset();
        }
      });
    </script>
  `.trim();
}

export function renderQuickRepliesPanelHtml({ quickReplies = [], quickReplyCategories = [] } = {}) {
  return `
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
              ${quickReplyCategories.map((cat) => `
                <button type="button" class="btn-ghost text-2xs" onclick="filterQuickRepliesSettings('${escapeAttr(cat.category)}')" style="background: #e9ecef; color: #495057; border: none; padding: 4px 8px; margin-right: 4px; border-radius: 4px; cursor: pointer;">
                  ${escapeHtml(cat.category)} (${cat.count})
                </button>
              `).join('')}
            </div>
          ` : ''}
          <div id="quick-replies-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 8px;">
            ${quickReplies.map((reply) => `
              <div class="quick-reply-item" data-category="${escapeAttr(reply.category || 'General')}" style="background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px; padding: 12px; position: relative;">
                <div style="display: flex; justify-content: between; align-items: start; gap: 8px;">
                  <div style="flex: 1;">
                    <div style="font-weight: 500; color: #495057; margin-bottom: 4px;">${escapeHtml(reply.category || 'General')}</div>
                    <div class="text-sm" style="color: #666; line-height: var(--line-height-snug);">${escapeHtml(reply.text || '')}</div>
                    ${reply.usage_count > 0 ? `<div class="text-2xs" style="color: #6c757d; margin-top: 4px;">Used ${reply.usage_count} times</div>` : ''}
                  </div>
                  <div style="display: flex; gap: 4px;">
                    <button type="button" onclick="editQuickReply(${Number(reply.id)}, '${encodeURIComponent(reply.text || '')}', '${escapeAttr(reply.category || 'General')}')" style="background:#f0f9ff; padding:8px; border-radius:6px; cursor:pointer;" class="btn-ghost">
                      <img src="/pencil-icon.svg" alt="Edit" style="width:16px;height:16px;"/>
                    </button>
                    <button type="button" onclick="deleteQuickReply(${Number(reply.id)})" style="background:#fef2f2; padding:8px; border-radius:6px; cursor:pointer;" class="btn-ghost">
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
    ${renderQuickRepliesPanelScripts()}
  `.trim();
}

export async function buildLazySettingsPanelPayload(panelId, userId, options = {}) {
  const formPanels = new Set([
    "business",
    "whatsapp",
    "ai_configuration",
    "holidays",
    "bookings_section",
  ]);

  if (panelId === "billing") {
    return buildLazyBillingPanelPayload(userId);
  }

  if (formPanels.has(panelId)) {
    const settings = options.settings || await getSettingsForUser(userId);
    const plan = options.plan || await getUserPlan(userId).catch(() => ({ plan_name: "free" }));
    const html = await buildLazyFormPanelHtml(panelId, userId, settings, plan);
    return html ? { html } : null;
  }

  if (panelId === 'staff') {
    const editStaffId = options.editStaffId || null;
    const timezone = options.timezone || '';
    const staff = await Staff.find({ user_id: userId })
      .select('_id name timezone slot_minutes working_hours_json')
      .sort({ _id: -1 })
      .limit(50)
      .lean();
    const staffToEdit = editStaffId
      ? await Staff.findOne({ _id: String(editStaffId), user_id: userId }).lean().catch(() => null)
      : null;
    return { html: renderStaffPanelHtml({ staff, staffToEdit, timezone }) };
  }

  if (panelId === 'quick-replies') {
    const [quickReplies, quickReplyCategories] = await Promise.all([
      getQuickReplies(userId),
      getQuickReplyCategories(userId),
    ]);
    return { html: renderQuickRepliesPanelHtml({ quickReplies, quickReplyCategories }) };
  }

  return null;
}

/** @deprecated Use buildLazySettingsPanelPayload */
export async function buildLazySettingsPanelHtml(panelId, userId, options = {}) {
  const payload = await buildLazySettingsPanelPayload(panelId, userId, options);
  return payload?.html || null;
}
