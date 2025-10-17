/**
 * Error handling middleware and request logging utilities.
 */

/**
 * Request logger middleware - logs incoming requests
 */
export function requestLogger(req, res, next) {
  const start = Date.now();
  const originalSend = res.send;
  
  res.send = function(data) {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.url} - ${res.statusCode} - ${duration}ms`);
    originalSend.call(this, data);
  };
  
  next();
}

/**
 * Global error handler middleware - must be last in the middleware chain
 */
export function errorHandler(err, req, res, next) {
  console.error('Error:', err);
  
  // Don't send error details in production
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  if (res.headersSent) {
    return next(err);
  }
  
  const statusCode = err.status || err.statusCode || 500;
  const message = isDevelopment ? err.message : 'Internal Server Error';
  
  res.status(statusCode).json({
    error: message,
    ...(isDevelopment && { stack: err.stack })
  });
}
