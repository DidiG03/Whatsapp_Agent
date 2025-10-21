/**
 * Simple test handler for Vercel deployment debugging
 */
export default function handler(req, res) {
  try {
    console.log('Test handler called:', req.method, req.url);
    
    res.status(200).json({
      message: 'WhatsApp Agent is running on Vercel!',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
      vercel: !!process.env.VERCEL,
      envVars: {
        hasPublicBaseUrl: !!process.env.PUBLIC_BASE_URL,
        hasOpenAI: !!process.env.OPENAI_API_KEY,
        hasWhatsAppToken: !!process.env.WHATSAPP_TOKEN,
        hasClerkKey: !!process.env.CLERK_PUBLISHABLE_KEY
      }
    });
  } catch (error) {
    console.error('Test handler error:', error);
    res.status(500).json({
      error: 'Test handler failed',
      message: error.message
    });
  }
}
