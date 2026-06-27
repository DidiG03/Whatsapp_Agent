

import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
export function initSentry() {
  if (!process.env.SENTRY_DSN) {
    console.log('Sentry DSN not configured, skipping Sentry initialization');
    return;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    beforeSend(event, hint) {
      if (event.exception) {
        const error = hint.originalException;
        if (error && error.message) {
          if (error.message.includes('Authentication required') ||
              error.message.includes('Session expired')) {
            return null;
          }
          if (error.message.includes('validation') ||
              error.message.includes('invalid input')) {
            return null;
          }
        }
      }
      
      return event;
    },
    // v8+/v10 API: integrations are factory functions, not `new Sentry.Integrations.*`
    // (which was removed and would throw on init). HTTP/Express are guarded so a
    // minor version that renames them can't crash startup.
    integrations: [
      nodeProfilingIntegration(),
      ...(typeof Sentry.httpIntegration === 'function' ? [Sentry.httpIntegration()] : []),
      ...(typeof Sentry.expressIntegration === 'function' ? [Sentry.expressIntegration()] : []),
    ].filter(Boolean),
    release: process.env.SENTRY_RELEASE || 'whatsapp-agent@1.0.0',
    initialScope: {
      tags: {
        component: 'whatsapp-agent',
        version: '1.0.0'
      }
    }
  });

  console.log('✅ Sentry initialized successfully');
}

/** Register after all routes; captures thrown errors before your errorHandler. */
export function registerSentryExpressErrorHandler(app) {
  if (!process.env.SENTRY_DSN) return;
  if (typeof Sentry.setupExpressErrorHandler === 'function') {
    Sentry.setupExpressErrorHandler(app);
  }
}
export const sentryHelpers = {
  captureException: (error, context = {}) => {
    Sentry.withScope((scope) => {
      if (context.userId) scope.setUser({ id: context.userId });
      if (context.tags) Object.entries(context.tags).forEach(([key, value]) => scope.setTag(key, value));
      if (context.extra) Object.entries(context.extra).forEach(([key, value]) => scope.setExtra(key, value));
      Sentry.captureException(error);
    });
  },
  captureMessage: (message, level = 'info', context = {}) => {
    Sentry.withScope((scope) => {
      if (context.userId) scope.setUser({ id: context.userId });
      if (context.tags) Object.entries(context.tags).forEach(([key, value]) => scope.setTag(key, value));
      if (context.extra) Object.entries(context.extra).forEach(([key, value]) => scope.setExtra(key, value));
      Sentry.captureMessage(message, level);
    });
  },
  addBreadcrumb: (message, category = 'custom', level = 'info', data = {}) => {
    Sentry.addBreadcrumb({
      message,
      category,
      level,
      data,
      timestamp: Date.now() / 1000
    });
  },
  setUser: (user) => {
    Sentry.setUser(user);
  },
  setTag: (key, value) => {
    Sentry.setTag(key, value);
  },
  // v8+/v10 replaced startTransaction() with the callback-based startSpan().
  startSpan: (name, op = 'custom', callback = () => {}) => {
    if (typeof Sentry.startSpan !== 'function') return callback();
    return Sentry.startSpan({ name, op }, callback);
  }
};

export default Sentry;
