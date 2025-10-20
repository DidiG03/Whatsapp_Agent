import { ensureAuthed, getCurrentUserId, getSignedInEmail } from '../middleware/auth.mjs';
import { renderSidebar, renderTopbar, getProfessionalHead } from '../utils.mjs';
import { 
  getWebhookConfigs, 
  createWebhookConfig, 
  updateWebhookConfig, 
  deleteWebhookConfig,
  getWebhookStats,
  testWebhookConfig,
  WEBHOOK_EVENTS,
  WEBHOOK_STATUS
} from '../services/webhooks.mjs';
import { logHelpers } from '../monitoring/logger.mjs';

export default function registerWebhookRoutes(app) {
  // Webhook management dashboard
  app.get('/webhooks', ensureAuthed, async (req, res) => {
    const email = await getSignedInEmail(req);
    const userId = getCurrentUserId(req);

    try {
      const webhooks = getWebhookConfigs(userId);
      const stats = getWebhookStats(userId);

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`
        <html>
          ${getProfessionalHead('Webhook Management')}
          <body>
            <script src="/toast.js"></script>
            <script src="/notifications.js"></script>
            <div class="container">
              ${renderTopbar('Webhook Management', email)}
              <div class="layout">
                ${renderSidebar('webhooks')}
                <main class="main">
                  <div class="main-content">
                    <div class="page-header">
                      <h1>Webhook Management</h1>
                      <button onclick="showCreateWebhookModal()" class="button-primary">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px;">
                          <path d="M12 5v14M5 12h14"/>
                        </svg>
                        Create Webhook
                      </button>
                    </div>

                    <!-- Webhook Statistics -->
                    <div class="stats-grid">
                      ${stats.map(stat => `
                        <div class="stat-card">
                          <div class="stat-header">
                            <h3>${stat.name}</h3>
                            <span class="status-badge status-${stat.status}">${stat.status}</span>
                          </div>
                          <div class="stat-content">
                            <div class="stat-item">
                              <span class="stat-label">Total Deliveries:</span>
                              <span class="stat-value">${stat.total_deliveries || 0}</span>
                            </div>
                            <div class="stat-item">
                              <span class="stat-label">Success Rate:</span>
                              <span class="stat-value">${stat.total_deliveries > 0 ? Math.round((stat.successful_deliveries / stat.total_deliveries) * 100) : 0}%</span>
                            </div>
                            <div class="stat-item">
                              <span class="stat-label">Avg Response Time:</span>
                              <span class="stat-value">${Math.round(stat.avg_response_time_ms || 0)}ms</span>
                            </div>
                          </div>
                        </div>
                      `).join('')}
                    </div>

                    <!-- Webhook List -->
                    <div class="card">
                      <div class="card-header">
                        <h2>Webhook Configurations</h2>
                        <div class="card-actions">
                          <button onclick="refreshWebhooks()" class="button-secondary">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px;">
                              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16M21 8v8M21 16h-8"/>
                            </svg>
                            Refresh
                          </button>
                        </div>
                      </div>
                      <div class="card-content">
                        ${webhooks.length === 0 ? `
                          <div class="empty-state">
                            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="color: #9CA3AF;">
                              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                            </svg>
                            <h3>No webhooks configured</h3>
                            <p>Create your first webhook to start receiving real-time events from your WhatsApp Agent.</p>
                            <button onclick="showCreateWebhookModal()" class="button-primary">Create Webhook</button>
                          </div>
                        ` : `
                          <div class="webhook-list">
                            ${webhooks.map(webhook => `
                              <div class="webhook-item" data-webhook-id="${webhook.id}">
                                <div class="webhook-header">
                                  <div class="webhook-info">
                                    <h3>${webhook.name}</h3>
                                    <p class="webhook-url">${webhook.url}</p>
                                    <div class="webhook-meta">
                                      <span class="webhook-method">${webhook.method || 'POST'}</span>
                                      <span class="webhook-events">${webhook.events.length} events</span>
                                      <span class="status-badge status-${webhook.status}">${webhook.status}</span>
                                    </div>
                                  </div>
                                  <div class="webhook-actions">
                                    <button onclick="testWebhook(${webhook.id})" class="button-secondary" title="Test Webhook">
                                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M9 12l2 2 4-4"/>
                                        <path d="M21 12c-1 0-3-1-3-3s2-3 3-3 3 1 3 3-2 3-3 3"/>
                                        <path d="M3 12c1 0 3-1 3-3s-2-3-3-3-3 1-3 3 2 3 3 3"/>
                                      </svg>
                                    </button>
                                    <button onclick="editWebhook(${webhook.id})" class="button-secondary" title="Edit Webhook">
                                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                        <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                      </svg>
                                    </button>
                                    <button onclick="deleteWebhook(${webhook.id})" class="button-danger" title="Delete Webhook">
                                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                                      </svg>
                                    </button>
                                  </div>
                                </div>
                                <div class="webhook-details">
                                  <div class="webhook-events-list">
                                    <strong>Events:</strong>
                                    ${webhook.events.map(event => `<span class="event-tag">${event}</span>`).join('')}
                                  </div>
                                  ${webhook.description ? `<p class="webhook-description">${webhook.description}</p>` : ''}
                                </div>
                              </div>
                            `).join('')}
                          </div>
                        `}
                      </div>
                    </div>
                  </div>
                </main>
              </div>
            </div>

            <!-- Create/Edit Webhook Modal -->
            <div id="webhookModal" class="modal">
              <div class="modal-content">
                <div class="modal-header">
                  <h2 id="modalTitle">Create Webhook</h2>
                  <button onclick="closeWebhookModal()" class="modal-close">&times;</button>
                </div>
                <form id="webhookForm" onsubmit="handleWebhookSubmit(event)">
                  <div class="form-group">
                    <label for="webhookName">Name *</label>
                    <input type="text" id="webhookName" name="name" required placeholder="My Webhook">
                  </div>
                  
                  <div class="form-group">
                    <label for="webhookUrl">URL *</label>
                    <input type="url" id="webhookUrl" name="url" required placeholder="https://your-server.com/webhook">
                  </div>
                  
                  <div class="form-group">
                    <label for="webhookSecret">Secret Key</label>
                    <input type="text" id="webhookSecret" name="secret" placeholder="Optional secret for signature verification">
                  </div>
                  
                  <div class="form-group">
                    <label for="webhookDescription">Description</label>
                    <textarea id="webhookDescription" name="description" placeholder="Optional description"></textarea>
                  </div>
                  
                  <div class="form-group">
                    <label>Events *</label>
                    <div class="checkbox-group">
                      ${Object.entries(WEBHOOK_EVENTS).map(([key, value]) => `
                        <label class="checkbox-label">
                          <input type="checkbox" name="events" value="${value}">
                          <span class="checkbox-text">${key.replace(/_/g, ' ')}</span>
                        </label>
                      `).join('')}
                    </div>
                  </div>
                  
                  <div class="form-group">
                    <label for="webhookRetryCount">Retry Count</label>
                    <input type="number" id="webhookRetryCount" name="retryCount" min="0" max="10" value="3">
                  </div>
                  
                  <div class="form-group">
                    <label for="webhookTimeout">Timeout (ms)</label>
                    <input type="number" id="webhookTimeout" name="timeoutMs" min="1000" max="60000" value="30000">
                  </div>
                  
                  <div class="form-actions">
                    <button type="button" onclick="closeWebhookModal()" class="button-secondary">Cancel</button>
                    <button type="submit" class="button-primary">Save Webhook</button>
                  </div>
                </form>
              </div>
            </div>

            <style>
              .page-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 2rem;
              }

              .stats-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                gap: 1rem;
                margin-bottom: 2rem;
              }

              .stat-card {
                background: white;
                border: 1px solid #E5E7EB;
                border-radius: 8px;
                padding: 1.5rem;
              }

              .stat-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 1rem;
              }

              .stat-header h3 {
                margin: 0;
                font-size: 1.1rem;
                font-weight: 600;
              }

              .stat-content {
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
              }

              .stat-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
              }

              .stat-label {
                color: #6B7280;
                font-size: 0.9rem;
              }

              .stat-value {
                font-weight: 600;
                color: #111827;
              }

              .webhook-list {
                display: flex;
                flex-direction: column;
                gap: 1rem;
              }

              .webhook-item {
                border: 1px solid #E5E7EB;
                border-radius: 8px;
                padding: 1.5rem;
                background: white;
              }

              .webhook-header {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                margin-bottom: 1rem;
              }

              .webhook-info h3 {
                margin: 0 0 0.5rem 0;
                font-size: 1.2rem;
                font-weight: 600;
              }

              .webhook-url {
                color: #6B7280;
                font-family: monospace;
                font-size: 0.9rem;
                margin: 0 0 0.5rem 0;
              }

              .webhook-meta {
                display: flex;
                gap: 0.5rem;
                align-items: center;
              }

              .webhook-method {
                background: #F3F4F6;
                color: #374151;
                padding: 0.25rem 0.5rem;
                border-radius: 4px;
                font-size: 0.8rem;
                font-weight: 600;
              }

              .webhook-events {
                color: #6B7280;
                font-size: 0.9rem;
              }

              .webhook-actions {
                display: flex;
                gap: 0.5rem;
              }

              .webhook-actions button {
                padding: 0.5rem;
                border: 1px solid #D1D5DB;
                background: white;
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.2s;
              }

              .webhook-actions button:hover {
                background: #F9FAFB;
                border-color: #9CA3AF;
              }

              .webhook-actions .button-danger:hover {
                background: #FEF2F2;
                border-color: #FCA5A5;
                color: #DC2626;
              }

              .webhook-details {
                border-top: 1px solid #F3F4F6;
                padding-top: 1rem;
              }

              .webhook-events-list {
                margin-bottom: 0.5rem;
              }

              .event-tag {
                display: inline-block;
                background: #EFF6FF;
                color: #1D4ED8;
                padding: 0.25rem 0.5rem;
                border-radius: 4px;
                font-size: 0.8rem;
                margin-right: 0.25rem;
                margin-bottom: 0.25rem;
              }

              .webhook-description {
                color: #6B7280;
                font-size: 0.9rem;
                margin: 0;
              }

              .empty-state {
                text-align: center;
                padding: 3rem 1rem;
                color: #6B7280;
              }

              .empty-state svg {
                margin-bottom: 1rem;
              }

              .empty-state h3 {
                margin: 0 0 0.5rem 0;
                color: #374151;
              }

              .empty-state p {
                margin: 0 0 1.5rem 0;
              }

              .checkbox-group {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 0.5rem;
                margin-top: 0.5rem;
              }

              .checkbox-label {
                display: flex;
                align-items: center;
                cursor: pointer;
                padding: 0.5rem;
                border-radius: 4px;
                transition: background-color 0.2s;
              }

              .checkbox-label:hover {
                background: #F9FAFB;
              }

              .checkbox-label input[type="checkbox"] {
                margin-right: 0.5rem;
              }

              .checkbox-text {
                font-size: 0.9rem;
                text-transform: capitalize;
              }

              .status-badge {
                padding: 0.25rem 0.5rem;
                border-radius: 4px;
                font-size: 0.8rem;
                font-weight: 600;
                text-transform: uppercase;
              }

              .status-active {
                background: #D1FAE5;
                color: #065F46;
              }

              .status-inactive {
                background: #F3F4F6;
                color: #6B7280;
              }

              .status-suspended {
                background: #FEF3C7;
                color: #92400E;
              }

              .status-failed {
                background: #FEE2E2;
                color: #991B1B;
              }
            </style>

            <script>
              let currentWebhookId = null;

              function showCreateWebhookModal() {
                currentWebhookId = null;
                document.getElementById('modalTitle').textContent = 'Create Webhook';
                document.getElementById('webhookForm').reset();
                document.getElementById('webhookModal').style.display = 'block';
              }

              function editWebhook(webhookId) {
                currentWebhookId = webhookId;
                document.getElementById('modalTitle').textContent = 'Edit Webhook';
                
                // Fetch webhook data and populate form
                fetch(\`/api/webhooks/\${webhookId}\`)
                  .then(response => response.json())
                  .then(webhook => {
                    document.getElementById('webhookName').value = webhook.name;
                    document.getElementById('webhookUrl').value = webhook.url;
                    document.getElementById('webhookSecret').value = webhook.secret || '';
                    document.getElementById('webhookDescription').value = webhook.description || '';
                    document.getElementById('webhookRetryCount').value = webhook.retry_count;
                    document.getElementById('webhookTimeout').value = webhook.timeout_ms;
                    
                    // Check event checkboxes
                    document.querySelectorAll('input[name="events"]').forEach(checkbox => {
                      checkbox.checked = webhook.events.includes(checkbox.value);
                    });
                    
                    document.getElementById('webhookModal').style.display = 'block';
                  })
                  .catch(error => {
                    console.error('Error fetching webhook:', error);
                    alert('Error fetching webhook data');
                  });
              }

              function closeWebhookModal() {
                document.getElementById('webhookModal').style.display = 'none';
                currentWebhookId = null;
              }

              async function handleWebhookSubmit(event) {
                event.preventDefault();
                
                const formData = new FormData(event.target);
                const webhookData = {
                  name: formData.get('name'),
                  url: formData.get('url'),
                  secret: formData.get('secret'),
                  description: formData.get('description'),
                  events: Array.from(document.querySelectorAll('input[name="events"]:checked')).map(cb => cb.value),
                  retryCount: parseInt(formData.get('retryCount')),
                  timeoutMs: parseInt(formData.get('timeoutMs'))
                };

                try {
                  const url = currentWebhookId ? \`/api/webhooks/\${currentWebhookId}\` : '/api/webhooks';
                  const method = currentWebhookId ? 'PUT' : 'POST';
                  
                  const response = await fetch(url, {
                    method: method,
                    headers: {
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(webhookData)
                  });

                  if (response.ok) {
                    closeWebhookModal();
                    refreshWebhooks();
                    showToast('Webhook saved successfully', 'success');
                  } else {
                    const error = await response.json();
                    showToast(error.message || 'Error saving webhook', 'error');
                  }
                } catch (error) {
                  console.error('Error saving webhook:', error);
                  showToast('Error saving webhook', 'error');
                }
              }

              async function deleteWebhook(webhookId) {
                if (!confirm('Are you sure you want to delete this webhook?')) {
                  return;
                }

                try {
                  const response = await fetch(\`/api/webhooks/\${webhookId}\`, {
                    method: 'DELETE'
                  });

                  if (response.ok) {
                    refreshWebhooks();
                    showToast('Webhook deleted successfully', 'success');
                  } else {
                    const error = await response.json();
                    showToast(error.message || 'Error deleting webhook', 'error');
                  }
                } catch (error) {
                  console.error('Error deleting webhook:', error);
                  showToast('Error deleting webhook', 'error');
                }
              }

              async function testWebhook(webhookId) {
                try {
                  showToast('Testing webhook...', 'info');
                  
                  const response = await fetch(\`/api/webhooks/\${webhookId}/test\`, {
                    method: 'POST'
                  });

                  const result = await response.json();
                  
                  if (result.success) {
                    showToast(\`Webhook test successful! Response: \${result.responseStatus}\`, 'success');
                  } else {
                    showToast(\`Webhook test failed: \${result.errorMessage}\`, 'error');
                  }
                } catch (error) {
                  console.error('Error testing webhook:', error);
                  showToast('Error testing webhook', 'error');
                }
              }

              function refreshWebhooks() {
                window.location.reload();
              }

              // Close modal when clicking outside
              window.onclick = function(event) {
                const modal = document.getElementById('webhookModal');
                if (event.target === modal) {
                  closeWebhookModal();
                }
              }
            </script>
          </body>
        </html>
      `);
    } catch (error) {
      logHelpers.logError(error, { component: 'webhook_dashboard', userId });
      res.status(500).send('Error loading webhook dashboard');
    }
  });

  // API endpoints for webhook management
  app.get('/api/webhooks', ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const webhooks = getWebhookConfigs(userId);
      res.json(webhooks);
    } catch (error) {
      logHelpers.logError(error, { component: 'webhook_api', endpoint: 'GET /api/webhooks' });
      res.status(500).json({ error: 'Failed to fetch webhooks' });
    }
  });

  app.get('/api/webhooks/:id', ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const webhookId = parseInt(req.params.id);
      const webhook = getWebhookConfig(webhookId, userId);
      
      if (!webhook) {
        return res.status(404).json({ error: 'Webhook not found' });
      }
      
      res.json(webhook);
    } catch (error) {
      logHelpers.logError(error, { component: 'webhook_api', endpoint: 'GET /api/webhooks/:id' });
      res.status(500).json({ error: 'Failed to fetch webhook' });
    }
  });

  app.post('/api/webhooks', ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const webhookId = createWebhookConfig(userId, req.body);
      res.json({ webhookId, message: 'Webhook created successfully' });
    } catch (error) {
      logHelpers.logError(error, { component: 'webhook_api', endpoint: 'POST /api/webhooks' });
      res.status(400).json({ error: error.message });
    }
  });

  app.put('/api/webhooks/:id', ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const webhookId = parseInt(req.params.id);
      updateWebhookConfig(webhookId, userId, req.body);
      res.json({ message: 'Webhook updated successfully' });
    } catch (error) {
      logHelpers.logError(error, { component: 'webhook_api', endpoint: 'PUT /api/webhooks/:id' });
      res.status(400).json({ error: error.message });
    }
  });

  app.delete('/api/webhooks/:id', ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const webhookId = parseInt(req.params.id);
      deleteWebhookConfig(webhookId, userId);
      res.json({ message: 'Webhook deleted successfully' });
    } catch (error) {
      logHelpers.logError(error, { component: 'webhook_api', endpoint: 'DELETE /api/webhooks/:id' });
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/webhooks/:id/test', ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const webhookId = parseInt(req.params.id);
      const result = await testWebhookConfig(webhookId, userId);
      res.json(result);
    } catch (error) {
      logHelpers.logError(error, { component: 'webhook_api', endpoint: 'POST /api/webhooks/:id/test' });
      res.status(400).json({ error: error.message });
    }
  });
}
