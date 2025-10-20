import { ensureAuthed, getCurrentUserId, getSignedInEmail } from '../middleware/auth.mjs';
import { renderSidebar, renderTopbar, getProfessionalHead } from '../utils.mjs';
import { 
  getApiEndpoints, 
  createApiEndpoint, 
  updateApiEndpoint, 
  deleteApiEndpoint,
  getApiUsageStats,
  createApiKey,
  getApiKeys,
  revokeApiKey,
  builtInHandlers,
  API_ENDPOINT_TYPES,
  API_CATEGORIES
} from '../services/apiEndpoints.mjs';
import { logHelpers } from '../monitoring/logger.mjs';

export default function registerApiRoutes(app) {
  // API management dashboard
  app.get('/api-management', ensureAuthed, async (req, res) => {
    const email = await getSignedInEmail(req);
    const userId = getCurrentUserId(req);

    try {
      const endpoints = getApiEndpoints(userId);
      const apiKeys = getApiKeys(userId);
      const usageStats = getApiUsageStats(userId);

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`
        <html>
          ${getProfessionalHead('API Management')}
          <body>
            <script src="/toast.js"></script>
            <script src="/notifications.js"></script>
            <div class="container">
              ${renderTopbar('API Management', email)}
              <div class="layout">
                ${renderSidebar('api-management')}
                <main class="main">
                  <div class="main-content">
                    <div class="page-header">
                      <h1>API Management</h1>
                      <div class="header-actions">
                        <button onclick="showCreateApiKeyModal()" class="button-secondary">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px;">
                            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                          </svg>
                          Create API Key
                        </button>
                        <button onclick="showCreateEndpointModal()" class="button-primary">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px;">
                            <path d="M12 5v14M5 12h14"/>
                          </svg>
                          Create Endpoint
                        </button>
                      </div>
                    </div>

                    <!-- API Usage Statistics -->
                    <div class="stats-grid">
                      <div class="stat-card">
                        <div class="stat-header">
                          <h3>Total Requests</h3>
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #3B82F6;">
                            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                          </svg>
                        </div>
                        <div class="stat-value">${usageStats.reduce((sum, stat) => sum + (stat.total_requests || 0), 0)}</div>
                      </div>
                      
                      <div class="stat-card">
                        <div class="stat-header">
                          <h3>Success Rate</h3>
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #10B981;">
                            <path d="M9 12l2 2 4-4"/>
                            <path d="M21 12c-1 0-3-1-3-3s2-3 3-3 3 1 3 3-2 3-3 3"/>
                            <path d="M3 12c1 0 3-1 3-3s-2-3-3-3-3 1-3 3 2 3 3 3"/>
                          </svg>
                        </div>
                        <div class="stat-value">
                          ${usageStats.length > 0 ? 
                            Math.round(usageStats.reduce((sum, stat) => sum + (stat.successful_requests || 0), 0) / 
                            usageStats.reduce((sum, stat) => sum + (stat.total_requests || 0), 0) * 100) || 0 : 0}%
                        </div>
                      </div>
                      
                      <div class="stat-card">
                        <div class="stat-header">
                          <h3>Avg Response Time</h3>
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #F59E0B;">
                            <circle cx="12" cy="12" r="10"/>
                            <polyline points="12,6 12,12 16,14"/>
                          </svg>
                        </div>
                        <div class="stat-value">
                          ${usageStats.length > 0 ? 
                            Math.round(usageStats.reduce((sum, stat) => sum + (stat.avg_response_time_ms || 0), 0) / usageStats.length) : 0}ms
                        </div>
                      </div>
                      
                      <div class="stat-card">
                        <div class="stat-header">
                          <h3>Active Endpoints</h3>
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #8B5CF6;">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                          </svg>
                        </div>
                        <div class="stat-value">${endpoints.filter(e => e.is_active).length}</div>
                      </div>
                    </div>

                    <!-- API Keys Section -->
                    <div class="card">
                      <div class="card-header">
                        <h2>API Keys</h2>
                        <button onclick="showCreateApiKeyModal()" class="button-secondary">Create New Key</button>
                      </div>
                      <div class="card-content">
                        ${apiKeys.length === 0 ? `
                          <div class="empty-state">
                            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="color: #9CA3AF;">
                              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                            </svg>
                            <h3>No API keys created</h3>
                            <p>Create an API key to start using the WhatsApp Agent API.</p>
                            <button onclick="showCreateApiKeyModal()" class="button-primary">Create API Key</button>
                          </div>
                        ` : `
                          <div class="api-keys-list">
                            ${apiKeys.map(key => `
                              <div class="api-key-item">
                                <div class="api-key-info">
                                  <h3>${key.name}</h3>
                                  <p class="api-key-preview">wa_••••••••••••••••••••••••••••••••</p>
                                  <div class="api-key-meta">
                                    <span class="api-key-permissions">${key.permissions.length} permissions</span>
                                    <span class="api-key-rate-limit">${key.rate_limit_per_minute}/min</span>
                                    <span class="status-badge status-${key.is_active ? 'active' : 'inactive'}">${key.is_active ? 'Active' : 'Inactive'}</span>
                                  </div>
                                </div>
                                <div class="api-key-actions">
                                  <button onclick="copyApiKey('${key.id}')" class="button-secondary" title="Copy Key">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                    </svg>
                                  </button>
                                  <button onclick="revokeApiKey(${key.id})" class="button-danger" title="Revoke Key">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                      <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                                    </svg>
                                  </button>
                                </div>
                              </div>
                            `).join('')}
                          </div>
                        `}
                      </div>
                    </div>

                    <!-- API Endpoints Section -->
                    <div class="card">
                      <div class="card-header">
                        <h2>API Endpoints</h2>
                        <button onclick="showCreateEndpointModal()" class="button-secondary">Create Endpoint</button>
                      </div>
                      <div class="card-content">
                        ${endpoints.length === 0 ? `
                          <div class="empty-state">
                            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="color: #9CA3AF;">
                              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                            </svg>
                            <h3>No custom endpoints</h3>
                            <p>Create custom API endpoints to extend the WhatsApp Agent functionality.</p>
                            <button onclick="showCreateEndpointModal()" class="button-primary">Create Endpoint</button>
                          </div>
                        ` : `
                          <div class="endpoints-list">
                            ${endpoints.map(endpoint => `
                              <div class="endpoint-item">
                                <div class="endpoint-header">
                                  <div class="endpoint-info">
                                    <h3>${endpoint.name}</h3>
                                    <p class="endpoint-path">
                                      <span class="method-badge method-${endpoint.method.toLowerCase()}">${endpoint.method}</span>
                                      <span class="path-text">${endpoint.path}</span>
                                    </p>
                                    <div class="endpoint-meta">
                                      <span class="endpoint-category">${endpoint.category}</span>
                                      <span class="endpoint-rate-limit">${endpoint.rate_limit_per_minute}/min</span>
                                      <span class="status-badge status-${endpoint.is_active ? 'active' : 'inactive'}">${endpoint.is_active ? 'Active' : 'Inactive'}</span>
                                    </div>
                                  </div>
                                  <div class="endpoint-actions">
                                    <button onclick="testEndpoint(${endpoint.id})" class="button-secondary" title="Test Endpoint">
                                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M9 12l2 2 4-4"/>
                                        <path d="M21 12c-1 0-3-1-3-3s2-3 3-3 3 1 3 3-2 3-3 3"/>
                                        <path d="M3 12c1 0 3-1 3-3s-2-3-3-3-3 1-3 3 2 3 3 3"/>
                                      </svg>
                                    </button>
                                    <button onclick="editEndpoint(${endpoint.id})" class="button-secondary" title="Edit Endpoint">
                                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                        <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                      </svg>
                                    </button>
                                    <button onclick="deleteEndpoint(${endpoint.id})" class="button-danger" title="Delete Endpoint">
                                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                                      </svg>
                                    </button>
                                  </div>
                                </div>
                                <div class="endpoint-details">
                                  ${endpoint.description ? `<p class="endpoint-description">${endpoint.description}</p>` : ''}
                                  <div class="endpoint-stats">
                                    <span>Handler: <code>${endpoint.handler_function}</code></span>
                                    <span>Auth Required: ${endpoint.authentication_required ? 'Yes' : 'No'}</span>
                                  </div>
                                </div>
                              </div>
                            `).join('')}
                          </div>
                        `}
                      </div>
                    </div>

                    <!-- Built-in Endpoints Documentation -->
                    <div class="card">
                      <div class="card-header">
                        <h2>Built-in Endpoints</h2>
                        <p class="card-subtitle">Pre-configured API endpoints available out of the box</p>
                      </div>
                      <div class="card-content">
                        <div class="builtin-endpoints">
                          <div class="endpoint-category">
                            <h3>Messages</h3>
                            <div class="endpoint-doc">
                              <div class="endpoint-doc-item">
                                <span class="method-badge method-get">GET</span>
                                <span class="path-text">/api/messages</span>
                                <span class="description">Retrieve messages with filtering and pagination</span>
                              </div>
                              <div class="endpoint-doc-item">
                                <span class="method-badge method-post">POST</span>
                                <span class="path-text">/api/messages</span>
                                <span class="description">Send a new message</span>
                              </div>
                            </div>
                          </div>
                          
                          <div class="endpoint-category">
                            <h3>Contacts</h3>
                            <div class="endpoint-doc">
                              <div class="endpoint-doc-item">
                                <span class="method-badge method-get">GET</span>
                                <span class="path-text">/api/contacts</span>
                                <span class="description">Retrieve contacts with search</span>
                              </div>
                              <div class="endpoint-doc-item">
                                <span class="method-badge method-post">POST</span>
                                <span class="path-text">/api/contacts</span>
                                <span class="description">Create a new contact</span>
                              </div>
                            </div>
                          </div>
                          
                          <div class="endpoint-category">
                            <h3>Analytics</h3>
                            <div class="endpoint-doc">
                              <div class="endpoint-doc-item">
                                <span class="method-badge method-get">GET</span>
                                <span class="path-text">/api/analytics</span>
                                <span class="description">Get usage analytics and statistics</span>
                              </div>
                            </div>
                          </div>
                          
                          <div class="endpoint-category">
                            <h3>Webhooks</h3>
                            <div class="endpoint-doc">
                              <div class="endpoint-doc-item">
                                <span class="method-badge method-get">GET</span>
                                <span class="path-text">/api/webhooks</span>
                                <span class="description">List webhook configurations</span>
                              </div>
                              <div class="endpoint-doc-item">
                                <span class="method-badge method-post">POST</span>
                                <span class="path-text">/api/webhooks</span>
                                <span class="description">Create a new webhook</span>
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

            <!-- Create API Key Modal -->
            <div id="apiKeyModal" class="modal">
              <div class="modal-content">
                <div class="modal-header">
                  <h2>Create API Key</h2>
                  <button onclick="closeApiKeyModal()" class="modal-close">&times;</button>
                </div>
                <form id="apiKeyForm" onsubmit="handleApiKeySubmit(event)">
                  <div class="form-group">
                    <label for="apiKeyName">Name *</label>
                    <input type="text" id="apiKeyName" name="name" required placeholder="My API Key">
                  </div>
                  
                  <div class="form-group">
                    <label for="apiKeyPermissions">Permissions</label>
                    <div class="checkbox-group">
                      <label class="checkbox-label">
                        <input type="checkbox" name="permissions" value="messages:read" checked>
                        <span class="checkbox-text">Read Messages</span>
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" name="permissions" value="messages:write" checked>
                        <span class="checkbox-text">Send Messages</span>
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" name="permissions" value="contacts:read" checked>
                        <span class="checkbox-text">Read Contacts</span>
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" name="permissions" value="contacts:write" checked>
                        <span class="checkbox-text">Manage Contacts</span>
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" name="permissions" value="analytics:read">
                        <span class="checkbox-text">Read Analytics</span>
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" name="permissions" value="webhooks:manage">
                        <span class="checkbox-text">Manage Webhooks</span>
                      </label>
                    </div>
                  </div>
                  
                  <div class="form-group">
                    <label for="apiKeyRateLimit">Rate Limit (requests per minute)</label>
                    <input type="number" id="apiKeyRateLimit" name="rateLimitPerMinute" min="1" max="1000" value="60">
                  </div>
                  
                  <div class="form-group">
                    <label for="apiKeyExpires">Expires At (optional)</label>
                    <input type="datetime-local" id="apiKeyExpires" name="expiresAt">
                  </div>
                  
                  <div class="form-actions">
                    <button type="button" onclick="closeApiKeyModal()" class="button-secondary">Cancel</button>
                    <button type="submit" class="button-primary">Create API Key</button>
                  </div>
                </form>
              </div>
            </div>

            <!-- Create Endpoint Modal -->
            <div id="endpointModal" class="modal">
              <div class="modal-content">
                <div class="modal-header">
                  <h2 id="endpointModalTitle">Create API Endpoint</h2>
                  <button onclick="closeEndpointModal()" class="modal-close">&times;</button>
                </div>
                <form id="endpointForm" onsubmit="handleEndpointSubmit(event)">
                  <div class="form-group">
                    <label for="endpointName">Name *</label>
                    <input type="text" id="endpointName" name="name" required placeholder="My Custom Endpoint">
                  </div>
                  
                  <div class="form-group">
                    <label for="endpointPath">Path *</label>
                    <input type="text" id="endpointPath" name="path" required placeholder="/api/custom" pattern="^/api/.*">
                  </div>
                  
                  <div class="form-group">
                    <label for="endpointMethod">HTTP Method *</label>
                    <select id="endpointMethod" name="method" required>
                      ${Object.values(API_ENDPOINT_TYPES).map(method => `
                        <option value="${method}">${method}</option>
                      `).join('')}
                    </select>
                  </div>
                  
                  <div class="form-group">
                    <label for="endpointCategory">Category *</label>
                    <select id="endpointCategory" name="category" required>
                      ${Object.values(API_CATEGORIES).map(category => `
                        <option value="${category}">${category.charAt(0).toUpperCase() + category.slice(1)}</option>
                      `).join('')}
                    </select>
                  </div>
                  
                  <div class="form-group">
                    <label for="endpointDescription">Description</label>
                    <textarea id="endpointDescription" name="description" placeholder="Describe what this endpoint does"></textarea>
                  </div>
                  
                  <div class="form-group">
                    <label for="endpointHandler">Handler Function *</label>
                    <select id="endpointHandler" name="handlerFunction" required>
                      <option value="">Select a handler...</option>
                      ${Object.keys(builtInHandlers).map(handler => `
                        <option value="${handler}">${handler}</option>
                      `).join('')}
                    </select>
                  </div>
                  
                  <div class="form-group">
                    <label for="endpointAuthRequired">Authentication Required</label>
                    <label class="checkbox-label">
                      <input type="checkbox" id="endpointAuthRequired" name="authenticationRequired" checked>
                      <span class="checkbox-text">Require API key authentication</span>
                    </label>
                  </div>
                  
                  <div class="form-group">
                    <label for="endpointRateLimit">Rate Limit (requests per minute)</label>
                    <input type="number" id="endpointRateLimit" name="rateLimitPerMinute" min="1" max="1000" value="60">
                  </div>
                  
                  <div class="form-actions">
                    <button type="button" onclick="closeEndpointModal()" class="button-secondary">Cancel</button>
                    <button type="submit" class="button-primary">Save Endpoint</button>
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

              .header-actions {
                display: flex;
                gap: 0.5rem;
              }

              .stats-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 1rem;
                margin-bottom: 2rem;
              }

              .stat-card {
                background: white;
                border: 1px solid #E5E7EB;
                border-radius: 8px;
                padding: 1.5rem;
                text-align: center;
              }

              .stat-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 1rem;
              }

              .stat-header h3 {
                margin: 0;
                font-size: 0.9rem;
                font-weight: 600;
                color: #6B7280;
              }

              .stat-value {
                font-size: 2rem;
                font-weight: 700;
                color: #111827;
              }

              .api-keys-list, .endpoints-list {
                display: flex;
                flex-direction: column;
                gap: 1rem;
              }

              .api-key-item, .endpoint-item {
                border: 1px solid #E5E7EB;
                border-radius: 8px;
                padding: 1.5rem;
                background: white;
              }

              .api-key-header, .endpoint-header {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                margin-bottom: 1rem;
              }

              .api-key-info h3, .endpoint-info h3 {
                margin: 0 0 0.5rem 0;
                font-size: 1.2rem;
                font-weight: 600;
              }

              .api-key-preview, .endpoint-path {
                color: #6B7280;
                font-family: monospace;
                font-size: 0.9rem;
                margin: 0 0 0.5rem 0;
              }

              .api-key-meta, .endpoint-meta {
                display: flex;
                gap: 0.5rem;
                align-items: center;
              }

              .api-key-permissions, .endpoint-category {
                color: #6B7280;
                font-size: 0.9rem;
              }

              .api-key-rate-limit, .endpoint-rate-limit {
                color: #6B7280;
                font-size: 0.9rem;
              }

              .api-key-actions, .endpoint-actions {
                display: flex;
                gap: 0.5rem;
              }

              .api-key-actions button, .endpoint-actions button {
                padding: 0.5rem;
                border: 1px solid #D1D5DB;
                background: white;
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.2s;
              }

              .api-key-actions button:hover, .endpoint-actions button:hover {
                background: #F9FAFB;
                border-color: #9CA3AF;
              }

              .api-key-actions .button-danger:hover, .endpoint-actions .button-danger:hover {
                background: #FEF2F2;
                border-color: #FCA5A5;
                color: #DC2626;
              }

              .endpoint-details {
                border-top: 1px solid #F3F4F6;
                padding-top: 1rem;
              }

              .endpoint-description {
                color: #6B7280;
                font-size: 0.9rem;
                margin: 0 0 0.5rem 0;
              }

              .endpoint-stats {
                display: flex;
                gap: 1rem;
                font-size: 0.9rem;
                color: #6B7280;
              }

              .endpoint-stats code {
                background: #F3F4F6;
                padding: 0.25rem 0.5rem;
                border-radius: 4px;
                font-family: monospace;
              }

              .method-badge {
                padding: 0.25rem 0.5rem;
                border-radius: 4px;
                font-size: 0.8rem;
                font-weight: 600;
                margin-right: 0.5rem;
              }

              .method-get {
                background: #DCFCE7;
                color: #166534;
              }

              .method-post {
                background: #DBEAFE;
                color: #1E40AF;
              }

              .method-put {
                background: #FEF3C7;
                color: #92400E;
              }

              .method-delete {
                background: #FEE2E2;
                color: #991B1B;
              }

              .method-patch {
                background: #F3E8FF;
                color: #7C3AED;
              }

              .path-text {
                font-family: monospace;
                color: #374151;
              }

              .builtin-endpoints {
                display: flex;
                flex-direction: column;
                gap: 1.5rem;
              }

              .endpoint-category h3 {
                margin: 0 0 1rem 0;
                font-size: 1.1rem;
                font-weight: 600;
                color: #374151;
              }

              .endpoint-doc {
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
              }

              .endpoint-doc-item {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                padding: 0.75rem;
                background: #F9FAFB;
                border-radius: 6px;
              }

              .endpoint-doc-item .description {
                color: #6B7280;
                font-size: 0.9rem;
                margin-left: auto;
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

              .card-subtitle {
                color: #6B7280;
                font-size: 0.9rem;
                margin: 0;
              }
            </style>

            <script>
              let currentEndpointId = null;
              let currentApiKeyId = null;

              function showCreateApiKeyModal() {
                currentApiKeyId = null;
                document.getElementById('apiKeyModal').style.display = 'block';
              }

              function closeApiKeyModal() {
                document.getElementById('apiKeyModal').style.display = 'none';
                currentApiKeyId = null;
              }

              function showCreateEndpointModal() {
                currentEndpointId = null;
                document.getElementById('endpointModalTitle').textContent = 'Create API Endpoint';
                document.getElementById('endpointForm').reset();
                document.getElementById('endpointModal').style.display = 'block';
              }

              function closeEndpointModal() {
                document.getElementById('endpointModal').style.display = 'none';
                currentEndpointId = null;
              }

              async function handleApiKeySubmit(event) {
                event.preventDefault();
                
                const formData = new FormData(event.target);
                const apiKeyData = {
                  name: formData.get('name'),
                  permissions: Array.from(document.querySelectorAll('input[name="permissions"]:checked')).map(cb => cb.value),
                  rateLimitPerMinute: parseInt(formData.get('rateLimitPerMinute')),
                  expiresAt: formData.get('expiresAt') ? Math.floor(new Date(formData.get('expiresAt')).getTime() / 1000) : null
                };

                try {
                  const response = await fetch('/api/api-keys', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(apiKeyData)
                  });

                  if (response.ok) {
                    const result = await response.json();
                    closeApiKeyModal();
                    showToast(\`API key created: \${result.key}\`, 'success');
                    refreshPage();
                  } else {
                    const error = await response.json();
                    showToast(error.message || 'Error creating API key', 'error');
                  }
                } catch (error) {
                  console.error('Error creating API key:', error);
                  showToast('Error creating API key', 'error');
                }
              }

              async function handleEndpointSubmit(event) {
                event.preventDefault();
                
                const formData = new FormData(event.target);
                const endpointData = {
                  name: formData.get('name'),
                  path: formData.get('path'),
                  method: formData.get('method'),
                  category: formData.get('category'),
                  description: formData.get('description'),
                  handlerFunction: formData.get('handlerFunction'),
                  authenticationRequired: formData.get('authenticationRequired') === 'on',
                  rateLimitPerMinute: parseInt(formData.get('rateLimitPerMinute'))
                };

                try {
                  const url = currentEndpointId ? \`/api/endpoints/\${currentEndpointId}\` : '/api/endpoints';
                  const method = currentEndpointId ? 'PUT' : 'POST';
                  
                  const response = await fetch(url, {
                    method: method,
                    headers: {
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(endpointData)
                  });

                  if (response.ok) {
                    closeEndpointModal();
                    refreshPage();
                    showToast('Endpoint saved successfully', 'success');
                  } else {
                    const error = await response.json();
                    showToast(error.message || 'Error saving endpoint', 'error');
                  }
                } catch (error) {
                  console.error('Error saving endpoint:', error);
                  showToast('Error saving endpoint', 'error');
                }
              }

              async function revokeApiKey(keyId) {
                if (!confirm('Are you sure you want to revoke this API key?')) {
                  return;
                }

                try {
                  const response = await fetch(\`/api/api-keys/\${keyId}/revoke\`, {
                    method: 'POST'
                  });

                  if (response.ok) {
                    refreshPage();
                    showToast('API key revoked successfully', 'success');
                  } else {
                    const error = await response.json();
                    showToast(error.message || 'Error revoking API key', 'error');
                  }
                } catch (error) {
                  console.error('Error revoking API key:', error);
                  showToast('Error revoking API key', 'error');
                }
              }

              async function copyApiKey(keyId) {
                try {
                  const response = await fetch(\`/api/api-keys/\${keyId}\`);
                  const keyData = await response.json();
                  
                  await navigator.clipboard.writeText(keyData.key);
                  showToast('API key copied to clipboard', 'success');
                } catch (error) {
                  console.error('Error copying API key:', error);
                  showToast('Error copying API key', 'error');
                }
              }

              async function deleteEndpoint(endpointId) {
                if (!confirm('Are you sure you want to delete this endpoint?')) {
                  return;
                }

                try {
                  const response = await fetch(\`/api/endpoints/\${endpointId}\`, {
                    method: 'DELETE'
                  });

                  if (response.ok) {
                    refreshPage();
                    showToast('Endpoint deleted successfully', 'success');
                  } else {
                    const error = await response.json();
                    showToast(error.message || 'Error deleting endpoint', 'error');
                  }
                } catch (error) {
                  console.error('Error deleting endpoint:', error);
                  showToast('Error deleting endpoint', 'error');
                }
              }

              function refreshPage() {
                window.location.reload();
              }

              // Close modals when clicking outside
              window.onclick = function(event) {
                const apiKeyModal = document.getElementById('apiKeyModal');
                const endpointModal = document.getElementById('endpointModal');
                
                if (event.target === apiKeyModal) {
                  closeApiKeyModal();
                }
                if (event.target === endpointModal) {
                  closeEndpointModal();
                }
              }
            </script>
          </body>
        </html>
      `);
    } catch (error) {
      logHelpers.logError(error, { component: 'api_management_dashboard', userId });
      res.status(500).send('Error loading API management dashboard');
    }
  });

  // API endpoints for API management
  app.get('/api/api-keys', ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const apiKeys = getApiKeys(userId);
      res.json(apiKeys);
    } catch (error) {
      logHelpers.logError(error, { component: 'api_management_api', endpoint: 'GET /api/api-keys' });
      res.status(500).json({ error: 'Failed to fetch API keys' });
    }
  });

  app.post('/api/api-keys', ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const result = createApiKey(userId, req.body);
      res.json(result);
    } catch (error) {
      logHelpers.logError(error, { component: 'api_management_api', endpoint: 'POST /api/api-keys' });
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/api-keys/:id', ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const keyId = parseInt(req.params.id);
      const apiKeys = getApiKeys(userId);
      const apiKey = apiKeys.find(key => key.id === keyId);
      
      if (!apiKey) {
        return res.status(404).json({ error: 'API key not found' });
      }
      
      // Return the actual key (this would need to be stored separately in production)
      res.json({ ...apiKey, key: 'wa_' + 'x'.repeat(64) }); // Placeholder
    } catch (error) {
      logHelpers.logError(error, { component: 'api_management_api', endpoint: 'GET /api/api-keys/:id' });
      res.status(500).json({ error: 'Failed to fetch API key' });
    }
  });

  app.post('/api/api-keys/:id/revoke', ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const keyId = parseInt(req.params.id);
      revokeApiKey(keyId, userId);
      res.json({ message: 'API key revoked successfully' });
    } catch (error) {
      logHelpers.logError(error, { component: 'api_management_api', endpoint: 'POST /api/api-keys/:id/revoke' });
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/endpoints', ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const endpoints = getApiEndpoints(userId);
      res.json(endpoints);
    } catch (error) {
      logHelpers.logError(error, { component: 'api_management_api', endpoint: 'GET /api/endpoints' });
      res.status(500).json({ error: 'Failed to fetch endpoints' });
    }
  });

  app.post('/api/endpoints', ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const endpointId = createApiEndpoint(userId, req.body);
      res.json({ endpointId, message: 'Endpoint created successfully' });
    } catch (error) {
      logHelpers.logError(error, { component: 'api_management_api', endpoint: 'POST /api/endpoints' });
      res.status(400).json({ error: error.message });
    }
  });

  app.put('/api/endpoints/:id', ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const endpointId = parseInt(req.params.id);
      updateApiEndpoint(endpointId, userId, req.body);
      res.json({ message: 'Endpoint updated successfully' });
    } catch (error) {
      logHelpers.logError(error, { component: 'api_management_api', endpoint: 'PUT /api/endpoints/:id' });
      res.status(400).json({ error: error.message });
    }
  });

  app.delete('/api/endpoints/:id', ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const endpointId = parseInt(req.params.id);
      deleteApiEndpoint(endpointId, userId);
      res.json({ message: 'Endpoint deleted successfully' });
    } catch (error) {
      logHelpers.logError(error, { component: 'api_management_api', endpoint: 'DELETE /api/endpoints/:id' });
      res.status(400).json({ error: error.message });
    }
  });
}
