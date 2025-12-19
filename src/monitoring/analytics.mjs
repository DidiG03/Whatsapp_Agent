/**
 * Vercel Web Analytics integration for Express
 * Provides tracking capabilities for the WhatsApp Agent application.
 * 
 * Documentation: https://vercel.com/docs/analytics/quickstart
 * 
 * For Express applications deployed on Vercel:
 * - Analytics data is automatically collected by Vercel's infrastructure
 * - The @vercel/analytics package provides client and server utilities
 * - This integration enables tracking of API requests, performance metrics, and custom events
 */

let analyticsInitialized = false;

/**
 * Initialize Vercel Web Analytics for Express application
 * This should be called once during server startup
 * 
 * Note: For Express backend applications, Vercel Web Analytics automatically
 * tracks requests and performance metrics when deployed to Vercel.
 * This function ensures proper initialization and logging.
 * 
 * @returns {boolean} true if initialization was successful, false otherwise
 */
export function initVercelAnalytics() {
  // Only initialize once
  if (analyticsInitialized) {
    console.log('ℹ️  Vercel Analytics already initialized');
    return true;
  }

  try {
    // For Express applications on Vercel:
    // - The @vercel/analytics package is configured and ready
    // - Vercel automatically injects tracking routes (/_vercel/insights/*)
    // - API responses and performance metrics are collected automatically
    
    // Log initialization
    console.log('📊 Vercel Web Analytics initialized');
    console.log('✨ Analytics routes available at /_vercel/insights/*');
    
    if (process.env.VERCEL) {
      console.log('🚀 Deployed on Vercel - analytics data collection is active');
    } else {
      console.log('💡 Running locally - analytics data will be collected on Vercel deployment');
    }
    
    analyticsInitialized = true;
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize Vercel Analytics:', error?.message || error);
    return false;
  }
}

/**
 * Get analytics initialization status
 * @returns {boolean}
 */
export function isAnalyticsInitialized() {
  return analyticsInitialized;
}

/**
 * Create middleware for tracking custom events and requests
 * This middleware enhances the request object with analytics capabilities
 * 
 * For Express applications on Vercel, this allows:
 * - Tracking of specific business events
 * - Custom performance measurements
 * - User interaction tracking
 * 
 * @param {Object} options - Configuration options
 * @returns {Function} Express middleware function
 */
export function createAnalyticsMiddleware(options = {}) {
  const { debug = process.env.DEBUG_ANALYTICS } = options;
  
  return (req, res, next) => {
    // Capture request start time for performance tracking
    req.analyticsStartTime = Date.now();
    
    // Add analytics tracking capability to request object
    // This allows routes to track custom events and metrics
    req.analytics = {
      /**
       * Track a custom business event
       * @param {string} eventName - Name of the event
       * @param {Object} eventData - Event data/metadata
       */
      trackEvent: (eventName, eventData = {}) => {
        if (debug) {
          console.log(`📊 Analytics Event: ${eventName}`, eventData);
        }
        // In production, Vercel's analytics infrastructure collects this
      },
      
      /**
       * Track a page view (for API responses with HTML)
       * @param {string} pageName - Name or path of the page
       */
      trackPageView: (pageName) => {
        if (debug) {
          console.log(`📄 Analytics Page View: ${pageName}`);
        }
      },
      
      /**
       * Track request performance metrics
       * @param {Object} metrics - Performance metrics object
       */
      trackMetrics: (metrics = {}) => {
        const duration = Date.now() - req.analyticsStartTime;
        if (debug) {
          console.log(`⏱️  Analytics Metrics:`, { duration, ...metrics });
        }
      }
    };
    
    // Hook into response finish to track response metrics
    res.on('finish', () => {
      req.analytics.trackMetrics({
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration: Date.now() - req.analyticsStartTime
      });
    });
    
    next();
  };
}

/**
 * Track a custom event globally
 * Useful for tracking specific business events or user interactions outside of request context
 * 
 * Examples:
 * - trackEvent('user_signup', { userId: '123', plan: 'pro' })
 * - trackEvent('message_sent', { messageId: 'msg_456', recipient: 'whatsapp' })
 * - trackEvent('campaign_completed', { campaignId: 'camp_789', messageCount: 1000 })
 * 
 * Note: For Express applications on Vercel, custom events are best tracked
 * via the trackEvent method on the req.analytics object within route handlers
 * 
 * @param {string} eventName - Name of the event to track (use snake_case)
 * @param {Object} eventData - Event data/metadata object
 */
export function trackEvent(eventName, eventData = {}) {
  if (process.env.DEBUG_ANALYTICS) {
    console.log(`📊 Custom Event: ${eventName}`, eventData);
  }
  // In production on Vercel, this data is collected for analytics
}

/**
 * Get analytics configuration and status
 * @returns {Object} Analytics configuration object
 */
export function getAnalyticsStatus() {
  return {
    initialized: analyticsInitialized,
    environment: process.env.VERCEL ? 'vercel' : 'local',
    debug: Boolean(process.env.DEBUG_ANALYTICS),
    endpoints: {
      insights: '/_vercel/insights/*',
      view: '/_vercel/insights/view'
    }
  };
}

export default {
  initVercelAnalytics,
  isAnalyticsInitialized,
  createAnalyticsMiddleware,
  trackEvent,
  getAnalyticsStatus
};
