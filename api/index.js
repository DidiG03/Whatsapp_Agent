
import { createApp } from "../src/app.mjs";

let app;
let appInitialized = false;
async function initApp() {
  if (!appInitialized) {
    try {
      console.log('Initializing WhatsApp Agent app for Vercel...');
      const appData = await createApp();
      app = appData.app;
      appInitialized = true;
      console.log('App initialized successfully');
    } catch (error) {
      console.error('Failed to initialize app:', error);
      throw error;
    }
  }
  return { app };
}

export default async function handler(req, res) {
  try {
    const { app } = await initApp();
    return new Promise((resolve, reject) => {
      app(req, res, (err) => {
        if (err) {
          console.error('Express error:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  } catch (error) {
    console.error('Vercel handler error:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Internal Server Error',
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
}
