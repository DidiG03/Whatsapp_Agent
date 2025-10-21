# Vercel Deployment Troubleshooting Guide

## Current Issues Fixed

Based on the error logs showing `ENOENT: no such file or directory` and `dotenv` issues, I've made the following fixes:

### 1. Environment Variable Loading
- **Problem**: App was trying to load `.env` file that doesn't exist in Vercel
- **Fix**: Updated `src/config.mjs` to only load `.env` file when it exists and not in Vercel environment

### 2. Error Handling
- **Problem**: Poor error handling in serverless function
- **Fix**: Enhanced `api/index.js` with better error handling and logging

### 3. Database Initialization
- **Problem**: Database initialization errors causing app crashes
- **Fix**: Made database initialization more resilient in `src/db-serverless.mjs`

### 4. Test Endpoint
- **Added**: `/api/test` endpoint to help debug deployment issues

## Next Steps to Fix Your Deployment

### 1. Set Environment Variables in Vercel

Go to your Vercel project dashboard and add these environment variables:

**Required:**
```
NODE_ENV=production
PUBLIC_BASE_URL=https://your-app-name.vercel.app
```

**WhatsApp Business API:**
```
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_TOKEN=your_whatsapp_token
WHATSAPP_VERIFY_TOKEN=your_verify_token
WHATSAPP_APP_SECRET=your_app_secret
WHATSAPP_BUSINESS_PHONE=your_business_phone_number
```

**OpenAI:**
```
OPENAI_API_KEY=sk-your_openai_api_key
```

### 2. Test the Deployment

1. **Test Endpoint**: Visit `https://your-app-name.vercel.app/api/test`
   - This will show you if the basic deployment is working
   - It will also show which environment variables are set

2. **Main App**: Visit `https://your-app-name.vercel.app/`
   - This should now work without the 500 errors

### 3. Check Vercel Logs

1. Go to your Vercel dashboard
2. Click on your project
3. Go to "Functions" tab
4. Check the logs for any remaining errors

## Common Issues and Solutions

### Issue: Still getting 500 errors
**Solution**: 
1. Check that all required environment variables are set in Vercel
2. Visit `/api/test` to see which variables are missing
3. Check Vercel function logs for specific error messages

### Issue: Static files not loading
**Solution**: 
1. Ensure your `public` folder is properly committed to git
2. Check that file paths in your HTML/CSS are correct
3. Static files should be served from `/public/` path

### Issue: Database errors
**Solution**: 
1. The SQLite database is ephemeral in serverless environment
2. For production, consider using external database
3. For testing, the current setup should work

### Issue: WhatsApp webhook not working
**Solution**: 
1. Update your Meta Developer Console webhook URL to: `https://your-app-name.vercel.app/webhook`
2. Ensure `WHATSAPP_VERIFY_TOKEN` matches in both Vercel and Meta console

## Files Modified

1. `src/config.mjs` - Fixed environment variable loading
2. `api/index.js` - Enhanced error handling
3. `src/db-serverless.mjs` - Made database initialization more resilient
4. `api/test.js` - Added test endpoint for debugging
5. `vercel.json` - Added test endpoint routing

## Testing Checklist

- [ ] Environment variables set in Vercel dashboard
- [ ] `/api/test` endpoint returns success
- [ ] Main app loads without 500 errors
- [ ] Static assets (CSS, JS, images) load properly
- [ ] WhatsApp webhook responds correctly

## If Issues Persist

1. Check Vercel function logs for specific error messages
2. Test locally with `vercel dev` to debug issues
3. Ensure all dependencies are properly installed
4. Consider using Vercel's support if deployment continues to fail

The main issue was the missing `.env` file causing the dotenv library to fail. With these fixes, your deployment should work properly.
