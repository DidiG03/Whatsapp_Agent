/**
 * Vercel Serverless API Handler
 * This file adapts the Express app for Vercel's serverless environment
 */
import { createApp } from "../src/app.mjs";

let app;
let initializeSocketIO;
let appInitialized = false;

// Initialize the app once (Vercel will reuse this across requests)
async function initApp() {
  if (!appInitialized) {
    try {
      console.log('Initializing WhatsApp Agent app for Vercel...');
      const appData = await createApp();
      app = appData.app;
      initializeSocketIO = appData.initializeSocketIO;
      appInitialized = true;
      console.log('App initialized successfully');
    } catch (error) {
      console.error('Failed to initialize app:', error);
      throw error;
    }
  }
  return { app, initializeSocketIO };
}

export default async function handler(req, res) {
  try {
    // Initialize app if not already done
    const { app } = await initApp();
    
    // Handle the request with Express
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
    
    // Return a proper error response
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Internal Server Error',
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
}
