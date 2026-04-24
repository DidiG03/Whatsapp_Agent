

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
    integrations: [
      nodeProfilingIntegration(),
      new Sentry.Integrations.Http({ tracing: true }),
      new Sentry.Integrations.Express({ app: undefined }),
    ],
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
  startTransaction: (name, op = 'custom') => {
    return Sentry.startTransaction({ name, op });
  }
};

export default Sentry;
