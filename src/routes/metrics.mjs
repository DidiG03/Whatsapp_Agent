/**
 * Dashboard Metrics API
 * Provides customizable metrics for the main dashboard
 */

import { ensureAuthed, getCurrentUserId } from '../middleware/auth.mjs';
import { db } from '../db-serverless.mjs';
import { getAllMetrics } from '../monitoring/metrics.mjs';
import { logHelpers } from '../monitoring/logger.mjs';
import { broadcastMetricsUpdate } from './realtime.mjs';
import { 
  getConversationStatusStats, 
  getConversationsByStatus,
  CONVERSATION_STATUSES,
  STATUS_DISPLAY_NAMES,
  STATUS_COLORS
} from '../services/conversationStatus.mjs';

export default function registerMetricsRoutes(app) {
  
  // Store active dashboard users for real-time updates
  const activeDashboardUsers = new Set();
  
  // Periodic metrics broadcasting (every 30 seconds)
  setInterval(async () => {
    if (activeDashboardUsers.size === 0) return;
    
    try {
      // Get fresh metrics for all active users
      for (const userId of activeDashboardUsers) {
        const metrics = await getDashboardMetricsForUser(userId);
        broadcastMetricsUpdate(userId, metrics);
      }
    } catch (error) {
      console.error('Error in periodic metrics broadcast:', error);
    }
  }, 30000);
  
  // Helper function to get dashboard metrics for a specific user
  async function getDashboardMetricsForUser(userId) {
    const metrics = getAllMetrics();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    
    // Convert timestamps to seconds for SQLite
    const todayTs = Math.floor(today.getTime() / 1000);
    const yesterdayTs = Math.floor(yesterday.getTime() / 1000);
    
    // Get message counts for today and yesterday
    const todayMessages = db.prepare(`
      SELECT 
        COUNT(CASE WHEN direction = 'outbound' THEN 1 END) as sent_today,
        COUNT(CASE WHEN direction = 'inbound' THEN 1 END) as received_today
      FROM messages 
      WHERE user_id = ? AND timestamp >= ?
    `).get(userId, todayTs);
    
    const yesterdayMessages = db.prepare(`
      SELECT 
        COUNT(CASE WHEN direction = 'outbound' THEN 1 END) as sent_yesterday,
        COUNT(CASE WHEN direction = 'inbound' THEN 1 END) as received_yesterday
      FROM messages 
      WHERE user_id = ? AND timestamp >= ? AND timestamp < ?
    `).get(userId, yesterdayTs, todayTs);
    
    // Get active conversations
    const activeConversations = db.prepare(`
      SELECT COUNT(DISTINCT from_digits) as active_count
      FROM messages 
      WHERE user_id = ? AND timestamp >= ?
    `).get(userId, Math.floor((now.getTime() - 24 * 60 * 60 * 1000) / 1000));
    
    // Get response time data
    const responseTimeData = db.prepare(`
      SELECT 
        AVG(CASE 
          WHEN direction = 'outbound' AND prev_direction = 'inbound' 
          THEN timestamp - prev_timestamp 
          ELSE NULL 
        END) as avg_response_time
      FROM (
        SELECT 
          timestamp, 
          direction,
          from_digits,
          LAG(timestamp) OVER (PARTITION BY from_digits ORDER BY timestamp) as prev_timestamp,
          LAG(direction) OVER (PARTITION BY from_digits ORDER BY timestamp) as prev_direction
        FROM messages 
        WHERE user_id = ? AND timestamp >= ?
      )
    `).get(userId, Math.floor((now.getTime() - 7 * 24 * 60 * 60 * 1000) / 1000));
    
    // Get AI performance data (handle case where table might be empty)
    let aiRequests = { total_requests: 0, successful_requests: 0, avg_response_time: 0 };
    try {
      aiRequests = db.prepare(`
        SELECT 
          COUNT(*) as total_requests,
          COUNT(CASE WHEN success = 1 THEN 1 END) as successful_requests,
          AVG(response_time) as avg_response_time
        FROM ai_requests 
        WHERE user_id = ? AND created_at >= ?
      `).get(userId, Math.floor((now.getTime() - 24 * 60 * 60 * 1000) / 1000)) || aiRequests;
    } catch (error) {
      console.log('AI requests table not available or empty:', error.message);
    }
    
    // Get template usage (using type column instead of message_type)
    let templateUsage = { template_messages_today: 0, template_messages_yesterday: 0 };
    try {
      templateUsage = db.prepare(`
        SELECT 
          COUNT(*) as template_messages_today,
          COUNT(CASE WHEN timestamp >= ? THEN 1 END) as template_messages_yesterday
        FROM messages 
        WHERE user_id = ? AND type = 'template' AND timestamp >= ?
      `).get(userId, yesterdayTs, userId, yesterdayTs) || templateUsage;
    } catch (error) {
      console.log('Template usage query failed:', error.message);
    }
    
    // Get ticket metrics
    const ticketStats = getConversationStatusStats(userId);
    
    // Get tickets created today and yesterday
    const ticketsCreatedToday = db.prepare(`
      SELECT COUNT(*) as count
      FROM handoff 
      WHERE user_id = ? AND updated_at >= ? AND conversation_status = ?
    `).get(userId, todayTs, CONVERSATION_STATUSES.NEW);
    
    const ticketsCreatedYesterday = db.prepare(`
      SELECT COUNT(*) as count
      FROM handoff 
      WHERE user_id = ? AND updated_at >= ? AND updated_at < ? AND conversation_status = ?
    `).get(userId, yesterdayTs, todayTs, CONVERSATION_STATUSES.NEW);
    
    // Get tickets resolved today and yesterday
    const ticketsResolvedToday = db.prepare(`
      SELECT COUNT(*) as count
      FROM handoff 
      WHERE user_id = ? AND updated_at >= ? AND conversation_status = ?
    `).get(userId, todayTs, CONVERSATION_STATUSES.RESOLVED);
    
    const ticketsResolvedYesterday = db.prepare(`
      SELECT COUNT(*) as count
      FROM handoff 
      WHERE user_id = ? AND updated_at >= ? AND updated_at < ? AND conversation_status = ?
    `).get(userId, yesterdayTs, todayTs, CONVERSATION_STATUSES.RESOLVED);
    
    // Get escalation metrics
    const escalationStats = db.prepare(`
      SELECT 
        COUNT(*) as total_escalations,
        COUNT(CASE WHEN updated_at >= ? THEN 1 END) as escalations_today
      FROM handoff 
      WHERE user_id = ? AND escalation_reason IS NOT NULL
    `).get(userId, todayTs);
    
    // Get average resolution time (for resolved tickets)
    const resolutionTimeData = db.prepare(`
      SELECT 
        AVG(resolution_time) as avg_resolution_time
      FROM (
        SELECT 
          h1.contact_id,
          (h2.updated_at - h1.updated_at) as resolution_time
        FROM handoff h1
        JOIN handoff h2 ON h1.contact_id = h2.contact_id AND h1.user_id = h2.user_id
        WHERE h1.user_id = ? 
          AND h1.conversation_status = ?
          AND h2.conversation_status = ?
          AND h2.updated_at > h1.updated_at
      )
    `).get(userId, CONVERSATION_STATUSES.NEW, CONVERSATION_STATUSES.RESOLVED);
    
    // Calculate trends
    const sentTrend = calculateTrend(todayMessages.sent_today || 0, yesterdayMessages.sent_yesterday || 0);
    const receivedTrend = calculateTrend(todayMessages.received_today || 0, yesterdayMessages.received_yesterday || 0);
    const ticketsCreatedTrend = calculateTrend(ticketsCreatedToday.count || 0, ticketsCreatedYesterday.count || 0);
    const ticketsResolvedTrend = calculateTrend(ticketsResolvedToday.count || 0, ticketsResolvedYesterday.count || 0);
    
    return {
      messages: {
        sent_today: todayMessages.sent_today || 0,
        received_today: todayMessages.received_today || 0,
        sent_yesterday: yesterdayMessages.sent_yesterday || 0,
        received_yesterday: yesterdayMessages.received_yesterday || 0,
        sent_trend: sentTrend,
        received_trend: receivedTrend
      },
      conversations: {
        active: activeConversations.active_count || 0
      },
      performance: {
        avg_response_time: Math.round(responseTimeData.avg_response_time || 0),
        ai_success_rate: aiRequests.total_requests > 0 
          ? Math.round((aiRequests.successful_requests / aiRequests.total_requests) * 100)
          : 0,
        ai_avg_response_time: Math.round(aiRequests.avg_response_time || 0)
      },
      templates: {
        used_today: templateUsage.template_messages_today || 0,
        used_yesterday: templateUsage.template_messages_yesterday || 0
      },
      system: {
        uptime: Math.floor(process.uptime()),
        memory_usage: metrics.gauges.memory_usage_mb || 0,
        error_rate: calculateErrorRate(metrics)
      },
      tickets: {
        status_counts: ticketStats,
        created_today: ticketsCreatedToday.count || 0,
        created_yesterday: ticketsCreatedYesterday.count || 0,
        created_trend: ticketsCreatedTrend,
        resolved_today: ticketsResolvedToday.count || 0,
        resolved_yesterday: ticketsResolvedYesterday.count || 0,
        resolved_trend: ticketsResolvedTrend,
        total_escalations: escalationStats.total_escalations || 0,
        escalations_today: escalationStats.escalations_today || 0,
        avg_resolution_time: Math.round(resolutionTimeData.avg_resolution_time || 0),
        resolution_rate: ticketStats.resolved > 0 ? Math.round((ticketStats.resolved / (ticketStats.new + ticketStats.in_progress + ticketStats.resolved)) * 100) : 0
      },
      timestamp: new Date().toISOString()
    };
  }
  
  // Get dashboard metrics for current user
  app.get('/api/metrics/dashboard', ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    
    try {
      // Add user to active dashboard users for real-time updates
      activeDashboardUsers.add(userId);
      
      // Get dashboard metrics using helper function
      const dashboardMetrics = await getDashboardMetricsForUser(userId);
      
      // Add hourly chart data
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const todayTs = Math.floor(today.getTime() / 1000);
      
      const hourlyData = db.prepare(`
        SELECT 
          strftime('%H', datetime(timestamp, 'unixepoch')) as hour,
          COUNT(CASE WHEN direction = 'inbound' THEN 1 END) as received,
          COUNT(CASE WHEN direction = 'outbound' THEN 1 END) as sent
        FROM messages 
        WHERE user_id = ? AND timestamp >= ?
        GROUP BY hour
        ORDER BY hour
      `).all(userId, todayTs);
      
      // Format hourly data for chart
      const hourlyChartData = Array.from({ length: 24 }, (_, i) => {
        const hour = String(i).padStart(2, '0');
        const hourData = hourlyData.find(h => h.hour === hour);
        return {
          hour: `${hour}:00`,
          received: hourData?.received || 0,
          sent: hourData?.sent || 0
        };
      });
      
      dashboardMetrics.charts = {
        hourly_messages: hourlyChartData
      };
      
      res.json(dashboardMetrics);
      
    } catch (error) {
      logHelpers.logError(error, { component: 'dashboard_metrics', userId });
      res.status(500).json({ error: 'Failed to get dashboard metrics' });
    }
  });
  
  // Get user's dashboard preferences
  app.get('/api/metrics/preferences', ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    
    try {
      const preferences = db.prepare(`
        SELECT dashboard_preferences FROM user_settings WHERE user_id = ?
      `).get(userId);
      
      const defaultPreferences = {
        visibleMetrics: [
          'messages_sent_today',
          'messages_received_today', 
          'active_conversations',
          'response_time',
          'tickets_new',
          'tickets_in_progress',
          'tickets_resolved',
          'tickets_created_today'
        ],
        refreshInterval: 30, // seconds
        chartType: 'line',
        theme: 'light'
      };
      
      const userPreferences = preferences?.dashboard_preferences 
        ? JSON.parse(preferences.dashboard_preferences)
        : defaultPreferences;
      
      res.json(userPreferences);
      
    } catch (error) {
      logHelpers.logError(error, { component: 'dashboard_preferences', userId });
      res.status(500).json({ error: 'Failed to get preferences' });
    }
  });
  
  // Save user's dashboard preferences
  app.post('/api/metrics/preferences', ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const preferences = req.body;
    
    try {
      // Validate preferences
      const validMetrics = [
        'messages_sent_today', 'messages_received_today', 'messages_trend',
        'active_conversations', 'response_time', 'ai_success_rate',
        'template_usage', 'system_health', 'hourly_chart',
        'tickets_new', 'tickets_in_progress', 'tickets_resolved',
        'tickets_created_today', 'tickets_resolved_today', 'ticket_resolution_time', 'escalation_rate'
      ];
      
      if (preferences.visibleMetrics) {
        preferences.visibleMetrics = preferences.visibleMetrics.filter(m => validMetrics.includes(m));
      }
      
      if (preferences.refreshInterval) {
        preferences.refreshInterval = Math.max(10, Math.min(300, preferences.refreshInterval));
      }
      
      // Save to database
      db.prepare(`
        INSERT OR REPLACE INTO user_settings (user_id, dashboard_preferences, updated_at)
        VALUES (?, ?, ?)
      `).run(userId, JSON.stringify(preferences), Math.floor(Date.now() / 1000));
      
      res.json({ success: true, preferences });
      
    } catch (error) {
      logHelpers.logError(error, { component: 'dashboard_preferences_save', userId });
      res.status(500).json({ error: 'Failed to save preferences' });
    }
  });
  
  // Export metrics data
  app.get('/api/metrics/export', ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const format = req.query.format || 'json';
    const days = parseInt(req.query.days) || 7;
    
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const startTs = Math.floor(startDate.getTime() / 1000);
      
      const exportData = {
        user_id: userId,
        export_date: new Date().toISOString(),
        period_days: days,
        messages: db.prepare(`
          SELECT 
            timestamp,
            direction,
            type,
            text_body,
            from_digits,
            delivery_status
          FROM messages 
          WHERE user_id = ? AND timestamp >= ?
          ORDER BY timestamp DESC
        `).all(userId, startTs),
        ai_requests: db.prepare(`
          SELECT 
            created_at,
            success,
            response_time,
            model,
            tokens_used
          FROM ai_requests 
          WHERE user_id = ? AND created_at >= ?
          ORDER BY created_at DESC
        `).all(userId, startTs),
        conversations: db.prepare(`
          SELECT 
            from_digits,
            COUNT(*) as message_count,
            MIN(timestamp) as first_message,
            MAX(timestamp) as last_message
          FROM messages 
          WHERE user_id = ? AND timestamp >= ?
          GROUP BY from_digits
          ORDER BY last_message DESC
        `).all(userId, startTs)
      };
      
      if (format === 'csv') {
        // Convert to CSV format
        const csv = convertToCSV(exportData);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="metrics-export-${new Date().toISOString().split('T')[0]}.csv"`);
        res.send(csv);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="metrics-export-${new Date().toISOString().split('T')[0]}.json"`);
        res.json(exportData);
      }
      
    } catch (error) {
      logHelpers.logError(error, { component: 'metrics_export', userId });
      res.status(500).json({ error: 'Failed to export metrics' });
    }
  });
  
  // Cleanup inactive users periodically
  setInterval(() => {
    // Remove users who haven't accessed dashboard in last 5 minutes
    // This is a simple cleanup - in production you'd want more sophisticated tracking
    if (activeDashboardUsers.size > 100) {
      activeDashboardUsers.clear();
    }
  }, 5 * 60 * 1000); // 5 minutes
}

// Helper functions
function calculateTrend(current, previous) {
  if (previous === 0) {
    return current > 0 ? 100 : 0;
  }
  return Math.round(((current - previous) / previous) * 100);
}

function calculateErrorRate(metrics) {
  const totalRequests = metrics.counters['http_requests_total'] || 0;
  const totalErrors = metrics.counters['errors_total'] || 0;
  
  if (totalRequests === 0) return 0;
  return Math.round((totalErrors / totalRequests) * 100);
}

function convertToCSV(data) {
  const headers = [
    'Date', 'Type', 'Direction', 'Content', 'Contact', 'Success', 'Response Time'
  ];
  
  const rows = [];
  
  // Add messages
  data.messages.forEach(msg => {
    rows.push([
      new Date(msg.timestamp * 1000).toISOString(),
      'message',
      msg.direction,
      `"${(msg.text_body || '').replace(/"/g, '""')}"`,
      msg.from_digits,
      msg.delivery_status === 'delivered' ? 'Yes' : 'No',
      ''
    ]);
  });
  
  // Add AI requests
  data.ai_requests.forEach(req => {
    rows.push([
      new Date(req.created_at * 1000).toISOString(),
      'ai_request',
      '',
      '',
      '',
      req.success ? 'Yes' : 'No',
      req.response_time
    ]);
  });
  
  return [headers, ...rows].map(row => row.join(',')).join('\n');
}