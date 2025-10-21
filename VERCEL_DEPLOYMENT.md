# WhatsApp Agent - Vercel Deployment Guide

This guide will help you deploy your WhatsApp Agent application to Vercel's serverless platform.

## Prerequisites

1. **Vercel Account**: Sign up at [vercel.com](https://vercel.com)
2. **GitHub Repository**: Your code should be in a GitHub repository
3. **Environment Variables**: Collect all necessary API keys and configuration values

## Quick Deployment Steps

### 1. Connect Repository to Vercel

1. Go to [vercel.com/dashboard](https://vercel.com/dashboard)
2. Click "New Project"
3. Import your GitHub repository
4. Vercel will automatically detect the Node.js configuration

### 2. Configure Environment Variables

In your Vercel project settings, add the following environment variables:

#### Required Variables
```
NODE_ENV=production
PUBLIC_BASE_URL=https://your-app-name.vercel.app
```

#### WhatsApp Business API
```
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_TOKEN=your_whatsapp_token
WHATSAPP_VERIFY_TOKEN=your_verify_token
WHATSAPP_APP_SECRET=your_app_secret
WHATSAPP_BUSINESS_PHONE=your_business_phone_number
```

#### OpenAI Integration
```
OPENAI_API_KEY=sk-your_openai_api_key
```

#### Optional Variables
```
CLERK_PUBLISHABLE_KEY=pk_test_your_clerk_publishable_key
CLERK_SECRET_KEY=sk_test_your_clerk_secret_key
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key
STRIPE_PUBLISHABLE_KEY=pk_test_your_stripe_publishable_key
```

### 3. Deploy

1. Click "Deploy" in Vercel dashboard
2. Wait for the build to complete
3. Your app will be available at `https://your-app-name.vercel.app`

## Important Considerations

### ⚠️ Serverless Limitations

**Database Persistence**: 
- SQLite database is ephemeral in serverless environment
- Data will be lost between function invocations
- **Recommendation**: Use external database (PostgreSQL, MongoDB) for production

**File Uploads**:
- Uploaded files won't persist between deployments
- Consider using cloud storage (AWS S3, Cloudinary) for file persistence

**Socket.IO**:
- Real-time features may not work as expected in serverless environment
- Consider using Vercel's WebSocket support or external services

### 🔧 Configuration Adjustments

The deployment includes these modifications:

1. **Serverless Handler**: `api/index.js` adapts Express app for Vercel
2. **Database Configuration**: `src/db-serverless.mjs` handles serverless database setup
3. **Static Assets**: Configured to serve from `/public` directory
4. **Route Handling**: All routes go through the serverless function

### 📁 File Structure for Vercel

```
├── api/
│   └── index.js          # Serverless function handler
├── public/               # Static assets
├── src/                  # Application source code
├── vercel.json           # Vercel configuration
└── vercel-env-template.txt # Environment variables template
```

## Post-Deployment Setup

### 1. Update WhatsApp Webhook

1. Go to your Meta Developer Console
2. Update webhook URL to: `https://your-app-name.vercel.app/webhook`
3. Use the same verify token from your environment variables

### 2. Test the Application

1. Visit your Vercel URL
2. Test WhatsApp integration
3. Verify webhook is receiving messages

### 3. Monitor Performance

- Use Vercel's built-in analytics
- Monitor function execution times
- Check logs for any errors

## Production Recommendations

### Database Migration

For production use, consider migrating to a persistent database:

1. **PostgreSQL**: Use Vercel Postgres or external service
2. **MongoDB**: Use MongoDB Atlas
3. **Update**: Modify `src/db.mjs` to use the new database

### File Storage

1. **AWS S3**: For file uploads
2. **Cloudinary**: For image processing
3. **Update**: Modify upload handling in routes

### Scaling Considerations

1. **Function Limits**: Vercel has execution time limits
2. **Memory Usage**: Monitor memory consumption
3. **Cold Starts**: Consider keeping functions warm

## Troubleshooting

### Common Issues

1. **Build Failures**: Check Node.js version compatibility
2. **Environment Variables**: Ensure all required variables are set
3. **Database Errors**: Verify database configuration
4. **Static Assets**: Check file paths and permissions

### Debugging

1. Check Vercel function logs
2. Use `console.log()` for debugging
3. Test locally with `vercel dev`

## Alternative Deployment Options

If Vercel doesn't meet your needs, consider:

1. **Railway**: Better for persistent applications
2. **Render**: Good for full-stack apps
3. **DigitalOcean App Platform**: More control over infrastructure
4. **AWS Lambda**: Similar serverless approach

## Support

- Vercel Documentation: [vercel.com/docs](https://vercel.com/docs)
- WhatsApp Business API: [developers.facebook.com](https://developers.facebook.com)
- Project Issues: Check your GitHub repository

---

**Note**: This deployment is optimized for development and testing. For production use with high traffic, consider the limitations mentioned above and plan accordingly.
