/**
 * Email notification service using nodemailer.
 * Supports multiple email providers through SMTP configuration.
 * Prioritizes per-user SMTP settings, falls back to environment variables.
 */
import nodemailer from 'nodemailer';
import { getSettingsForUser } from './settings.mjs';
import { clerkClient } from '../middleware/auth.mjs';

/**
 * Create a nodemailer transporter based on user settings or environment variables
 * @param {Object} userSettings - User's settings object (optional)
 */
function createTransporter(userSettings = {}) {
  // Try user-specific SMTP settings first, then fall back to environment variables
  const host = userSettings?.smtp_host || process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = userSettings?.smtp_port || parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = userSettings?.smtp_secure === 1 || process.env.SMTP_SECURE === 'true';
  const user = userSettings?.smtp_user || process.env.SMTP_USER;
  const pass = userSettings?.smtp_pass || process.env.SMTP_PASS;

  // If no SMTP credentials configured, return null
  if (!user || !pass) {
    console.warn('[Email] SMTP credentials not configured. Email notifications disabled.');
    return null;
  }

  const config = {
    host,
    port,
    secure, // true for 465, false for other ports
    auth: {
      user,
      pass,
    },
  };

  return nodemailer.createTransport(config);
}

/**
 * Send escalation notification email to account owner
 * @param {string} userId - The Clerk user ID (account owner)
 * @param {Object} escalationData - Data about the escalation
 * @param {string} escalationData.customerName - Name of the customer
 * @param {string} escalationData.customerPhone - Phone number of the customer
 * @param {string} escalationData.reason - Reason for escalation
 * @param {string} escalationData.timestamp - ISO timestamp of escalation
 */
export async function sendEscalationNotification(userId, escalationData) {
  try {
    // Check if email notifications are enabled for this user
    const settings = getSettingsForUser(userId);
    if (!settings?.escalation_email_enabled) {
      console.log('[Email] Escalation notifications disabled for user:', userId);
      return { success: false, reason: 'disabled' };
    }

    // Get the notification email (either custom or from Clerk account)
    let notificationEmail = settings?.escalation_email;
    
    // If no custom email set, try to get from Clerk account
    if (!notificationEmail) {
      try {
        const user = await clerkClient.users.getUser(userId);
        const primaryId = user.primaryEmailAddressId;
        notificationEmail = user.emailAddresses?.find(e => e.id === primaryId)?.emailAddress;
        if (!notificationEmail) {
          notificationEmail = user.emailAddresses?.[0]?.emailAddress;
        }
      } catch (e) {
        console.error('[Email] Failed to retrieve user email from Clerk:', e.message);
      }
    }

    if (!notificationEmail) {
      console.warn('[Email] No notification email configured for user:', userId);
      return { success: false, reason: 'no_email' };
    }

    const transporter = createTransporter(settings);
    if (!transporter) {
      return { success: false, reason: 'no_smtp_config' };
    }
    
    // Determine the "from" email address
    const fromEmail = settings?.smtp_user || process.env.SMTP_USER;

    // Format the email
    const { customerName, customerPhone, reason, timestamp } = escalationData;
    const businessName = settings?.business_name || 'Your Business';
    const formattedTime = timestamp ? new Date(timestamp).toLocaleString() : 'Just now';

    const subject = `🚨 New Support Escalation from ${customerName || customerPhone}`;
    
    const htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #4F46E5; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
          .content { background: #f9f9f9; padding: 20px; border-radius: 0 0 5px 5px; }
          .detail { margin: 10px 0; padding: 10px; background: white; border-left: 4px solid #4F46E5; }
          .label { font-weight: bold; color: #4F46E5; }
          .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; font-size: 12px; }
          .action-button { display: inline-block; margin-top: 15px; padding: 12px 24px; background: #4F46E5; color: white; text-decoration: none; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>🚨 New Support Escalation</h2>
            <p style="margin: 0;">A customer has requested to speak with support</p>
          </div>
          <div class="content">
            <div class="detail">
              <div class="label">Customer Name:</div>
              <div>${customerName || 'Not provided'}</div>
            </div>
            <div class="detail">
              <div class="label">Phone Number:</div>
              <div>${customerPhone}</div>
            </div>
            <div class="detail">
              <div class="label">Reason for Escalation:</div>
              <div>${reason || 'Not provided'}</div>
            </div>
            <div class="detail">
              <div class="label">Time:</div>
              <div>${formattedTime}</div>
            </div>
            <p style="margin-top: 20px;">
              The customer is waiting for a response. Please check your WhatsApp inbox to continue the conversation.
            </p>
            <a href="${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/inbox" class="action-button">
              View in Inbox →
            </a>
          </div>
          <div class="footer">
            <p>This is an automated notification from ${businessName} WhatsApp Agent.</p>
            <p>To manage notification settings, visit your <a href="${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/settings">Settings page</a>.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const textBody = `
New Support Escalation

A customer has requested to speak with support:

Customer Name: ${customerName || 'Not provided'}
Phone Number: ${customerPhone}
Reason: ${reason || 'Not provided'}
Time: ${formattedTime}

The customer is waiting for a response. Please check your WhatsApp inbox to continue the conversation.

View in inbox: ${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/inbox

---
This is an automated notification from ${businessName} WhatsApp Agent.
To manage notification settings, visit: ${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/settings
    `.trim();

    // Send the email
    const info = await transporter.sendMail({
      from: `"${businessName}" <${fromEmail}>`,
      to: notificationEmail,
      subject,
      text: textBody,
      html: htmlBody,
    });

    console.log('[Email] Escalation notification sent:', info.messageId);
    return { success: true, messageId: info.messageId };

  } catch (error) {
    console.error('[Email] Failed to send escalation notification:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send booking confirmation email to account owner
 * @param {string} userId - The Clerk user ID (account owner)
 * @param {Object} bookingData - Data about the booking
 * @param {string} bookingData.customerName - Name of the customer
 * @param {string} bookingData.customerPhone - Phone number of the customer
 * @param {string} bookingData.startTime - Appointment start time (ISO string)
 * @param {string} bookingData.endTime - Appointment end time (ISO string)
 * @param {string} bookingData.notes - Booking notes/answers
 * @param {number} bookingData.appointmentId - Appointment ID
 * @param {string} bookingData.staffName - Staff member name
 */
export async function sendBookingNotification(userId, bookingData) {
  try {
    // Check if email notifications are enabled for this user
    const settings = getSettingsForUser(userId);
    if (!settings?.escalation_email_enabled) {
      console.log('[Email] Email notifications disabled for user:', userId);
      return { success: false, reason: 'disabled' };
    }

    // Get the notification email (either custom or from Clerk account)
    let notificationEmail = settings?.escalation_email;
    
    // If no custom email set, try to get from Clerk account
    if (!notificationEmail) {
      try {
        const user = await clerkClient.users.getUser(userId);
        const primaryId = user.primaryEmailAddressId;
        notificationEmail = user.emailAddresses?.find(e => e.id === primaryId)?.emailAddress;
        if (!notificationEmail) {
          notificationEmail = user.emailAddresses?.[0]?.emailAddress;
        }
      } catch (e) {
        console.error('[Email] Failed to retrieve user email from Clerk:', e.message);
      }
    }

    if (!notificationEmail) {
      console.warn('[Email] No notification email configured for user:', userId);
      return { success: false, reason: 'no_email' };
    }

    const transporter = createTransporter(settings);
    if (!transporter) {
      return { success: false, reason: 'no_smtp_config' };
    }
    
    // Determine the "from" email address
    const fromEmail = settings?.smtp_user || process.env.SMTP_USER;

    // Format the email
    const { customerName, customerPhone, startTime, endTime, notes, appointmentId, staffName } = bookingData;
    const businessName = settings?.business_name || 'Your Business';
    const formattedStart = new Date(startTime).toLocaleString();
    const formattedEnd = new Date(endTime).toLocaleTimeString();

    const subject = `📅 New Booking: ${customerName || customerPhone} - ${formattedStart}`;
    
    const htmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #10b981; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
          .content { background: #f9f9f9; padding: 20px; border-radius: 0 0 5px 5px; }
          .detail { margin: 10px 0; padding: 10px; background: white; border-left: 4px solid #10b981; }
          .label { font-weight: bold; color: #10b981; }
          .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; font-size: 12px; }
          .action-button { display: inline-block; margin-top: 15px; padding: 12px 24px; background: #10b981; color: white; text-decoration: none; border-radius: 5px; }
          .calendar-icon { font-size: 48px; margin-bottom: 10px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="calendar-icon">📅</div>
            <h2>New Booking Confirmed</h2>
            <p style="margin: 0;">A customer has booked an appointment</p>
          </div>
          <div class="content">
            <div class="detail">
              <div class="label">Appointment ID:</div>
              <div>#${appointmentId}</div>
            </div>
            <div class="detail">
              <div class="label">Customer Name:</div>
              <div>${customerName || 'Not provided'}</div>
            </div>
            <div class="detail">
              <div class="label">Phone Number:</div>
              <div>${customerPhone}</div>
            </div>
            <div class="detail">
              <div class="label">Start Time:</div>
              <div>${formattedStart}</div>
            </div>
            <div class="detail">
              <div class="label">End Time:</div>
              <div>${formattedEnd}</div>
            </div>
            ${staffName ? `
            <div class="detail">
              <div class="label">Staff Member:</div>
              <div>${staffName}</div>
            </div>
            ` : ''}
            ${notes ? `
            <div class="detail">
              <div class="label">Details:</div>
              <div>${notes.replace(/\|/g, '<br>')}</div>
            </div>
            ` : ''}
            <a href="${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/dashboard" class="action-button">
              View Dashboard →
            </a>
          </div>
          <div class="footer">
            <p>This is an automated notification from ${businessName} WhatsApp Agent.</p>
            <p>To manage notification settings, visit your <a href="${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/settings">Settings page</a>.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const textBody = `
New Booking Confirmed

A customer has booked an appointment:

Appointment ID: #${appointmentId}
Customer Name: ${customerName || 'Not provided'}
Phone Number: ${customerPhone}
Start Time: ${formattedStart}
End Time: ${formattedEnd}
${staffName ? `Staff Member: ${staffName}` : ''}
${notes ? `Details: ${notes}` : ''}

View dashboard: ${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/dashboard

---
This is an automated notification from ${businessName} WhatsApp Agent.
To manage notification settings, visit: ${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/settings
    `.trim();

    // Send the email
    const info = await transporter.sendMail({
      from: `"${businessName}" <${fromEmail}>`,
      to: notificationEmail,
      subject,
      text: textBody,
      html: htmlBody,
    });

    console.log('[Email] Booking notification sent:', info.messageId);
    return { success: true, messageId: info.messageId };

  } catch (error) {
    console.error('[Email] Failed to send booking notification:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Test email configuration by sending a test email
 * @param {string} toEmail - Email address to send test to
 */
export async function sendTestEmail(toEmail) {
  try {
    const transporter = createTransporter();
    if (!transporter) {
      return { success: false, error: 'SMTP not configured' };
    }

    const info = await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: toEmail,
      subject: 'Test Email from WhatsApp Agent',
      text: 'This is a test email to verify your email configuration is working correctly.',
      html: '<p>This is a test email to verify your email configuration is working correctly.</p>',
    });

    console.log('[Email] Test email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('[Email] Test email failed:', error.message);
    return { success: false, error: error.message };
  }
}

