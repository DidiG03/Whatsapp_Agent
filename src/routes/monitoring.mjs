/**
 * Monitoring Dashboard
 * Provides a web interface for viewing system metrics, logs, and health status
 */

import { ensureAuthed, ensureAdmin, getCurrentUserId, getSignedInEmail } from '../middleware/auth.mjs';
import { renderSidebar, renderTopbar, getProfessionalHead } from '../utils.mjs';
import { getHealthStatus } from '../monitoring/health.mjs';
import { getAllMetrics } from '../monitoring/metrics.mjs';
import { logHelpers } from '../monitoring/logger.mjs';

export default function registerMonitoringRoutes(app) {
  // Main monitoring dashboard - Admin only
  app.get('/monitoring', ensureAuthed, ensureAdmin, async (req, res) => {
    const email = await getSignedInEmail(req);
    const userId = getCurrentUserId(req);
    
    try {
      // Get current metrics and health status
      const metrics = getAllMetrics();
      const health = getHealthStatus() || {};
      
      // Format metrics for display
      const formattedMetrics = {
        system: {
          uptime: Math.floor(process.uptime()),
          memory: metrics.gauges.memory_usage_mb || 0,
          requests: metrics.counters['http_requests_total'] || 0,
          errors: metrics.counters['errors_total'] || 0
        },
        whatsapp: {
          messages_sent: metrics.counters['whatsapp_messages_sent'] || 0,
          messages_received: metrics.counters['whatsapp_messages_received'] || 0,
          api_errors: metrics.counters['whatsapp_api_errors'] || 0
        },
        ai: {
          requests_total: metrics.counters['ai_requests_total'] || 0,
          requests_successful: metrics.counters['ai_requests_successful'] || 0,
          requests_failed: metrics.counters['ai_requests_failed'] || 0
        },
        database: {
          queries_total: metrics.counters['database_queries_total'] || 0,
          errors: metrics.counters['database_errors'] || 0
        }
      };
      
      // Calculate success rates
      const aiSuccessRate = formattedMetrics.ai.requests_total > 0 
        ? Math.round((formattedMetrics.ai.requests_successful / formattedMetrics.ai.requests_total) * 100)
        : 0;
      
      const errorRate = formattedMetrics.system.requests > 0
        ? Math.round((formattedMetrics.system.errors / formattedMetrics.system.requests) * 100)
        : 0;
      
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      
      res.end(`
        <html>${getProfessionalHead('Monitoring Dashboard')}<body>
          <script src="/toast.js"></script>
          <script src="/notifications.js"></script>
          <script src="/auth-utils.js"></script>
          <script>
            // Enhanced authentication check on page load
            (async function checkAuthOnLoad(){
              await window.authManager.checkAuthOnLoad();
            })();
          </script>
          <div class="container">
            ${renderTopbar('Monitoring Dashboard', email)}
            <div class="layout">
              ${renderSidebar('monitoring')}
              <main class="main">
                <div class="main-content">
                  
                  <!-- System Overview -->
                  <div class="card">
                    <h2>System Overview</h2>
                    <div class="grid-3">
                      <div class="metric-card">
                        <div class="metric-value">${formattedMetrics.system.uptime}s</div>
                        <div class="metric-label">Uptime</div>
                      </div>
                      <div class="metric-card">
                        <div class="metric-value">${formattedMetrics.system.memory}MB</div>
                        <div class="metric-label">Memory Usage</div>
                      </div>
                      <div class="metric-card">
                        <div class="metric-value">${formattedMetrics.system.requests}</div>
                        <div class="metric-label">Total Requests</div>
                      </div>
                      <div class="metric-card">
                        <div class="metric-value">${formattedMetrics.system.errors}</div>
                        <div class="metric-label">Total Errors</div>
                      </div>
                      <div class="metric-card">
                        <div class="metric-value">${errorRate}%</div>
                        <div class="metric-label">Error Rate</div>
                      </div>
                      <div class="metric-card">
                        <div class="metric-value">${health.overall_status || 'unknown'}</div>
                        <div class="metric-label">Health Status</div>
                      </div>
                    </div>
                  </div>
                  
                  <!-- WhatsApp Metrics -->
                  <div class="card">
                    <h2>WhatsApp Integration</h2>
                    <div class="grid-3">
                      <div class="metric-card">
                        <div class="metric-value">${formattedMetrics.whatsapp.messages_sent}</div>
                        <div class="metric-label">Messages Sent</div>
                      </div>
                      <div class="metric-card">
                        <div class="metric-value">${formattedMetrics.whatsapp.messages_received}</div>
                        <div class="metric-label">Messages Received</div>
                      </div>
                      <div class="metric-card">
                        <div class="metric-value">${formattedMetrics.whatsapp.api_errors}</div>
                        <div class="metric-label">API Errors</div>
                      </div>
                    </div>
                  </div>
                  
                  <!-- AI Metrics -->
                  <div class="card">
                    <h2>AI Performance</h2>
                    <div class="grid-3">
                      <div class="metric-card">
                        <div class="metric-value">${formattedMetrics.ai.requests_total}</div>
                        <div class="metric-label">Total Requests</div>
                      </div>
                      <div class="metric-card">
                        <div class="metric-value">${formattedMetrics.ai.requests_successful}</div>
                        <div class="metric-label">Successful</div>
                      </div>
                      <div class="metric-card">
                        <div class="metric-value">${aiSuccessRate}%</div>
                        <div class="metric-label">Success Rate</div>
                      </div>
                    </div>
                  </div>
                  
                  <!-- Database Metrics -->
                  <div class="card">
                    <h2>Database Performance</h2>
                    <div class="grid-2">
                      <div class="metric-card">
                        <div class="metric-value">${formattedMetrics.database.queries_total}</div>
                        <div class="metric-label">Total Queries</div>
                      </div>
                      <div class="metric-card">
                        <div class="metric-value">${formattedMetrics.database.errors}</div>
                        <div class="metric-label">Database Errors</div>
                      </div>
                    </div>
                  </div>
                  
                  <!-- Health Checks -->
                  <div class="card">
                    <h2>Health Checks</h2>
                    <div class="health-checks">
                      ${Object.entries(health).filter(([key]) => key !== 'last_check' && key !== 'overall_status' && key !== 'check_duration').map(([check, data]) => {
                        if (!data) {
                          return `
                            <div class="health-check-item">
                              <div class="health-check-name">${check.replace(/_/g, ' ').toUpperCase()}</div>
                              <div class="health-check-status unknown">UNKNOWN</div>
                              <div class="health-check-error">No data available</div>
                            </div>
                          `;
                        }
                        return `
                          <div class="health-check-item">
                            <div class="health-check-name">${check.replace(/_/g, ' ').toUpperCase()}</div>
                            <div class="health-check-status ${data.status || 'unknown'}">${data.status || 'UNKNOWN'}</div>
                            ${data.response_time ? `<div class="health-check-detail">${data.response_time}ms</div>` : ''}
                            ${data.error ? `<div class="health-check-error">${data.error}</div>` : ''}
                          </div>
                        `;
                      }).join('')}
                    </div>
                  </div>
                  
                  <!-- Actions -->
                  <div class="card">
                    <h2>Monitoring Actions</h2>
                    <div class="monitoring-actions">
                      <button onclick="refreshMetrics()" class="btn">Refresh Metrics</button>
                      <button onclick="runHealthCheck()" class="btn">Run Health Check</button>
                      <button onclick="exportMetrics()" class="btn">Export Metrics</button>
                      <button onclick="resetMetrics()" class="btn btn-secondary">Reset Metrics</button>
                    </div>
                  </div>
                  
                </div>
              </main>
            </div>
          </div>
          
          <style>
            .grid-3 {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
              gap: 16px;
              margin: 16px 0;
            }
            
            .grid-2 {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
              gap: 16px;
              margin: 16px 0;
            }
            
            .metric-card {
              background: #f8f9fa;
              border: 1px solid #e5e7eb;
              border-radius: 8px;
              padding: 16px;
              text-align: center;
            }
            
            .metric-value {
              font-size: 24px;
              font-weight: bold;
              color: #111827;
              margin-bottom: 4px;
            }
            
            .metric-label {
              font-size: 14px;
              color: #6b7280;
            }
            
            .health-checks {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
              gap: 12px;
            }
            
            .health-check-item {
              background: #f8f9fa;
              border: 1px solid #e5e7eb;
              border-radius: 8px;
              padding: 12px;
            }
            
            .health-check-name {
              font-weight: 600;
              color: #111827;
              margin-bottom: 4px;
            }
            
            .health-check-status {
              font-weight: 500;
              padding: 4px 8px;
              border-radius: 4px;
              display: inline-block;
              margin-bottom: 4px;
            }
            
            .health-check-status.healthy {
              background: #dcfce7;
              color: #166534;
            }
            
            .health-check-status.unhealthy {
              background: #fef2f2;
              color: #dc2626;
            }
            
            .health-check-status.warning {
              background: #fef3c7;
              color: #d97706;
            }
            
            .health-check-status.unknown {
              background: #f3f4f6;
              color: #6b7280;
            }
            
            .health-check-detail {
              font-size: 12px;
              color: #6b7280;
            }
            
            .health-check-error {
              font-size: 12px;
              color: #dc2626;
              margin-top: 4px;
            }
            
            .monitoring-actions {
              display: flex;
              gap: 12px;
              flex-wrap: wrap;
            }
            
            .btn-secondary {
              background: #6b7280;
              color: white;
            }
            
            .btn-secondary:hover {
              background: #4b5563;
            }
          </style>
          
          <script>
            function refreshMetrics() {
              window.location.reload();
            }
            
            async function runHealthCheck() {
              try {
                const response = await fetch('/health/detailed');
                const health = await response.json();
                alert('Health check completed: ' + health.status);
                window.location.reload();
              } catch (error) {
                alert('Health check failed: ' + error.message);
              }
            }
            
            function exportMetrics() {
              const metrics = ${JSON.stringify(metrics)};
              const blob = new Blob([JSON.stringify(metrics, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'metrics-' + new Date().toISOString().split('T')[0] + '.json';
              a.click();
              URL.revokeObjectURL(url);
            }
            
            async function resetMetrics() {
              if (confirm('Are you sure you want to reset all metrics? This action cannot be undone.')) {
                try {
                  const response = await fetch('/monitoring/reset', { method: 'POST' });
                  if (response.ok) {
                    alert('Metrics reset successfully');
                    window.location.reload();
                  } else {
                    alert('Failed to reset metrics');
                  }
                } catch (error) {
                  alert('Error resetting metrics: ' + error.message);
                }
              }
            }
            
            // Auto-refresh every 30 seconds
            setInterval(refreshMetrics, 30000);
          </script>
        </body></html>
      `);
      
    } catch (error) {
      logHelpers.logError(error, { component: 'monitoring_dashboard', userId });
      res.status(500).send('Error loading monitoring dashboard');
    }
  });
  
  // API endpoint for metrics
  app.get('/monitoring/metrics', ensureAuthed, (req, res) => {
    try {
      const metrics = getAllMetrics();
      res.json(metrics);
    } catch (error) {
      logHelpers.logError(error, { component: 'monitoring_api', endpoint: '/monitoring/metrics' });
      res.status(500).json({ error: 'Failed to get metrics' });
    }
  });
  
  // API endpoint to reset metrics
  app.post('/monitoring/reset', ensureAuthed, async (req, res) => {
    try {
      const { resetMetrics } = await import('../monitoring/metrics.mjs');
      resetMetrics();
      res.json({ success: true, message: 'Metrics reset successfully' });
    } catch (error) {
      logHelpers.logError(error, { component: 'monitoring_api', endpoint: '/monitoring/reset' });
      res.status(500).json({ error: 'Failed to reset metrics' });
    }
  });
}
