

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
jest.mock('node-fetch', () => {
  return jest.fn(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ messages: [{ id: 'test-message-id' }] })
  }));
});
jest.mock('../../../src/db.mjs', () => ({
  db: null}));
import { sendWhatsAppText, sendWhatsAppTemplate, sendWhatsappImage } from '../../../src/services/whatsapp.mjs';
import fetch from 'node-fetch';

describe('WhatsApp Service', () => {
  beforeEach(() => {
    fetch.mockClear();
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ messages: [{ id: 'test-message-id' }] })
    });
  });

  describe('sendWhatsAppText', () => {
    test('should send a text message successfully', async () => {
      const to = '+1234567890';
      const text = 'Hello, this is a test message';
      const config = {
        phone_number_id: 'test-phone-id',
        whatsapp_token: 'test-access-token'
      };

      const result = await sendWhatsAppText(to, text, config);

      expect(fetch).toHaveBeenCalledWith(
        `https://graph.facebook.com/v20.0/${config.phone_number_id}/messages`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': `Bearer ${config.whatsapp_token}`,
            'Content-Type': 'application/json'
          }),
          body: expect.stringContaining(text)
        })
      );

      expect(result).toBeDefined();
    });

    test('should handle API errors gracefully', async () => {
      fetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: { message: 'Invalid phone number' } })
      });

      const to = 'invalid-phone';
      const text = 'Test message';
      const config = {
        phone_number_id: 'test-phone-id',
        whatsapp_token: 'test-access-token'
      };

      await expect(sendWhatsAppText(to, text, config)).rejects.toThrow();
    });

    test('should include reply context when provided', async () => {
      const to = '+1234567890';
      const text = 'This is a reply';
      const config = {
        phone_number_id: 'test-phone-id',
        whatsapp_token: 'test-access-token'
      };
      const replyToMessageId = 'original-message-id';

      await sendWhatsAppText(to, text, config, replyToMessageId);

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining(replyToMessageId)
        })
      );
    });
  });

  describe('sendWhatsAppTemplate', () => {
    test('should send a template message successfully', async () => {
      const to = '+1234567890';
      const templateName = 'hello_world';
      const templateLanguage = 'en_US';
      const components = [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'John' },
            { type: 'text', text: 'Doe' }
          ]
        }
      ];
      const config = {
        phone_number_id: 'test-phone-id',
        whatsapp_token: 'test-access-token'
      };

      const result = await sendWhatsAppTemplate(to, templateName, templateLanguage, components, config);

      expect(fetch).toHaveBeenCalledWith(
        `https://graph.facebook.com/v20.0/${config.phone_number_id}/messages`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': `Bearer ${config.whatsapp_token}`,
            'Content-Type': 'application/json'
          }),
          body: expect.stringContaining(templateName)
        })
      );

      expect(result).toBeDefined();
    });

    test('should handle template errors', async () => {
      fetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: { message: 'Template not found' } })
      });

      const to = '+1234567890';
      const templateName = 'nonexistent_template';
      const templateLanguage = 'en_US';
      const components = [];
      const config = {
        phone_number_id: 'test-phone-id',
        whatsapp_token: 'test-access-token'
      };

      await expect(sendWhatsAppTemplate(to, templateName, templateLanguage, components, config))
        .rejects.toThrow();
    });
  });

  describe('sendWhatsappImage', () => {
    test('should send an image message successfully', async () => {
      const to = '+1234567890';
      const imageUrl = 'https://example.com/image.jpg';
      const caption = 'Check out this image!';
      const config = {
        phone_number_id: 'test-phone-id',
        whatsapp_token: 'test-access-token'
      };

      const result = await sendWhatsappImage(to, imageUrl, caption, config);

      expect(fetch).toHaveBeenCalledWith(
        `https://graph.facebook.com/v20.0/${config.phone_number_id}/messages`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': `Bearer ${config.whatsapp_token}`,
            'Content-Type': 'application/json'
          }),
          body: expect.stringContaining(imageUrl)
        })
      );

      expect(result).toBeDefined();
    });

    test('should send image without caption', async () => {
      const to = '+1234567890';
      const imageUrl = 'https://example.com/image.jpg';
      const config = {
        phone_number_id: 'test-phone-id',
        whatsapp_token: 'test-access-token'
      };

      await sendWhatsappImage(to, imageUrl, null, config);

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.not.stringContaining('caption')
        })
      );
    });
  });
});
