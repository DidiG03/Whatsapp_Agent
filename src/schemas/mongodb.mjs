

import mongoose from 'mongoose';
import { logHelpers } from '../monitoring/logger.mjs';
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
const messageReactionSchema = new mongoose.Schema({
  message_id: { type: String, required: true },
  user_id: { type: String, required: true },
  emoji: { type: String, required: true }
}, {
  timestamps: true,
  collection: 'message_reactions'
});
const messageReplySchema = new mongoose.Schema({
  original_message_id: { type: String, required: true },
  reply_message_id: { type: String, required: true }
}, {
  timestamps: true,
  collection: 'message_replies'
});
const kbItemSchema = new mongoose.Schema({
  title: String,
  content: { type: String, required: true },
  user_id: String,
  file_url: String,
  file_mime: String,
  file_id: String,
  file_text: String,
  show_in_menu: { type: Boolean, default: false },
  embedding: { type: [Number], default: undefined },
  embedding_model: String,
  embedding_updated_at: Date,
}, {
  timestamps: true,
  collection: 'kb_items'
});
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
const settingsMultiSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  name: String,
  phone_number_id: String,
  waba_id: String,
  whatsapp_token: String,
  verify_token: String,
  app_secret: String,
  business_phone: String,
  business_name: String,
  business_type: String,
  business_categories_json: String,
  website_url: String,
  business_address: String,
  business_latitude: Number,
  business_longitude: Number,
  business_place_id: String,
  google_business_json: String,
  ai_tone: String,
  ai_blocked_topics: String,
  ai_style: String,
  conversation_mode: { type: String, enum: ['full', 'escalation'], default: 'full' },
  entry_greeting: String,
  bookings_enabled: { type: Boolean, default: false },
  booking_questions_json: String,
  booking_fields_json: String,
  reschedule_min_lead_minutes: { type: Number, default: 60 },
  cancel_min_lead_minutes: { type: Number, default: 60 },
  reminders_enabled: { type: Boolean, default: false },
  reminder_windows: String,
  wa_template_name: String,
  wa_template_language: String,
  escalation_email_enabled: { type: Boolean, default: false },
  escalation_email: String,
  escalation_additional_message: String,
  escalation_out_of_hours_message: String,
  escalation_questions_json: String,
  holidays_json_url: String,
  closed_dates_json: String,
  holidays_rules_json: String,
  booking_max_per_day: { type: Number, default: 0 },
  booking_days_ahead: { type: Number, default: 60 },
  booking_display_interval_minutes: { type: Number, default: 30 },
  booking_capacity_window_minutes: { type: Number, default: 60 },
  booking_capacity_limit: { type: Number, default: 0 },
  services_json: String,
  waitlist_enabled: { type: Boolean, default: false },
  staff_whatsapp_group_id: String,
  staff_whatsapp_group_enabled: { type: Boolean, default: false },
  smtp_host: String,
  smtp_port: { type: Number, default: 587 },
  smtp_secure: { type: Boolean, default: false },
  smtp_user: String,
  smtp_pass: String,
  dashboard_preferences: String,
  ai_refining_rules: String,
  ai_refining_enforced_json: String,
  refining_transcript: String
}, {
  timestamps: true,
  collection: 'settings_multi'
});
const onboardingStateSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  step: { type: Number, default: 0 },
  transcript: { type: String, default: '' }
}, {
  timestamps: true,
  collection: 'onboarding_state'
});
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
const appointmentSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  id: { type: Number, index: true },
  staff_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  contact_phone: String,
  start_ts: { type: Number, required: true },
  end_ts: { type: Number, required: true },
  gcal_event_id: String,
  source: { type: String, default: 'local' },
  status: { type: String, default: 'confirmed' },
  notes: String,
  notify_24h_sent: { type: Boolean, default: false },
  notify_4h_sent: { type: Boolean, default: false },
  notify_2h_sent: { type: Boolean, default: false }
}, {
  timestamps: true,
  collection: 'appointments'
});
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
const contactStateSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  contact_id: { type: String, required: true },
  last_greet_ts: Number
}, {
  timestamps: true,
  collection: 'contact_state'
});
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
const contactTagSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  name: { type: String, required: true },
  color: { type: String, default: '#3B82F6' },
  description: String
}, {
  timestamps: true,
  collection: 'contact_tags'
});
const contactInteractionSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  contact_id: { type: String, required: true },
  interaction_type: { type: String, required: true },
  interaction_data: String
}, {
  timestamps: true,
  collection: 'contact_interactions'
});
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
const usageStatsSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  month_year: { type: String, required: true },
  inbound_messages: { type: Number, default: 0 },
  outbound_messages: { type: Number, default: 0 },
  template_messages: { type: Number, default: 0 },
  payg_charged_units: { type: Number, default: 0 },
  payg_charged_cents: { type: Number, default: 0 }
}, {
  timestamps: true,
  collection: 'usage_stats'
});
const userPlanSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  plan_name: { type: String, default: 'free' },
  status: { type: String, default: 'active' },
  monthly_limit: { type: Number, default: 100 },
  whatsapp_numbers: { type: Number, default: 1 },
  billing_cycle_start: Number,
  stripe_customer_id: String,
  stripe_subscription_id: String,
  payg_enabled: { type: Boolean, default: false },
  payg_rate_cents: { type: Number, default: function() {
    try { return Number(process.env.PAYG_RATE_CENTS || 5); } catch { return 5; }
  } },
  payg_currency: { type: String, default: function() {
    return String(process.env.PAYG_CURRENCY || 'usd').toLowerCase();
  } }
}, {
  timestamps: true,
  collection: 'user_plans'
});
const quickReplySchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  text: { type: String, required: true },
  category: { type: String, default: 'General' },
  display_order: { type: Number, default: 0 }
}, {
  timestamps: true,
  collection: 'quick_replies'
});
const guideSchema = new mongoose.Schema({
  slug: { type: String, unique: true },
  title: { type: String, required: true },
  summary: String,
  content: { type: String, required: true }
}, {
  timestamps: true,
  collection: 'guides'
});
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
const settingsAuditSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  actor_id: { type: String, default: null },
  actor_email: { type: String, default: null },
  ip: { type: String, default: null },
  user_agent: { type: String, default: null },
  denied_fields: { type: [String], default: [] },
  changes: {
    type: [{
      field: { type: String, required: true },
      before: mongoose.Schema.Types.Mixed,
      after: mongoose.Schema.Types.Mixed
    }],
    default: []
  }
}, {
  timestamps: true,
  collection: 'settings_audit'
});
const createIndexes = async () => {
  try {
    await Message.collection.createIndex({ user_id: 1, timestamp: -1 });
    await Message.collection.createIndex({ from_digits: 1 });
    await Message.collection.createIndex({ to_digits: 1 });
    await Message.collection.createIndex({ direction: 1 });
    await Message.collection.createIndex({ user_id: 1, from_digits: 1 }, { name: 'user_from_digits' });
    await MessageStatus.collection.createIndex({ message_id: 1, status: 1, timestamp: 1, user_id: 1 }, { unique: true, name: 'uniq_message_status_event' });
    await MessageStatus.collection.createIndex({ user_id: 1, message_id: 1 });
    try {
      const statusTtlDays = Number(process.env.MESSAGE_STATUS_TTL_DAYS || 30);
      if (statusTtlDays > 0) {
        await MessageStatus.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: statusTtlDays * 86400, name: 'ttl_message_status_createdAt' });
      }
    } catch {}
    await MessageReaction.collection.createIndex({ message_id: 1, user_id: 1, emoji: 1 }, { unique: true, name: 'uniq_message_reaction' });
    await MessageReaction.collection.createIndex({ user_id: 1 });
    await KBItem.collection.createIndex({ user_id: 1 });
    await KBItem.collection.createIndex({ title: 1 });
    await Handoff.collection.createIndex({ contact_id: 1, user_id: 1 }, { unique: true });
    await Handoff.collection.createIndex({ user_id: 1, conversation_status: 1 });
    await Handoff.collection.createIndex({ user_id: 1, contact_id: 1 }, { name: 'user_contact' });
    await AIRequest.collection.createIndex({ user_id: 1 });
    await AIRequest.collection.createIndex({ createdAt: -1 });
    await Customer.collection.createIndex({ user_id: 1, contact_id: 1 }, { unique: true });
    await Customer.collection.createIndex({ user_id: 1, email: 1 });
    await Customer.collection.createIndex({ user_id: 1, status: 1 });
    await Notification.collection.createIndex({ user_id: 1 });
    await Notification.collection.createIndex({ user_id: 1, is_read: 1 });
    await UsageStats.collection.createIndex({ user_id: 1, month_year: 1 }, { unique: true });
    try {
      const sessionTtlHours = Number(process.env.BOOKING_SESSION_TTL_HOURS || 24);
      if (sessionTtlHours > 0) {
        await BookingSession.collection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: sessionTtlHours * 3600, name: 'ttl_booking_sessions_updatedAt' });
      }
    } catch {}
    await Appointment.collection.createIndex({ user_id: 1, contact_phone: 1, start_ts: 1 }, { name: 'user_phone_startTs' });
    try {
      const { backfillAppointmentLegacyIds } = await import('../services/booking.mjs');
      const fixed = await backfillAppointmentLegacyIds();
      if (fixed > 0) console.log(`Backfilled legacy appointment ids for ${fixed} document(s)`);
    } catch (backfillError) {
      logHelpers.logError(backfillError, { component: 'mongodb', operation: 'backfill_appointment_ids' });
    }
    try {
      await Appointment.collection.dropIndex('user_legacy_appt_id');
    } catch {}
    await Appointment.collection.createIndex(
      { user_id: 1, id: 1 },
      {
        name: 'user_legacy_appt_id',
        unique: true,
        partialFilterExpression: { id: { $type: 'number', $gt: 0 } },
      }
    );
    try {
      await SettingsMulti.collection.createIndex(
        { phone_number_id: 1 },
        {
          name: 'uniq_settings_phone_number_id',
          unique: true,
          partialFilterExpression: { phone_number_id: { $type: 'string', $gt: '' } },
        }
      );
    } catch (phoneIdxError) {
      logHelpers.logError(phoneIdxError, { component: 'mongodb', operation: 'create_phone_number_id_index' });
    }
    await SettingsAudit.collection.createIndex({ user_id: 1, createdAt: -1 }, { name: 'settings_audit_user' });
    try {
      await mongoose.connection.collection('stripe_checkout_sessions').createIndex(
        { session_id: 1 },
        { unique: true, name: 'stripe_checkout_session_id' }
      );
    } catch {}

    console.log('MongoDB indexes created successfully');
  } catch (error) {
    logHelpers.logError(error, { component: 'mongodb', operation: 'create_indexes' });
  }
};
export const Message = mongoose.model('Message', messageSchema);
export const MessageStatus = mongoose.model('MessageStatus', messageStatusSchema);
export const MessageReaction = mongoose.model('MessageReaction', messageReactionSchema);
export const MessageReply = mongoose.model('MessageReply', messageReplySchema);
export const KBItem = mongoose.model('KBItem', kbItemSchema);
export const Handoff = mongoose.model('Handoff', handoffSchema);
export const AIRequest = mongoose.model('AIRequest', aiRequestSchema);
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
export const SettingsAudit = mongoose.model('SettingsAudit', settingsAuditSchema);
export { createIndexes };

export default {
  Message,
  MessageStatus,
  MessageReaction,
  MessageReply,
  KBItem,
  Handoff,
  AIRequest,
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
  Enquiry,
  SettingsAudit
};
