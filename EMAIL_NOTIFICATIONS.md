# Email Notifications Setup

This WhatsApp Agent now supports email notifications to alert you when customers escalate to support.

## Features

- **Real-time Notifications**: Get instant email alerts when a customer requests human support
- **Customizable Email**: Use your account email or specify a different notification email
- **Rich Email Content**: Emails include customer name, phone number, escalation reason, and direct link to inbox
- **Easy Toggle**: Enable/disable notifications anytime from the Settings page
- **Per-User SMTP**: Each user can configure their own email provider settings directly in the UI
- **Secure Storage**: SMTP credentials are stored securely in your database

## Setup Instructions

### Option 1: Configure via Settings UI (Recommended)

1. Navigate to **Settings** in your dashboard
2. Scroll to the **Email Notifications** section
3. Check "Send email when customer escalates to support"
4. Expand the **SMTP Configuration** section
5. Fill in your email provider details:
   - **SMTP Host**: e.g., `smtp.gmail.com`
   - **SMTP Port**: Usually `587` or `465`
   - **Use secure connection**: Check if using port 465
   - **SMTP Username**: Your email address
   - **SMTP Password**: Your app password or SMTP password
6. (Optional) Enter a custom notification email
7. Click **Save**

### Option 2: Configure via Environment Variables

For server-wide default SMTP settings, add these to your `.env` file:

```env
# Email Notifications (SMTP Configuration)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password
```

**Note**: Per-user settings in the UI take priority over environment variables.

## Provider-Specific Setup

#### Gmail
1. Enable 2-Factor Authentication on your Google account
2. Generate an App Password:
   - Go to https://myaccount.google.com/apppasswords
   - Select "Mail" and your device
   - Copy the 16-character password
3. Use this App Password as `SMTP_PASS`

#### Other Email Providers
- **Outlook/Office 365**: 
  - SMTP_HOST: `smtp.office365.com`
  - SMTP_PORT: `587`
  - SMTP_SECURE: `false`

- **SendGrid**:
  - SMTP_HOST: `smtp.sendgrid.net`
  - SMTP_PORT: `587`
  - SMTP_USER: `apikey`
  - SMTP_PASS: Your SendGrid API Key

- **Mailgun**:
  - SMTP_HOST: `smtp.mailgun.org`
  - SMTP_PORT: `587`
  - SMTP_USER: Your Mailgun SMTP username
  - SMTP_PASS: Your Mailgun SMTP password

## Quick Start for Gmail Users

1. **Create an App Password**:
   - Go to https://myaccount.google.com/apppasswords
   - Select "Mail" and your device
   - Copy the 16-character password

2. **Configure in Settings**:
   - Navigate to Settings → Email Notifications
   - Fill in:
     - SMTP Host: `smtp.gmail.com`
     - SMTP Port: `587`
     - SMTP Username: `your-email@gmail.com`
     - SMTP Password: Paste the 16-character App Password
   - Check "Send email when customer escalates to support"
   - Click Save

3. **Test**: Have a customer request human support to see the email notification!

## How It Works

When a customer requests to speak with a human:

1. The bot asks for their name (if not already provided)
2. The bot asks for the reason for escalation
3. Once the reason is provided:
   - The customer receives a "connecting you now" message
   - An email notification is sent to the account owner
   - The conversation appears in your Inbox with the escalation details

## Email Format

Notification emails include:
- **Subject**: 🚨 New Support Escalation from [Customer Name/Phone]
- **Customer Name**: Display name collected during escalation
- **Phone Number**: WhatsApp number of the customer
- **Reason**: The specific reason they provided for escalation
- **Time**: When the escalation occurred
- **Action Button**: Direct link to view the conversation in your Inbox

## Troubleshooting

### Emails Not Sending

1. **Check SMTP credentials in Settings**: 
   - Go to Settings → Email Notifications → SMTP Configuration
   - Verify all fields are filled correctly
   - For Gmail, ensure you're using an App Password (not your regular password)
2. **Check logs**: Look for `[Email]` prefixed messages in your server logs
3. **Verify toggle is enabled**: Ensure "Send email when customer escalates to support" is checked
4. **Test the configuration**: Try a test escalation to verify email delivery
5. **Check port settings**: 
   - Port 587: Uncheck "Use secure connection"
   - Port 465: Check "Use secure connection"

### Gmail-Specific Issues

- **"Less secure app access"**: Use an App Password instead of your regular password
- **Blocked sign-in**: Check your Gmail inbox for security alerts and allow the connection
- **Rate limits**: Gmail has sending limits (500 emails/day for free accounts)

### Common Errors

- **Authentication failed**: Wrong password or username
- **Connection timeout**: Check your SMTP_HOST and SMTP_PORT
- **TLS/SSL errors**: Verify SMTP_SECURE setting (false for 587, true for 465)

## Disabling Email Notifications

To temporarily disable notifications without removing SMTP configuration:

1. Go to **Settings**
2. Uncheck "Send email when customer escalates to support"
3. Click **Save**

## Security Notes

- **Credential Storage**: SMTP credentials are stored in your SQLite database
- **Per-User Isolation**: Each user's SMTP settings are isolated and only accessible to them
- **Password Protection**: SMTP passwords are hidden in the UI (password field type)
- **App Passwords**: Always use App Passwords or API keys instead of your main email password
- **Access Control**: Only authenticated users can access their own settings
- **Best Practices**:
  - Use App Passwords for Gmail
  - Regularly rotate credentials
  - Monitor your email service for unusual activity
  - Don't share your SMTP credentials
  
**Note**: While credentials are stored in the database, they are not encrypted. For production use with sensitive data, consider implementing database encryption at rest.

## Future Enhancements

Potential features for future releases:
- Notifications for new messages during business hours
- Daily/weekly summaries of conversations
- Customizable email templates
- Multiple notification recipients
- SMS notifications
- Slack/Discord integrations

