
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { logHelpers } from '../monitoring/logger.mjs';

function getClerkCspOrigins() {
  const origins = new Set();
  for (const entry of (process.env.CLERK_FRONTEND_DOMAIN || '').split(',')) {
    const trimmed = entry.trim().replace(/\/$/, '');
    if (!trimmed) continue;
    origins.add(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  }
  try {
    const base = (process.env.PUBLIC_BASE_URL || '').trim();
    if (!base) return [...origins].join(' ');
    const host = new URL(base).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host.includes('ngrok')) {
      return [...origins].join(' ');
    }
    const parts = host.split('.');
    if (parts.length >= 2) {
      const apex = parts.slice(-2).join('.');
      origins.add(`https://clerk.${apex}`);
      origins.add(`wss://clerk.${apex}`);
    }
  } catch (_) {}
  return [...origins].join(' ');
}

export const createRateLimiters = () => {
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,    max: 2000,    message: { error: 'Too many requests from this IP, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,    max: 500,    message: { error: 'Too many requests to sensitive endpoint, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  const webhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,    max: 5000,    message: { error: 'Webhook rate limit exceeded.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  return { generalLimiter, strictLimiter, webhookLimiter };
};
export const securityHeaders = (req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  const clerkExtras = getClerkCspOrigins();
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; " +
    ("script-src 'self' 'unsafe-inline' https://clerk.accounts.dev https://accounts.clerk.com https://unpkg.com https://*.clerk.accounts.dev https://challenges.cloudflare.com https://*.cloudflare.com https://js.stripe.com https://vercel.live https://cdn.ably.io https://connect.facebook.net https://www.facebook.com" + (clerkExtras ? ` ${clerkExtras}` : '') + "; ") +
    "worker-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    ("img-src 'self' data: https: https://m.stripe.network https://*.stripe.com" + (clerkExtras ? ` ${clerkExtras}` : '') + "; ") +
    "font-src 'self' data: https://fonts.gstatic.com; " +
    ("connect-src 'self' https://api.openai.com https://api.stripe.com https://m.stripe.network https://graph.facebook.com https://www.facebook.com https://web.facebook.com https://connect.facebook.net https://*.clerk.accounts.dev https://accounts.clerk.com https://clerk.accounts.dev https://clerk-telemetry.com https://*.cloudflare.com https://vercel.live wss://vercel.live https://rest.ably.io https://*.ably.io https://ably.io https://*.ably-realtime.com wss://*.ably.io wss://ably.io wss://*.ably-realtime.com" + (clerkExtras ? ` ${clerkExtras}` : '') + "; ") +
    ("frame-src 'self' https://clerk.accounts.dev https://accounts.clerk.com https://*.clerk.accounts.dev https://challenges.cloudflare.com https://*.cloudflare.com https://js.stripe.com https://hooks.stripe.com https://vercel.live https://www.facebook.com https://web.facebook.com https://connect.facebook.net" + (clerkExtras ? ` ${clerkExtras}` : '') + ";")
  );
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  
  next();
};
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const sanitizeInput = (req, res, next) => {
  const stripDangerousKeys = (obj, depth = 0) => {
    if (depth > 50 || obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      for (const item of obj) stripDangerousKeys(item, depth + 1);
      return obj;
    }
    for (const key of Object.keys(obj)) {
      if (DANGEROUS_KEYS.has(key)) {
        delete obj[key];
        continue;
      }
      stripDangerousKeys(obj[key], depth + 1);
    }
    return obj;
  };
  if (req.body && typeof req.body === 'object') {
    stripDangerousKeys(req.body);
  }

  next();
};
export const validateRequest = (schema) => {
  return (req, res, next) => {
    try {
      const { error } = schema.validate(req.body);
      if (error) {
        logHelpers.logSecurity('request_validation_failed', { error: error.details[0].message, path: req.path });
        return res.status(400).json({ error: 'Invalid request data' });
      }
      next();
    } catch (err) {
      logHelpers.logError(err, { component: 'request_validation', path: req.path });
      res.status(500).json({ error: 'Internal server error' });
    }
  };
};
export const adminWhitelist = (req, res, next) => {
  const allowedIPs = process.env.ADMIN_ALLOWED_IPS?.split(',') || ['127.0.0.1', '::1'];
  const clientIP = req.ip || req.connection.remoteAddress;
  
  if (!allowedIPs.includes(clientIP)) {
    logHelpers.logSecurity('admin_ip_denied', { clientIP, path: req.path });
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
};
