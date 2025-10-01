# Booking Notifications

This document describes the booking notification system that sends both email and web notifications when customers book appointments.

## Features

- 📅 **Email Notifications**: Beautiful HTML emails sent when bookings are created
- 🔔 **Web Notifications**: Real-time bell icon notifications in the navbar
- 🎨 **Professional Design**: Green-themed booking emails distinct from escalation (red) emails
- 📱 **Multi-Channel**: Works for both WhatsApp bookings and admin-created bookings
- 🔄 **Automatic**: No manual intervention required

## When Notifications Are Sent

Notifications are triggered when:
1. **Customer books via WhatsApp**: After completing the booking flow and answering all questions
2. **Admin creates booking**: When an appointment is created via the `/booking/create` API endpoint

## Notification Content

### Email Notification

The email includes:
- **Subject**: `📅 New Booking: [Customer Name] - [Start Time]`
- **Appointment ID**: Reference number
- **Customer Name**: From booking answers or phone number
- **Phone Number**: Customer's WhatsApp number
- **Start Time**: Formatted date and time
- **End Time**: Formatted time
- **Staff Member**: Name of assigned staff (if available)
- **Details**: All Q&A pairs from booking flow
- **Action Button**: Link to dashboard

**Visual Design:**
- Green header (#10b981) to distinguish from escalation emails (red)
- Calendar icon (📅)
- Structured detail sections with left border
- Responsive HTML layout

### Web Notification

The notification shows:
- **Title**: "New Booking Confirmed"
- **Message**: `[Customer Name] booked an appointment for [Time] (Ref #[ID])`
- **Link**: Clicking opens the Dashboard
- **Badge**: Bell icon shows unread count
- **Type**: `booking` (for potential filtering)

## Email Template Example

```
┌─────────────────────────────────────┐
│ 📅                                  │
│ New Booking Confirmed               │
│ A customer has booked an appointment│
├─────────────────────────────────────┤
│ Appointment ID: #123                │
│ Customer Name: John Doe             │
│ Phone Number: +1234567890           │
│ Start Time: 1/15/2025, 2:00 PM      │
│ End Time: 2:30 PM                   │
│ Staff Member: Dr. Smith             │
│ Details:                            │
│   What's your name?: John Doe       │
│   Reason for booking?: Consultation │
│                                     │
│ [View Dashboard →]                  │
└─────────────────────────────────────┘
```

## Files Modified

### Email Service
- **File**: `src/services/email.mjs`
- **Function**: `sendBookingNotification(userId, bookingData)`
- **Purpose**: Sends booking confirmation emails

### Webhook Handler
- **File**: `src/routes/webhook.mjs`
- **Location**: After `createBooking()` call (line ~879)
- **Actions**:
  1. Retrieves staff name from database
  2. Sends email notification
  3. Creates web notification in database

### Booking API
- **File**: `src/routes/booking.mjs`
- **Endpoint**: `POST /booking/create`
- **Actions**:
  1. Creates booking
  2. Sends email notification
  3. Creates web notification

## Configuration

### Email Notifications
Email notifications use the same settings as escalation emails:
- **Toggle**: Settings → Email Notifications → "Send email when customer escalates to support"
- **Email Address**: Custom or account email
- **SMTP Settings**: Configured per-user in Settings

**Note**: Currently shares the escalation toggle. Consider adding a separate "booking notifications" toggle in future updates.

### Web Notifications
- Automatically enabled for all users
- No configuration needed
- Shows in navbar bell icon
- Auto-refreshes every 30 seconds

## Data Structure

### Email Notification Data
```javascript
{
  customerName: string,      // Customer's name or phone
  customerPhone: string,      // WhatsApp number
  startTime: string,          // ISO datetime
  endTime: string,            // ISO datetime
  notes: string,              // Q&A pairs joined
  appointmentId: number,      // Booking ID
  staffName: string | null    // Assigned staff
}
```

### Web Notification Data
```javascript
{
  user_id: string,           // Account owner
  type: 'booking',
  title: 'New Booking Confirmed',
  message: string,           // Summary with customer & time
  link: '/dashboard',
  metadata: {
    contact_phone: string,
    appointment_id: number,
    start_time: string,      // ISO datetime
    customer_name: string
  }
}
```

## Testing

### Test via WhatsApp
1. Ensure bookings are enabled in Settings
2. Add a staff member
3. From WhatsApp, send "book" or "booking"
4. Follow the booking flow
5. Complete all questions
6. Check for:
   - ✅ WhatsApp confirmation message
   - ✅ Email in inbox
   - ✅ Bell icon notification badge
   - ✅ Notification in dropdown

### Test via Admin
1. Make a POST request to `/booking/create`
2. Provide: `staff_id`, `start`, `end`, `contact_phone`, `notes`
3. Check for:
   - ✅ Successful response with booking ID
   - ✅ Email in inbox
   - ✅ Bell icon notification badge

## Troubleshooting

### Email Not Received
- Check SMTP configuration in Settings
- Verify "Send email when customer escalates to support" is checked
- Check server logs for `[Email]` or `[Booking API]` errors
- Ensure SMTP credentials are correct

### Web Notification Not Showing
- Check browser console for errors
- Verify `notifications.js` is loaded
- Check database for notification entry:
  ```sql
  SELECT * FROM notifications WHERE user_id = '[your_user_id]' ORDER BY created_at DESC LIMIT 5;
  ```
- Try refreshing the page
- Wait 30 seconds for auto-refresh

### Notification Shows Wrong Info
- Check booking answers in database
- Verify Q&A order in Settings → Booking Questions
- First answer is typically used as customer name

## Future Enhancements

Potential improvements:
- [ ] Separate toggle for booking vs escalation email notifications
- [ ] SMS notifications via Twilio
- [ ] Notification preferences (email only, web only, both)
- [ ] Booking reminder emails (24h, 1h before)
- [ ] Cancellation notifications
- [ ] Rescheduling notifications
- [ ] Email templates customization in UI
- [ ] Calendar event attachments in emails
- [ ] Multiple notification recipients
- [ ] Slack/Discord webhook integrations

## Security

- ✅ Only sends to account owner (user_id scoped)
- ✅ Requires authentication for API endpoints
- ✅ SMTP credentials stored per-user
- ✅ XSS prevention in web notifications
- ✅ No sensitive data in notification metadata

## Performance

- Email sending is async (doesn't block booking confirmation)
- Failures are logged but don't prevent booking
- Database writes are wrapped in try-catch
- Notifications cached in memory (frontend)
- Auto-refresh interval: 30 seconds

## Support

For issues or questions:
1. Check server logs for detailed error messages
2. Verify all prerequisites are configured
3. Test with a simple booking first
4. Review notification settings in database

