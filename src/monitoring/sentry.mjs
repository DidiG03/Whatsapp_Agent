/**
 * Sentry Configuration for Error Tracking
 * Provides comprehensive error monitoring and performance tracking
 */

import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

// Initialize Sentry
export function initSentry() {
  if (!process.env.SENTRY_DSN) {
    console.log('Sentry DSN not configured, skipping Sentry initialization');
    return;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    
    // Performance Monitoring
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    
    // Error Filtering
    beforeSend(event, hint) {
      // Filter out common non-critical errors
      if (event.exception) {
        const error = hint.originalException;
        if (error && error.message) {
          // Skip authentication errors (expected)
          if (error.message.includes('Authentication required') ||
              error.message.includes('Session expired')) {
            return null;
          }
          
          // Skip validation errors (expected)
          if (error.message.includes('validation') ||
              error.message.includes('invalid input')) {
            return null;
          }
        }
      }
      
      return event;
    },
    
    // Integrations
    integrations: [
      nodeProfilingIntegration(),
      new Sentry.Integrations.Http({ tracing: true }),
      new Sentry.Integrations.Express({ app: undefined }),
    ],
    
    // Release tracking
    release: process.env.SENTRY_RELEASE || 'whatsapp-agent@1.0.0',
    
    // User context
    initialScope: {
      tags: {
        component: 'whatsapp-agent',
        version: '1.0.0'
      }
    }
  });

  console.log('✅ Sentry initialized successfully');
}

// Helper functions for manual error tracking
export const sentryHelpers = {
  // Capture exceptions
  captureException: (error, context = {}) => {
    Sentry.withScope((scope) => {
      if (context.userId) scope.setUser({ id: context.userId });
      if (context.tags) Object.entries(context.tags).forEach(([key, value]) => scope.setTag(key, value));
      if (context.extra) Object.entries(context.extra).forEach(([key, value]) => scope.setExtra(key, value));
      Sentry.captureException(error);
    });
  },

  // Capture messages
  captureMessage: (message, level = 'info', context = {}) => {
    Sentry.withScope((scope) => {
      if (context.userId) scope.setUser({ id: context.userId });
      if (context.tags) Object.entries(context.tags).forEach(([key, value]) => scope.setTag(key, value));
      if (context.extra) Object.entries(context.extra).forEach(([key, value]) => scope.setExtra(key, value));
      Sentry.captureMessage(message, level);
    });
  },

  // Add breadcrumbs
  addBreadcrumb: (message, category = 'custom', level = 'info', data = {}) => {
    Sentry.addBreadcrumb({
      message,
      category,
      level,
      data,
      timestamp: Date.now() / 1000
    });
  },

  // Set user context
  setUser: (user) => {
    Sentry.setUser(user);
  },

  // Set tags
  setTag: (key, value) => {
    Sentry.setTag(key, value);
  },

  // Start transaction
  startTransaction: (name, op = 'custom') => {
    return Sentry.startTransaction({ name, op });
  }
};

export default Sentry;
