/**
 * Production Security Middleware
 * Implements rate limiting, request validation, and security headers
 */
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { logger } from '../logger.mjs';

// Rate limiting configurations (increased limits)
export const createRateLimiters = () => {
  // General API rate limiter - increased significantly
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 2000, // limit each IP to 2000 requests per windowMs (increased from 100)
    message: { error: 'Too many requests from this IP, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Strict limiter for sensitive endpoints - increased significantly
  const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500, // limit each IP to 500 requests per windowMs (increased from 10)
    message: { error: 'Too many requests to sensitive endpoint, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Webhook rate limiter - increased for WhatsApp
  const webhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5000, // WhatsApp can send many webhooks (increased from 1000)
    message: { error: 'Webhook rate limit exceeded.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  return { generalLimiter, strictLimiter, webhookLimiter };
};

// Minimal security headers (CSP and frame options completely disabled)
export const securityHeaders = (req, res, next) => {
  // Explicitly remove any CSP or frame-related headers
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('X-Frame-Options');
  res.removeHeader('X-Content-Type-Options');
  res.removeHeader('X-XSS-Protection');
  res.removeHeader('X-DNS-Prefetch-Control');
  res.removeHeader('X-Download-Options');
  res.removeHeader('X-Permitted-Cross-Domain-Policies');
  res.removeHeader('Strict-Transport-Security');
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');
  
  next();
};

// Request validation middleware
export const validateRequest = (schema) => {
  return (req, res, next) => {
    try {
      const { error } = schema.validate(req.body);
      if (error) {
        logger.warn({ error: error.details[0].message, path: req.path }, 'Request validation failed');
        return res.status(400).json({ error: 'Invalid request data' });
      }
      next();
    } catch (err) {
      logger.error({ err }, 'Request validation error');
      res.status(500).json({ error: 'Internal server error' });
    }
  };
};

// IP whitelist for admin endpoints
export const adminWhitelist = (req, res, next) => {
  const allowedIPs = process.env.ADMIN_ALLOWED_IPS?.split(',') || ['127.0.0.1', '::1'];
  const clientIP = req.ip || req.connection.remoteAddress;
  
  if (!allowedIPs.includes(clientIP)) {
    logger.warn({ clientIP, path: req.path }, 'Unauthorized admin access attempt');
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
};
