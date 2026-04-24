

import { logHelpers } from '../monitoring/logger.mjs';
import { businessMetrics } from '../monitoring/metrics.mjs';
const cdnConfig = {
  provider: process.env.CDN_PROVIDER || 'cloudflare',  domain: process.env.CDN_DOMAIN || '',
  apiKey: process.env.CDN_API_KEY || '',
  zoneId: process.env.CDN_ZONE_ID || '',
  defaultTTL: parseInt(process.env.CDN_DEFAULT_TTL || '86400'),  staticAssetsTTL: parseInt(process.env.CDN_STATIC_TTL || '31536000'),  dynamicContentTTL: parseInt(process.env.CDN_DYNAMIC_TTL || '3600'),  enableImageOptimization: process.env.CDN_IMAGE_OPTIMIZATION === 'true',
  imageFormats: ['webp', 'avif', 'jpeg', 'png'],
  imageSizes: [320, 640, 768, 1024, 1280, 1920],
  enableSecurityHeaders: process.env.CDN_SECURITY_HEADERS === 'true',
  enableDDoSProtection: process.env.CDN_DDOS_PROTECTION === 'true'
};
export const cdn = {
  generateAssetUrl(path, options = {}) {
    if (!cdnConfig.domain) {
      return path;    }
    
    const {
      version = null,
      format = null,
      width = null,
      height = null,
      quality = null
    } = options;
    
    let url = `${cdnConfig.domain}/${path}`;
    if (version) {
      url += `?v=${version}`;
    }
    if (format || width || height || quality) {
      const params = new URLSearchParams();
      if (format) params.append('format', format);
      if (width) params.append('w', width);
      if (height) params.append('h', height);
      if (quality) params.append('q', quality);
      
      url += (version ? '&' : '?') + params.toString();
    }
    
    return url;
  },
  generateResponsiveImageUrls(basePath, options = {}) {
    const {
      alt = '',
      sizes = '(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw',
      loading = 'lazy'
    } = options;
    
    const srcset = cdnConfig.imageSizes.map(width => {
      const url = this.generateAssetUrl(basePath, { width, format: 'webp' });
      return `${url} ${width}w`;
    }).join(', ');
    
    const fallbackUrl = this.generateAssetUrl(basePath, { format: 'jpeg' });
    
    return {
      srcset,
      src: fallbackUrl,
      alt,
      sizes,
      loading
    };
  },
  async purgeCache(urls) {
    if (!cdnConfig.apiKey || !cdnConfig.zoneId) {
      logHelpers.logBusinessEvent('cdn_purge_skipped', { reason: 'no_credentials' });
      return false;
    }
    
    try {
      const startTime = Date.now();
      if (cdnConfig.provider === 'cloudflare') {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${cdnConfig.zoneId}/purge_cache`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${cdnConfig.apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              files: urls
            })
          }
        );
        
        const result = await response.json();
        const duration = Date.now() - startTime;
        
        if (result.success) {
          logHelpers.logBusinessEvent('cdn_purge_success', { 
            urls: urls.length,
            duration 
          });
          return true;
        } else {
          logHelpers.logError(new Error('CDN purge failed'), { 
            component: 'cdn', 
            operation: 'purge',
            errors: result.errors 
          });
          return false;
        }
      }
      
      return false;
    } catch (error) {
      logHelpers.logError(error, { component: 'cdn', operation: 'purge' });
      return false;
    }
  },
  async uploadFile(filePath, fileBuffer, options = {}) {
    if (!cdnConfig.apiKey) {
      logHelpers.logBusinessEvent('cdn_upload_skipped', { reason: 'no_credentials' });
      return null;
    }
    
    try {
      const startTime = Date.now();
      if (cdnConfig.provider === 'cloudflare') {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${cdnConfig.zoneId}/r2/buckets/${cdnConfig.bucketName}/objects/${filePath}`,
          {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${cdnConfig.apiKey}`,
              'Content-Type': options.contentType || 'application/octet-stream'
            },
            body: fileBuffer
          }
        );
        
        const duration = Date.now() - startTime;
        
        if (response.ok) {
          const cdnUrl = this.generateAssetUrl(filePath);
          
          logHelpers.logBusinessEvent('cdn_upload_success', { 
            filePath,
            size: fileBuffer.length,
            duration 
          });
          
          return cdnUrl;
        } else {
          throw new Error(`Upload failed: ${response.statusText}`);
        }
      }
      
      return null;
    } catch (error) {
      logHelpers.logError(error, { component: 'cdn', operation: 'upload', filePath });
      return null;
    }
  },
  async getStats() {
    if (!cdnConfig.apiKey || !cdnConfig.zoneId) {
      return { available: false, reason: 'no_credentials' };
    }
    
    try {
      if (cdnConfig.provider === 'cloudflare') {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${cdnConfig.zoneId}/analytics/dashboard`,
          {
            headers: {
              'Authorization': `Bearer ${cdnConfig.apiKey}`
            }
          }
        );
        
        const data = await response.json();
        
        if (data.success) {
          return {
            available: true,
            provider: cdnConfig.provider,
            stats: data.result
          };
        }
      }
      
      return { available: false, reason: 'api_error' };
    } catch (error) {
      logHelpers.logError(error, { component: 'cdn', operation: 'stats' });
      return { available: false, reason: 'error', error: error.message };
    }
  }
};
export const assetOptimizer = {
  async optimizeImage(imageBuffer, options = {}) {
    const {
      format = 'webp',
      quality = 80,
      width = null,
      height = null
    } = options;
    
    try {
      logHelpers.logBusinessEvent('image_optimization', { 
        format,
        quality,
        originalSize: imageBuffer.length 
      });
      
      return imageBuffer;
    } catch (error) {
      logHelpers.logError(error, { component: 'asset_optimizer', operation: 'optimize_image' });
      return imageBuffer;    }
  },
  async generateFormats(imageBuffer, options = {}) {
    const formats = options.formats || ['webp', 'jpeg', 'png'];
    const results = {};
    
    for (const format of formats) {
      try {
        results[format] = await this.optimizeImage(imageBuffer, { ...options, format });
      } catch (error) {
        logHelpers.logError(error, { component: 'asset_optimizer', operation: 'generate_format', format });
      }
    }
    
    return results;
  }
};
export function cdnMiddleware(options = {}) {
  const {
    staticPath = '/static',
    enableCacheHeaders = true,
    enableSecurityHeaders = true
  } = options;
  
  return (req, res, next) => {
    if (req.path.startsWith(staticPath)) {
      if (enableCacheHeaders) {
        res.setHeader('Cache-Control', `public, max-age=${cdnConfig.staticAssetsTTL}`);
        res.setHeader('Expires', new Date(Date.now() + cdnConfig.staticAssetsTTL * 1000).toUTCString());
      }
      
      if (enableSecurityHeaders) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      }
    }
    if (cdnConfig.domain) {
      res.setHeader('X-CDN-Domain', cdnConfig.domain);
    }
    
    next();
  };
}
export const cdnHelpers = {
  asset(path, options = {}) {
    return cdn.generateAssetUrl(path, options);
  },
  responsiveImage(path, options = {}) {
    return cdn.generateResponsiveImageUrls(path, options);
  },
  preloadAsset(path, options = {}) {
    const url = cdn.generateAssetUrl(path, options);
    const as = options.as || 'image';
    return `<link rel="preload" href="${url}" as="${as}">`;
  }
};
export function trackCDNUsage(operation, details = {}) {
  businessMetrics.logBusinessEvent('cdn_usage', {
    operation,
    provider: cdnConfig.provider,
    ...details
  });
}

export default {
  cdn,
  assetOptimizer,
  cdnMiddleware,
  cdnHelpers,
  trackCDNUsage
};
