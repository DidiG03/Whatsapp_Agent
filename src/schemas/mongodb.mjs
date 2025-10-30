/**
 * MongoDB Schemas and Models
 * Defines all database collections and their schemas for the WhatsApp Agent
 */

import mongoose from 'mongoose';
import { logHelpers } from '../monitoring/logger.mjs';

// Message Schema
const messageSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  direction: { type: String, required: true, enum: ['inbound', 'outbound'] },
  from_id: String,
  to_id: String,
  from_digits: String,
  to_digits: String,
  type: String,
  text_body: String,
  timestamp: Number,
  user_id: String,
  raw: mongoose.Schema.Types.Mixed,
  delivery_status: { type: String, default: 'sent' }
}, {
  timestamps: true,
  collection: 'messages'
});

// Message Status Schema
const messageStatusSchema = new mongoose.Schema({
  message_id: { type: String, required: true },
  status: { type: String, required: true },
  recipient_id: String,
  timestamp: Number,
  error_code: Number,
  error_title: String,
  error_message: String,
  user_id: String
}, {
  timestamps: true,
  collection: 'message_statuses'
});

// Message Reactions Schema
const messageReactionSchema = new mongoose.Schema({
  message_id: { type: String, required: true },
  user_id: { type: String, required: true },
  emoji: { type: String, required: true }
}, {
  timestamps: true,
  collection: 'message_reactions'
});

// Message Replies Schema
const messageReplySchema = new mongoose.Schema({
  original_message_id: { type: String, required: true },
  reply_message_id: { type: String, required: true }
}, {
  timestamps: true,
  collection: 'message_replies'
});

// Knowledge Base Schema
const kbItemSchema = new mongoose.Schema({
  title: String,
  content: { type: String, required: true },
  user_id: String,
  file_url: String,
  file_mime: String,
  show_in_menu: { type: Boolean, default: false }
}, {
  timestamps: true,
  collection: 'kb_items'
});

// Handoff Schema
const handoffSchema = new mongoose.Schema({
  contact_id: String,
  user_id: String,
  is_human: { type: Boolean, default: false },
  conversation_status: { 
    type: String, 
    enum: ['new', 'in_progress', 'resolved'],
    default: 'new'
  },
  is_archived: { type: Boolean, default: false },
  deleted_at: Number,
  last_seen_ts: { type: Number, default: 0 },
  escalation_step: String,
  escalation_reason: String,
  escalation_questions_json: String,
  escalation_question_index: { type: Number, default: 0 },
  escalation_answers_json: String,
  human_expires_ts: { type: Number, default: 0 }
}, {
  timestamps: true,
  collection: 'handoff'
});

// AI Requests Schema
const aiRequestSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  success: { type: Boolean, default: true },
  response_time: Number,
  model: { type: String, default: 'gpt-3.5-turbo' },
  tokens_used: Number
}, {
  timestamps: true,
  collection: 'ai_requests'
});

// User Settings Schema
const userSettingsSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  dashboard_preferences: String
}, {
  timestamps: true,
  collection: 'user_settings'
});

// Settings Multi Schema
const settingsMultiSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  name: String,
  phone_number_id: String,
  whatsapp_token: String,
  verify_token: String,
  app_secret: String,
  business_phone: String,
  business_name: String,
  website_url: String,
  ai_tone: String,
  ai_blocked_topics: String,
  ai_style: String,
  conversation_mode: { type: String, enum: ['full', 'escalation'], default: 'full' },
  entry_greeting: String,
  bookings_enabled: { type: Boolean, default: false },
  booking_questions_json: String,
  reschedule_min_lead_minutes: { type: Number, default: 60 },
  cancel_min_lead_minutes: { type: Number, default: 60 },
  reminders_enabled: { type: Boolean, default: false },
  reminder_windows: String,
  wa_template_name: String,
  wa_template_language: String,
  escalation_email_enabled: { type: Boolean, default: false },
  escalation_email: String,
  smtp_host: String,
  smtp_port: { type: Number, default: 587 },
  smtp_secure: { type: Boolean, default: false },
  smtp_user: String,
  smtp_pass: String
}, {
  timestamps: true,
  collection: 'settings_multi'
});

// Onboarding State Schema
const onboardingStateSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  step: { type: Number, default: 0 },
  transcript: { type: String, default: '' }
}, {
  timestamps: true,
  collection: 'onboarding_state'
});

// Calendar Schema
const calendarSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  provider: { type: String, default: 'google' },
  account_email: String,
  calendar_id: String,
  refresh_token: String,
  access_token: String,
  token_expiry: Number,
  timezone: String,
  display_name: String
}, {
  timestamps: true,
  collection: 'calendars'
});

// Staff Schema
const staffSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  name: { type: String, required: true },
  calendar_id: mongoose.Schema.Types.ObjectId,
  timezone: String,
  slot_minutes: { type: Number, default: 30 },
  working_hours_json: String
}, {
  timestamps: true,
  collection: 'staff'
});

// Appointment Schema
const appointmentSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  staff_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  contact_phone: String,
  start_ts: { type: Number, required: true },
  end_ts: { type: Number, required: true },
  gcal_event_id: String,
  status: { type: String, default: 'confirmed' },
  notes: String,
  notify_24h_sent: { type: Boolean, default: false },
  notify_4h_sent: { type: Boolean, default: false },
  notify_2h_sent: { type: Boolean, default: false }
}, {
  timestamps: true,
  collection: 'appointments'
});

// Booking Session Schema
const bookingSessionSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  contact_id: { type: String, required: true },
  staff_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  start_iso: { type: String, required: true },
  end_iso: { type: String, required: true },
  step: { type: String, default: 'pending' },
  question_index: { type: Number, default: 0 },
  answers_json: String
}, {
  timestamps: true,
  collection: 'booking_sessions'
});

// Contact State Schema
const contactStateSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  contact_id: { type: String, required: true },
  last_greet_ts: Number
}, {
  timestamps: true,
  collection: 'contact_state'
});

// Customer Schema
const customerSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  contact_id: { type: String, required: true },
  display_name: { type: String, required: true },
  notes: String,
  first_name: String,
  last_name: String,
  email: String,
  company: String,
  job_title: String,
  profile_photo_url: String,
  phone_alternative: String,
  address: String,
  city: String,
  state: String,
  country: String,
  postal_code: String,
  website: String,
  social_media: String,
  custom_fields: mongoose.Schema.Types.Mixed,
  tags: [String],
  status: { type: String, default: 'active' },
  opted_out: { type: Boolean, default: false },
  blocked_until_ts: { type: Number, default: 0 },
  source: String,
  last_contacted: Number,
  total_messages: { type: Number, default: 0 }
}, {
  timestamps: true,
  collection: 'customers'
});

// Contact Tags Schema
const contactTagSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  name: { type: String, required: true },
  color: { type: String, default: '#3B82F6' },
  description: String
}, {
  timestamps: true,
  collection: 'contact_tags'
});

// Contact Interactions Schema
const contactInteractionSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  contact_id: { type: String, required: true },
  interaction_type: { type: String, required: true },
  interaction_data: String
}, {
  timestamps: true,
  collection: 'contact_interactions'
});

// Notifications Schema
const notificationSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  type: { type: String, required: true },
  title: { type: String, required: true },
  message: String,
  link: String,
  is_read: { type: Boolean, default: false },
  metadata: mongoose.Schema.Types.Mixed
}, {
  timestamps: true,
  collection: 'notifications'
});

// Usage Stats Schema
const usageStatsSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  month_year: { type: String, required: true },
  inbound_messages: { type: Number, default: 0 },
  outbound_messages: { type: Number, default: 0 },
  template_messages: { type: Number, default: 0 }
}, {
  timestamps: true,
  collection: 'usage_stats'
});

// User Plans Schema
const userPlanSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  plan_name: { type: String, default: 'free' },
  status: { type: String, default: 'active' },
  monthly_limit: { type: Number, default: 100 },
  whatsapp_numbers: { type: Number, default: 1 },
  billing_cycle_start: Number,
  stripe_customer_id: String,
  stripe_subscription_id: String
}, {
  timestamps: true,
  collection: 'user_plans'
});

// Quick Replies Schema
const quickReplySchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  text: { type: String, required: true },
  category: { type: String, default: 'General' },
  display_order: { type: Number, default: 0 }
}, {
  timestamps: true,
  collection: 'quick_replies'
});

// Guides Schema
const guideSchema = new mongoose.Schema({
  slug: { type: String, unique: true },
  title: { type: String, required: true },
  summary: String,
  content: { type: String, required: true }
}, {
  timestamps: true,
  collection: 'guides'
});

// Enquiries Schema
const enquirySchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  subject: { type: String, required: true },
  message: { type: String, required: true },
  status: { type: String, default: 'new' }
}, {
  timestamps: true,
  collection: 'enquiries'
});

// Create indexes for better performance
const createIndexes = async () => {
  try {
    // Messages indexes
    await Message.collection.createIndex({ user_id: 1, timestamp: -1 });
    await Message.collection.createIndex({ from_digits: 1 });
    await Message.collection.createIndex({ to_digits: 1 });
    await Message.collection.createIndex({ direction: 1 });

    // Message statuses indexes + TTL
    await MessageStatus.collection.createIndex({ message_id: 1, status: 1, timestamp: 1, user_id: 1 }, { unique: true, name: 'uniq_message_status_event' });
    await MessageStatus.collection.createIndex({ user_id: 1, message_id: 1 });
    try {
      const statusTtlDays = Number(process.env.MESSAGE_STATUS_TTL_DAYS || 30);
      if (statusTtlDays > 0) {
        await MessageStatus.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: statusTtlDays * 86400, name: 'ttl_message_status_createdAt' });
      }
    } catch {}

    // Message reactions indexes
    await MessageReaction.collection.createIndex({ message_id: 1, user_id: 1, emoji: 1 }, { unique: true, name: 'uniq_message_reaction' });
    await MessageReaction.collection.createIndex({ user_id: 1 });

    // KB items indexes
    await KBItem.collection.createIndex({ user_id: 1 });
    await KBItem.collection.createIndex({ title: 1 });

    // Handoff indexes
    await Handoff.collection.createIndex({ contact_id: 1, user_id: 1 }, { unique: true });
    await Handoff.collection.createIndex({ user_id: 1, conversation_status: 1 });

    // AI requests indexes
    await AIRequest.collection.createIndex({ user_id: 1 });
    await AIRequest.collection.createIndex({ createdAt: -1 });

    // Customer indexes
    await Customer.collection.createIndex({ user_id: 1, contact_id: 1 }, { unique: true });
    await Customer.collection.createIndex({ user_id: 1, email: 1 });
    await Customer.collection.createIndex({ user_id: 1, status: 1 });

    // Notification indexes
    await Notification.collection.createIndex({ user_id: 1 });
    await Notification.collection.createIndex({ user_id: 1, is_read: 1 });

    // Usage stats indexes
    await UsageStats.collection.createIndex({ user_id: 1, month_year: 1 }, { unique: true });

    // Booking sessions TTL cleanup
    try {
      const sessionTtlHours = Number(process.env.BOOKING_SESSION_TTL_HOURS || 24);
      if (sessionTtlHours > 0) {
        await BookingSession.collection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: sessionTtlHours * 3600, name: 'ttl_booking_sessions_updatedAt' });
      }
    } catch {}

    console.log('MongoDB indexes created successfully');
  } catch (error) {
    logHelpers.logError(error, { component: 'mongodb', operation: 'create_indexes' });
  }
};

// Export models
export const Message = mongoose.model('Message', messageSchema);
export const MessageStatus = mongoose.model('MessageStatus', messageStatusSchema);
export const MessageReaction = mongoose.model('MessageReaction', messageReactionSchema);
export const MessageReply = mongoose.model('MessageReply', messageReplySchema);
export const KBItem = mongoose.model('KBItem', kbItemSchema);
export const Handoff = mongoose.model('Handoff', handoffSchema);
export const AIRequest = mongoose.model('AIRequest', aiRequestSchema);
export const UserSettings = mongoose.model('UserSettings', userSettingsSchema);
export const SettingsMulti = mongoose.model('SettingsMulti', settingsMultiSchema);
export const OnboardingState = mongoose.model('OnboardingState', onboardingStateSchema);
export const Calendar = mongoose.model('Calendar', calendarSchema);
export const Staff = mongoose.model('Staff', staffSchema);
export const Appointment = mongoose.model('Appointment', appointmentSchema);
export const BookingSession = mongoose.model('BookingSession', bookingSessionSchema);
export const ContactState = mongoose.model('ContactState', contactStateSchema);
export const Customer = mongoose.model('Customer', customerSchema);
export const ContactTag = mongoose.model('ContactTag', contactTagSchema);
export const ContactInteraction = mongoose.model('ContactInteraction', contactInteractionSchema);
export const Notification = mongoose.model('Notification', notificationSchema);
export const UsageStats = mongoose.model('UsageStats', usageStatsSchema);
export const UserPlan = mongoose.model('UserPlan', userPlanSchema);
export const QuickReply = mongoose.model('QuickReply', quickReplySchema);
export const Guide = mongoose.model('Guide', guideSchema);
export const Enquiry = mongoose.model('Enquiry', enquirySchema);

// Initialize indexes when module loads
createIndexes();

export default {
  Message,
  MessageStatus,
  MessageReaction,
  MessageReply,
  KBItem,
  Handoff,
  AIRequest,
  UserSettings,
  SettingsMulti,
  OnboardingState,
  Calendar,
  Staff,
  Appointment,
  BookingSession,
  ContactState,
  Customer,
  ContactTag,
  ContactInteraction,
  Notification,
  UsageStats,
  UserPlan,
  QuickReply,
  Guide,
  Enquiry
};
