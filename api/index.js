/**
 * Vercel Serverless API Handler
 * This file adapts the Express app for Vercel's serverless environment
 */
import { createApp } from "../src/app.mjs";

let app;
let initializeSocketIO;

// Initialize the app once (Vercel will reuse this across requests)
async function initApp() {
  if (!app) {
    const appData = await createApp();
    app = appData.app;
    initializeSocketIO = appData.initializeSocketIO;
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
          reject(err);
        } else {
          resolve();
        }
      });
    });
  } catch (error) {
    console.error('Vercel handler error:', error);
    res.status(500).json({ 
      error: 'Internal Server Error',
      message: error.message 
    });
  }
}
