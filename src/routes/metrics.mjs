/**
 * Dashboard Metrics API
 * Provides customizable metrics for the main dashboard
 */

import { ensureAuthed, getCurrentUserId } from '../middleware/auth.mjs';
import { db } from '../db-mongodb.mjs';
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
import { Message, AIRequest, Handoff, UserSettings } from '../schemas/mongodb.mjs';

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
    
    // NOTE: messages.timestamp is stored in SECONDS. Use seconds for comparisons.
    const nowSec = Math.floor(now.getTime() / 1000);
    const todaySec = Math.floor(today.getTime() / 1000);
    const yesterdaySec = Math.floor(yesterday.getTime() / 1000);
    
    try {
      // Get message counts for today and yesterday using MongoDB aggregation
      const todayMessages = await Message.aggregate([
        {
          $match: {
            user_id: userId,
            timestamp: { $gte: todaySec }
          }
        },
        {
          $group: {
            _id: null,
            sent_today: {
              $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] }
            },
            received_today: {
              $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] }
            }
          }
        }
      ]);
      
      const yesterdayMessages = await Message.aggregate([
        {
          $match: {
            user_id: userId,
            timestamp: { $gte: yesterdaySec, $lt: todaySec }
          }
        },
        {
          $group: {
            _id: null,
            sent_yesterday: {
              $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] }
            },
            received_yesterday: {
              $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] }
            }
          }
        }
      ]);
      
      // Get active conversations
      const activeConversations = await Message.aggregate([
        {
          $match: {
            user_id: userId,
            timestamp: { $gte: nowSec - 24 * 60 * 60 }
          }
        },
        {
          $group: {
            _id: '$from_digits'
          }
        },
        {
          $count: 'active_count'
        }
      ]);
      
      // Get response time data using window functions (MongoDB 5.0+)
      const responseTimeData = await Message.aggregate([
        {
          $match: {
            user_id: userId,
            timestamp: { $gte: nowSec - 7 * 24 * 60 * 60 }
          }
        },
        { $sort: { from_digits: 1, timestamp: 1 } },
        {
          $setWindowFields: {
            partitionBy: '$from_digits',
            sortBy: { timestamp: 1 },
            output: {
              prevDirection: { $shift: { output: '$direction', by: 1 } },
              prevTimestamp: { $shift: { output: '$timestamp', by: 1 } }
            }
          }
        },
        {
          $match: {
            direction: 'outbound',
            prevDirection: 'inbound'
          }
        },
        {
          $project: {
            responseTime: { $subtract: ['$timestamp', '$prevTimestamp'] }
          }
        },
        {
          $group: { _id: null, avg_response_time: { $avg: '$responseTime' } }
        }
      ]);
      
      // Get AI performance data
      let aiRequests = { total_requests: 0, successful_requests: 0, avg_response_time: 0 };
      try {
        const aiStats = await AIRequest.aggregate([
          {
            $match: {
              user_id: userId,
              createdAt: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) }
            }
          },
          {
            $group: {
              _id: null,
              total_requests: { $sum: 1 },
              successful_requests: {
                $sum: { $cond: [{ $eq: ['$success', true] }, 1, 0] }
              },
              avg_response_time: { $avg: '$response_time' }
            }
          }
        ]);
        
        if (aiStats.length > 0) {
          aiRequests = aiStats[0];
        }
      } catch (error) {
        console.log('AI requests query failed:', error.message);
      }
      
      // Get template usage
      let templateUsage = { template_messages_today: 0, template_messages_yesterday: 0 };
      try {
        const templateStats = await Message.aggregate([
          {
            $match: {
              user_id: userId,
              type: 'template',
              timestamp: { $gte: yesterdaySec }
            }
          },
          {
            $group: {
              _id: null,
              template_messages_today: {
                $sum: { $cond: [{ $gte: ['$timestamp', todaySec] }, 1, 0] }
              },
              template_messages_yesterday: {
                $sum: { $cond: [{ $lt: ['$timestamp', todaySec] }, 1, 0] }
              }
            }
          }
        ]);
        
        if (templateStats.length > 0) {
          templateUsage = templateStats[0];
        }
      } catch (error) {
        console.log('Template usage query failed:', error.message);
      }
      
      // Get ticket metrics
      const ticketStats = await getConversationStatusStats(userId);
      
      // Get tickets created today and yesterday
      const ticketsCreatedToday = await Handoff.countDocuments({
        user_id: userId,
        updatedAt: { $gte: today },
        conversation_status: CONVERSATION_STATUSES.NEW
      });
      
      const ticketsCreatedYesterday = await Handoff.countDocuments({
        user_id: userId,
        updatedAt: { $gte: yesterday, $lt: today },
        conversation_status: CONVERSATION_STATUSES.NEW
      });
      
      // Get tickets resolved today and yesterday
      const ticketsResolvedToday = await Handoff.countDocuments({
        user_id: userId,
        updatedAt: { $gte: today },
        conversation_status: CONVERSATION_STATUSES.RESOLVED
      });
      
      const ticketsResolvedYesterday = await Handoff.countDocuments({
        user_id: userId,
        updatedAt: { $gte: yesterday, $lt: today },
        conversation_status: CONVERSATION_STATUSES.RESOLVED
      });
      
      // Get escalation metrics
      const escalationStats = await Handoff.aggregate([
        {
          $match: {
            user_id: userId,
            escalation_reason: { $exists: true, $ne: null }
          }
        },
        {
          $group: {
            _id: null,
            total_escalations: { $sum: 1 },
            escalations_today: {
              $sum: { $cond: [{ $gte: ['$updatedAt', today] }, 1, 0] }
            }
          }
        }
      ]);
      
      // Get average resolution time
      const resolutionTimeData = await Handoff.aggregate([
        {
          $match: {
            user_id: userId,
            conversation_status: CONVERSATION_STATUSES.RESOLVED
          }
        },
        {
          $group: {
            _id: '$contact_id',
            created_at: { $min: '$createdAt' },
            resolved_at: { $max: '$updatedAt' }
          }
        },
        {
          $addFields: {
            resolution_time: { $subtract: ['$resolved_at', '$created_at'] }
          }
        },
        {
          $group: {
            _id: null,
            avg_resolution_time: { $avg: '$resolution_time' }
          }
        }
      ]);
      
      // Extract data from aggregation results
      const todayMsgData = todayMessages[0] || { sent_today: 0, received_today: 0 };
      const yesterdayMsgData = yesterdayMessages[0] || { sent_yesterday: 0, received_yesterday: 0 };
      const activeConvData = activeConversations[0] || { active_count: 0 };
      const responseTimeDataResult = responseTimeData[0] || { avg_response_time: 0 };
      const escalationStatsResult = escalationStats[0] || { total_escalations: 0, escalations_today: 0 };
      const resolutionTimeDataResult = resolutionTimeData[0] || { avg_resolution_time: 0 };
      
      // Calculate trends
      const sentTrend = calculateTrend(todayMsgData.sent_today || 0, yesterdayMsgData.sent_yesterday || 0);
      const receivedTrend = calculateTrend(todayMsgData.received_today || 0, yesterdayMsgData.received_yesterday || 0);
      const ticketsCreatedTrend = calculateTrend(ticketsCreatedToday || 0, ticketsCreatedYesterday || 0);
      const ticketsResolvedTrend = calculateTrend(ticketsResolvedToday || 0, ticketsResolvedYesterday || 0);
    
      return {
        messages: {
          sent_today: todayMsgData.sent_today || 0,
          received_today: todayMsgData.received_today || 0,
          sent_yesterday: yesterdayMsgData.sent_yesterday || 0,
          received_yesterday: yesterdayMsgData.received_yesterday || 0,
          sent_trend: sentTrend,
          received_trend: receivedTrend
        },
        conversations: {
          active: activeConvData.active_count || 0
        },
        performance: {
          avg_response_time: Math.round(responseTimeDataResult.avg_response_time || 0),
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
          created_today: ticketsCreatedToday || 0,
          created_yesterday: ticketsCreatedYesterday || 0,
          created_trend: ticketsCreatedTrend,
          resolved_today: ticketsResolvedToday || 0,
          resolved_yesterday: ticketsResolvedYesterday || 0,
          resolved_trend: ticketsResolvedTrend,
          total_escalations: escalationStatsResult.total_escalations || 0,
          escalations_today: escalationStatsResult.escalations_today || 0,
          avg_resolution_time: Math.round(resolutionTimeDataResult.avg_resolution_time || 0),
          resolution_rate: ticketStats.resolved > 0 ? Math.round((ticketStats.resolved / (ticketStats.new + ticketStats.in_progress + ticketStats.resolved)) * 100) : 0
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logHelpers.logError(error, { component: 'dashboard_metrics', userId });
      // Return default values in case of error
      return {
        messages: { sent_today: 0, received_today: 0, sent_yesterday: 0, received_yesterday: 0, sent_trend: 0, received_trend: 0 },
        conversations: { active: 0 },
        performance: { avg_response_time: 0, ai_success_rate: 0, ai_avg_response_time: 0 },
        templates: { used_today: 0, used_yesterday: 0 },
        system: { uptime: Math.floor(process.uptime()), memory_usage: 0, error_rate: 0 },
        tickets: { status_counts: {}, created_today: 0, created_yesterday: 0, created_trend: 0, resolved_today: 0, resolved_yesterday: 0, resolved_trend: 0, total_escalations: 0, escalations_today: 0, avg_resolution_time: 0, resolution_rate: 0 },
        timestamp: new Date().toISOString()
      };
    }
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
      const todaySec = Math.floor(today.getTime() / 1000);
      
      const hourlyData = await Message.aggregate([
        {
          $match: {
            user_id: userId,
            timestamp: { $gte: todaySec }
          }
        },
        {
          $addFields: {
            hour: {
              $substr: [
                { $dateToString: { date: { $toDate: { $multiply: ['$timestamp', 1000] } }, format: '%H' } },
                0,
                2
              ]
            }
          }
        },
        {
          $group: {
            _id: '$hour',
            received: {
              $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] }
            },
            sent: {
              $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] }
            }
          }
        },
        {
          $sort: { _id: 1 }
        }
      ]);
      
      // Format hourly data for chart
      const hourlyChartData = Array.from({ length: 24 }, (_, i) => {
        const hour = String(i).padStart(2, '0');
        const hourData = hourlyData.find(h => h._id === hour);
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
      const preferences = await UserSettings.findOne({ user_id: userId });
      
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
      await UserSettings.findOneAndUpdate(
        { user_id: userId },
        { 
          user_id: userId, 
          dashboard_preferences: JSON.stringify(preferences) 
        },
        { upsert: true, new: true }
      );
      
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
      const startSec = Math.floor(startDate.getTime() / 1000);
      
      const exportData = {
        user_id: userId,
        export_date: new Date().toISOString(),
        period_days: days,
        messages: await Message.find({
          user_id: userId,
          timestamp: { $gte: startSec }
        }).select('timestamp direction type text_body from_digits delivery_status').sort({ timestamp: -1 }),
        ai_requests: await AIRequest.find({
          user_id: userId,
          createdAt: { $gte: startDate }
        }).select('createdAt success response_time model tokens_used').sort({ createdAt: -1 }),
        conversations: await Message.aggregate([
          {
            $match: {
              user_id: userId,
              timestamp: { $gte: startSec }
            }
          },
          {
            $group: {
              _id: '$from_digits',
              message_count: { $sum: 1 },
              first_message: { $min: '$timestamp' },
              last_message: { $max: '$timestamp' }
            }
          },
          {
            $sort: { last_message: -1 }
          }
        ])
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
      new Date((msg.timestamp || 0) * 1000).toISOString(),
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
      new Date(req.createdAt).toISOString(),
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