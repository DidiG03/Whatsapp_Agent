/**
 * Mock for inbox.mjs to avoid import.meta.url issues in tests
 */

export default function registerInboxRoutes(app) {
  // Mock implementation for testing
  app.get('/inbox', (req, res) => {
    res.json({ message: 'Mock inbox route' });
  });
  
  app.post('/inbox/:phone/send-template', (req, res) => {
    res.json({ success: true, message: 'Mock template sent' });
  });
}
