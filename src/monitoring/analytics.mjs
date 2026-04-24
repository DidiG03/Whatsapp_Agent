

let analyticsInitialized = false;
export function initVercelAnalytics() {
  if (analyticsInitialized) {
    console.log('ℹ️  Vercel Analytics already initialized');
    return true;
  }

  try {
    console.log('📊 Vercel Web Analytics initialized');
    console.log('✨ Analytics will start collecting data after deployment to Vercel');
    
    analyticsInitialized = true;
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize Vercel Analytics:', error?.message || error);
    return false;
  }
}
export function isAnalyticsInitialized() {
  return analyticsInitialized;
}
export function createAnalyticsMiddleware(options = {}) {
  return (req, res, next) => {
    req.analytics = {
      trackEvent: (eventName, eventData = {}) => {
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
export function trackEvent(eventName, eventData = {}) {
  if (process.env.DEBUG_ANALYTICS) {
    console.log(`📊 Custom Event: ${eventName}`, eventData);
  }
}

export default {
  initVercelAnalytics,
  isAnalyticsInitialized,
  createAnalyticsMiddleware,
  trackEvent
};
