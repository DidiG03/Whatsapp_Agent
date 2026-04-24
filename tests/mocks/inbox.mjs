

export default function registerInboxRoutes(app) {
  app.get('/inbox', (req, res) => {
    res.json({ message: 'Mock inbox route' });
  });
  
  app.post('/inbox/:phone/send-template', (req, res) => {
    res.json({ success: true, message: 'Mock template sent' });
  });
}
