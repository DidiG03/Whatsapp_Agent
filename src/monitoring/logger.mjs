

import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';
export function generateCorrelationId() {
  return uuidv4();
}
function maskPhone(value) {
  try {
    const d = String(value||'').replace(/\D/g,'');
    if (d.length <= 4) return '***';
    return d.slice(0,2) + '******' + d.slice(-2);
  } catch { return '***'; }
}

function scrubPII(obj) {
  if (process.env.DEBUG_LOGS === '1') return obj;  try {
    const json = JSON.stringify(obj);
    let redacted = json
      .replace(/\+?\d[\d\s\-()]{6,}\d/g, (m) => maskPhone(m))
      .replace(/("authorization"\s*:\s*")[^"]+(")/gi, '$1***$2')
      .replace(/("whatsapp_token"\s*:\s*")[^"]+(")/gi, '$1***$2');
    return JSON.parse(redacted);
  } catch { return obj; }
}
const structuredFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, correlationId, userId, ...meta }) => {
    const logEntry = scrubPII({
      timestamp,
      level,
      message,
      ...(correlationId && { correlationId }),
      ...(userId && { userId }),
      ...meta
    });
    return JSON.stringify(logEntry);
  })
);
const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NODE_ENV === 'production';
const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  })
];
if (!isServerless) {
  transports.push(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880,      maxFiles: 5
    }),
    
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880,      maxFiles: 5
    })
  );
}
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: structuredFormat,
  defaultMeta: {
    service: 'whatsapp-agent',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  },
  transports,
  ...(isServerless ? {} : {
    exceptionHandlers: [
      new winston.transports.File({ filename: 'logs/exceptions.log' })
    ],
    
    rejectionHandlers: [
      new winston.transports.File({ filename: 'logs/rejections.log' })
    ]
  })
});
export function createRequestLogger(correlationId, userId = null) {
  return logger.child({
    correlationId,
    userId,
    requestId: correlationId
  });
}
export const logHelpers = {
  logRequest: (req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || generateCorrelationId();
    req.correlationId = correlationId;
    req.logger = createRequestLogger(correlationId, req.user?.id);
    req.logger.info('Request started', {
      method: req.method,
      url: req.url,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      userId: req.user?.id
    });
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
  logBusinessEvent: (event, data = {}) => {
    logger.info('Business event', {
      event,
      ...data
    });
  },
  logPerformance: (operation, duration, metadata = {}) => {
    logger.info('Performance metric', {
      operation,
      duration,
      ...metadata
    });
  },
  logSecurity: (event, details = {}) => {
    logger.warn('Security event', {
      securityEvent: event,
      ...details
    });
  },
  logWhatsAppAPI: (action, data = {}) => {
    logger.info('WhatsApp API call', {
      apiAction: action,
      ...data
    });
  },
  logDatabase: (operation, table, duration, metadata = {}) => {
    logger.debug('Database operation', {
      operation,
      table,
      duration,
      ...metadata
    });
  }
};
export function loggingMiddleware() {
  return (req, res, next) => {
    logHelpers.logRequest(req, res, next);
  };
}
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
