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

// Essential security headers for protection against common attacks
export const securityHeaders = (req, res, next) => {
  // Prevent clickjacking attacks but allow same-origin framing for internal iframes
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Enable XSS protection (legacy browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Prevent DNS prefetching for privacy
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  
  // Disable download options
  res.setHeader('X-Download-Options', 'noopen');
  
  // Restrict cross-domain policies
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  
  // Basic CSP to prevent XSS (can be customized per route)
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://clerk.accounts.dev https://accounts.clerk.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "img-src 'self' data: https:; " +
    "font-src 'self' data: https://fonts.gstatic.com; " +
    "connect-src 'self' https://api.openai.com https://api.stripe.com https://graph.facebook.com https://modern-jay-77.accounts.dev https://accounts.clerk.com https://clerk.accounts.dev; " +
    "frame-src 'self' https://clerk.accounts.dev https://accounts.clerk.com;"
  );
  
  // HSTS for HTTPS (only in production)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  
  next();
};

// Input sanitization middleware
export const sanitizeInput = (req, res, next) => {
  // Sanitize common XSS patterns
  const sanitize = (obj) => {
    if (typeof obj === 'string') {
      return obj
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/javascript:/gi, '')
        .replace(/on\w+\s*=/gi, '')
        .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
        .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
        .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '');
    }
    if (typeof obj === 'object' && obj !== null) {
      const sanitized = {};
      for (const [key, value] of Object.entries(obj)) {
        sanitized[key] = sanitize(value);
      }
      return sanitized;
    }
    return obj;
  };

  // Only sanitize mutable properties
  if (req.body && typeof req.body === 'object') {
    req.body = sanitize(req.body);
  }
  
  // Don't modify req.query and req.params as they are read-only
  // Instead, create sanitized copies if needed in route handlers

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
