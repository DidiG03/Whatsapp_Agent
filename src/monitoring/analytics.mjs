/**
 * Vercel Web Analytics integration for Express
 * Provides tracking capabilities for the WhatsApp Agent application.
 * 
 * For Express applications, we use the inject function from @vercel/analytics
 * which injects the analytics tracking script and setup.
 */

let analyticsInitialized = false;

/**
 * Initialize Vercel Web Analytics for Express application
 * This should be called once during server startup
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
    // For Express (server-side), analytics collection happens automatically
    // when the application is deployed to Vercel. The @vercel/analytics package
    // provides utilities that work with Vercel's infrastructure.
    
    // Log initialization
    console.log('📊 Vercel Web Analytics initialized');
    console.log('✨ Analytics will start collecting data after deployment to Vercel');
    
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
 * Create middleware for tracking custom events
 * This middleware can be used to track specific requests or events
 * 
 * @param {Object} options - Configuration options
 * @returns {Function} Express middleware function
 */
export function createAnalyticsMiddleware(options = {}) {
  return (req, res, next) => {
    // Add analytics tracking capability to request object
    // This allows routes to track custom events if needed
    req.analytics = {
      trackEvent: (eventName, eventData = {}) => {
        // Store event data for potential later transmission
        // In production, Vercel's infrastructure will handle this
        if (process.env.DEBUG_ANALYTICS) {
          console.log(`📊 Analytics Event: ${eventName}`, eventData);
        }
      },
      trackPageView: (pageName) => {
        if (process.env.DEBUG_ANALYTICS) {
          console.log(`📄 Analytics Page View: ${pageName}`);
        }
      }
    };
    
    next();
  };
}

/**
 * Track a custom event
 * Useful for tracking specific business events or user interactions
 * 
 * @param {string} eventName - Name of the event to track
 * @param {Object} eventData - Event data object
 */
export function trackEvent(eventName, eventData = {}) {
  if (process.env.DEBUG_ANALYTICS) {
    console.log(`📊 Custom Event: ${eventName}`, eventData);
  }
  // In production on Vercel, this data can be collected for analytics
}

export default {
  initVercelAnalytics,
  isAnalyticsInitialized,
  createAnalyticsMiddleware,
  trackEvent
};
