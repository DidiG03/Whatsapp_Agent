/**
 * Simple utility tests that don't require complex imports
 */

import { describe, test, expect } from '@jest/globals';

describe('Utility Functions', () => {
  test('should validate phone numbers', () => {
    const normalizePhone = (phone) => {
      return phone.replace(/\D/g, '');
    };
    
    expect(normalizePhone('+1234567890')).toBe('1234567890');
    expect(normalizePhone('(123) 456-7890')).toBe('1234567890');
    expect(normalizePhone('123-456-7890')).toBe('1234567890');
  });

  test('should escape HTML content', () => {
    const escapeHtml = (text) => {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };
    
    expect(escapeHtml('<script>alert("test")</script>')).toBe('&lt;script&gt;alert(&quot;test&quot;)&lt;/script&gt;');
    expect(escapeHtml('Hello & welcome')).toBe('Hello &amp; welcome');
  });

  test('should format timestamps', () => {
    const formatTimestamp = (timestamp) => {
      const date = new Date(timestamp * 1000);
      return date.toISOString();
    };
    
    const now = Math.floor(Date.now() / 1000);
    const formatted = formatTimestamp(now);
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('should validate email addresses', () => {
    const isValidEmail = (email) => {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return emailRegex.test(email);
    };
    
    expect(isValidEmail('test@example.com')).toBe(true);
    expect(isValidEmail('user.name@domain.co.uk')).toBe(true);
    expect(isValidEmail('invalid-email')).toBe(false);
    expect(isValidEmail('@domain.com')).toBe(false);
    expect(isValidEmail('user@')).toBe(false);
  });

  test('should generate unique IDs', () => {
    const generateId = () => {
      return 'id_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    };
    
    const id1 = generateId();
    const id2 = generateId();
    
    expect(id1).toMatch(/^id_[a-z0-9]+_\d+$/);
    expect(id2).toMatch(/^id_[a-z0-9]+_\d+$/);
    expect(id1).not.toBe(id2);
  });

  test('should handle JSON operations safely', () => {
    const safeJsonParse = (jsonString) => {
      try {
        return JSON.parse(jsonString);
      } catch (error) {
        return null;
      }
    };
    
    expect(safeJsonParse('{"key": "value"}')).toEqual({ key: 'value' });
    expect(safeJsonParse('invalid json')).toBe(null);
    expect(safeJsonParse('')).toBe(null);
  });

  test('should truncate text properly', () => {
    const truncateText = (text, maxLength) => {
      if (text.length <= maxLength) return text;
      return text.substring(0, maxLength - 3) + '...';
    };
    
    expect(truncateText('Short text', 20)).toBe('Short text');
    expect(truncateText('This is a very long text that should be truncated', 20)).toBe('This is a very lo...');
    expect(truncateText('Exactly twenty chars', 20)).toBe('Exactly twenty chars');
  });
});
