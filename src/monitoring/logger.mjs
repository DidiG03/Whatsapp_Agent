/**
 * Structured Logging System with Correlation IDs
 * Provides comprehensive logging with request tracing and context
 */

import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';

// Create correlation ID generator
export function generateCorrelationId() {
  return uuidv4();
}

// Custom format for structured logging
const structuredFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, correlationId, userId, ...meta }) => {
    const logEntry = {
      timestamp,
      level,
      message,
      ...(correlationId && { correlationId }),
      ...(userId && { userId }),
      ...meta
    };
    return JSON.stringify(logEntry);
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: structuredFormat,
  defaultMeta: {
    service: 'whatsapp-agent',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  },
  transports: [
    // Console transport for development
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    
    // File transport for production
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ],
  
  // Handle uncaught exceptions
  exceptionHandlers: [
    new winston.transports.File({ filename: 'logs/exceptions.log' })
  ],
  
  // Handle unhandled promise rejections
  rejectionHandlers: [
    new winston.transports.File({ filename: 'logs/rejections.log' })
  ]
});

// Create request-scoped logger with correlation ID
export function createRequestLogger(correlationId, userId = null) {
  return logger.child({
    correlationId,
    userId,
    requestId: correlationId
  });
}

// Logging helpers with context
export const logHelpers = {
  // Request logging
  logRequest: (req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || generateCorrelationId();
    req.correlationId = correlationId;
    req.logger = createRequestLogger(correlationId, req.user?.id);
    
    // Log request start
    req.logger.info('Request started', {
      method: req.method,
      url: req.url,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      userId: req.user?.id
    });
    
    // Log response when finished
    res.on('finish', () => {
      req.logger.info('Request completed', {
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        responseTime: Date.now() - req.startTime,
        userId: req.user?.id
      });
    });
    
    req.startTime = Date.now();
    next();
  },

  // Error logging
  logError: (error, context = {}) => {
    logger.error('Application error', {
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name
      },
      ...context
    });
  },

  // Business logic logging
  logBusinessEvent: (event, data = {}) => {
    logger.info('Business event', {
      event,
      ...data
    });
  },

  // Performance logging
  logPerformance: (operation, duration, metadata = {}) => {
    logger.info('Performance metric', {
      operation,
      duration,
      ...metadata
    });
  },

  // Security logging
  logSecurity: (event, details = {}) => {
    logger.warn('Security event', {
      securityEvent: event,
      ...details
    });
  },

  // WhatsApp API logging
  logWhatsAppAPI: (action, data = {}) => {
    logger.info('WhatsApp API call', {
      apiAction: action,
      ...data
    });
  },

  // Database logging
  logDatabase: (operation, table, duration, metadata = {}) => {
    logger.debug('Database operation', {
      operation,
      table,
      duration,
      ...metadata
    });
  }
};

// Middleware for Express
export function loggingMiddleware() {
  return (req, res, next) => {
    logHelpers.logRequest(req, res, next);
  };
}

// Performance monitoring decorator
export function withPerformanceLogging(operationName) {
  return function(target, propertyName, descriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function(...args) {
      const startTime = Date.now();
      const correlationId = this.correlationId || generateCorrelationId();
      const logger = createRequestLogger(correlationId);
      
      try {
        logger.info(`Starting ${operationName}`);
        const result = await originalMethod.apply(this, args);
        const duration = Date.now() - startTime;
        
        logger.info(`Completed ${operationName}`, {
          duration,
          success: true
        });
        
        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        
        logger.error(`Failed ${operationName}`, {
          duration,
          error: error.message,
          success: false
        });
        
        throw error;
      }
    };
    
    return descriptor;
  };
}

export default logger;
