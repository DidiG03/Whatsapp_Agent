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
  // Optional GridFS id when file is stored inside MongoDB
  file_id: String,
  // Optional extracted/plaintext content for retrieval (e.g., from PDF/TXT)
  file_text: String,
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

// NOTE: Previously there was a separate `user_settings` collection that only
// stored `dashboard_preferences`. To reduce collections, we now store this
// field inside `settings_multi`.

// Settings Multi Schema
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
  // High-level business classification (e.g., restaurant, retail, healthcare)
  business_type: String,
  // JSON string of categories/tags for the business (array of strings)
  business_categories_json: String,
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
  // Escalation mode messages and questions
  escalation_additional_message: String,
  escalation_out_of_hours_message: String,
  escalation_questions_json: String,
  // Holidays and closures
  holidays_json_url: String,
  closed_dates_json: String,
  holidays_rules_json: String,
  // Advanced booking controls
  booking_max_per_day: { type: Number, default: 0 },
  booking_days_ahead: { type: Number, default: 60 },
  booking_display_interval_minutes: { type: Number, default: 30 },
  booking_capacity_window_minutes: { type: Number, default: 60 },
  booking_capacity_limit: { type: Number, default: 0 },
  // Services and waitlist
  services_json: String,
  waitlist_enabled: { type: Boolean, default: false },
  smtp_host: String,
  smtp_port: { type: Number, default: 587 },
  smtp_secure: { type: Boolean, default: false },
  smtp_user: String,
  smtp_pass: String,
  // Dashboard preferences moved from legacy `user_settings`
  dashboard_preferences: String
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
  // Source of truth for the reservation (e.g., 'local', 'google')
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

// Agent Stripe connection schema (per-tenant Stripe Connect OAuth data)
const agentStripeSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  stripe_user_id: { type: String, required: true },
  stripe_account_id: { type: String },
  access_token: { type: String, required: true },
  refresh_token: { type: String },
  token_type: { type: String },
  scope: { type: String },
  livemode: { type: Boolean, default: false },
  publishable_key: { type: String },
  default_currency: { type: String, default: 'usd' },
  charges_enabled: { type: Boolean, default: false },
  payouts_enabled: { type: Boolean, default: false },
  details_submitted: { type: Boolean, default: false },
  business_profile: mongoose.Schema.Types.Mixed,
  last_sync_ts: { type: Number, default: 0 },
  onboarding_url: { type: String },
  error_message: { type: String }
}, {
  timestamps: true,
  collection: 'agent_stripe_connections'
});

// One-off payment requests created from the inbox
const paymentRequestSchema = new mongoose.Schema({
  user_id: { type: String, required: true, index: true },
  contact_id: { type: String, required: true, index: true },
  created_by: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'usd' },
  description: { type: String },
  status: {
    type: String,
    enum: ['pending', 'paid', 'expired', 'canceled', 'failed'],
    default: 'pending'
  },
  checkout_session_id: { type: String, unique: true, sparse: true },
  payment_intent_id: { type: String, unique: true, sparse: true },
  payment_link_url: { type: String },
  stripe_account_id: { type: String },
  expires_at: { type: Number },
  paid_at: { type: Number },
  last_event_payload: mongoose.Schema.Types.Mixed,
  message_id: { type: String },
  metadata: mongoose.Schema.Types.Mixed
}, {
  timestamps: true,
  collection: 'payment_requests'
});

// Usage Stats Schema
const usageStatsSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  month_year: { type: String, required: true },
  inbound_messages: { type: Number, default: 0 },
  outbound_messages: { type: Number, default: 0 },
  template_messages: { type: Number, default: 0 },
  // PAYG tracking for the month to avoid double-charging
  payg_charged_units: { type: Number, default: 0 },
  payg_charged_cents: { type: Number, default: 0 }
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
  stripe_subscription_id: String,
  // Pay-as-you-go (PAYG) configuration
  payg_enabled: { type: Boolean, default: false },
  // Charge rate in the smallest currency unit (e.g., cents)
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

// Settings audit schema
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

// Shopify Store Connection Schema
const shopifyStoreSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  shop_domain: { type: String, required: true },
  access_token: { type: String, required: true },
  api_version: { type: String, default: '2024-01' },
  scopes: [String],
  is_active: { type: Boolean, default: true },
  store_info: mongoose.Schema.Types.Mixed, // Cached store information
  webhook_id: String, // ID of the main webhook for order updates
  last_sync_ts: { type: Number, default: 0 },
  sync_enabled: { type: Boolean, default: true },
  inventory_sync_enabled: { type: Boolean, default: false },
  abandoned_cart_enabled: { type: Boolean, default: false },
  order_notifications_enabled: { type: Boolean, default: true }
}, {
  timestamps: true,
  collection: 'shopify_stores'
});

// Shopify Product Schema (cached from Shopify)
const shopifyProductSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  shopify_id: { type: String, required: true },
  title: { type: String, required: true },
  handle: String,
  product_type: String,
  vendor: String,
  tags: [String],
  variants: [{
    id: String,
    title: String,
    price: String,
    compare_at_price: String,
    inventory_quantity: Number,
    sku: String,
    barcode: String,
    weight: Number,
    weight_unit: String,
    option1: String,
    option2: String,
    option3: String,
    taxable: Boolean,
    requires_shipping: Boolean,
    inventory_policy: String,
    inventory_management: String
  }],
  images: [{
    id: String,
    src: String,
    alt: String,
    width: Number,
    height: Number
  }],
  options: [{
    name: String,
    values: [String]
  }],
  status: { type: String, default: 'active' },
  published_at: Date,
  created_at_shopify: Date,
  updated_at_shopify: Date,
  body_html: String,
  metafields: mongoose.Schema.Types.Mixed,
  last_sync_ts: { type: Number, default: 0 },
  is_available: { type: Boolean, default: true }
}, {
  timestamps: true,
  collection: 'shopify_products'
});

// Shopify Order Schema
const shopifyOrderSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  shopify_id: { type: String, required: true },
  order_number: { type: Number, required: true },
  email: String,
  contact_id: String, // Link to WhatsApp contact if applicable
  phone: String,
  customer: mongoose.Schema.Types.Mixed,
  billing_address: mongoose.Schema.Types.Mixed,
  shipping_address: mongoose.Schema.Types.Mixed,
  line_items: [{
    id: String,
    variant_id: String,
    product_id: String,
    title: String,
    variant_title: String,
    quantity: Number,
    price: String,
    total_discount: String,
    sku: String,
    vendor: String,
    properties: mongoose.Schema.Types.Mixed
  }],
  shipping_lines: [{
    title: String,
    price: String,
    code: String,
    source: String
  }],
  tax_lines: [{
    title: String,
    price: String,
    rate: Number
  }],
  discount_codes: [{
    code: String,
    amount: String,
    type: String
  }],
  total_price: String,
  subtotal_price: String,
  total_tax: String,
  total_discounts: String,
  total_shipping_price: String,
  currency: { type: String, default: 'USD' },
  financial_status: { type: String, default: 'pending' },
  fulfillment_status: String,
  order_status_url: String,
  tags: [String],
  note: String,
  created_at_shopify: Date,
  updated_at_shopify: Date,
  processed_at: Date,
  closed_at: Date,
  cancelled_at: Date,
  cancel_reason: String,
  last_sync_ts: { type: Number, default: 0 },
  whatsapp_notifications_sent: { type: [String], default: [] }, // Track sent notifications
  tracking_numbers: [String],
  tracking_urls: [String]
}, {
  timestamps: true,
  collection: 'shopify_orders'
});

// Shopify Customer Schema (synced from Shopify)
const shopifyCustomerSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  shopify_id: { type: String, required: true },
  email: String,
  phone: String,
  first_name: String,
  last_name: String,
  contact_id: String, // Link to WhatsApp contact
  accepts_marketing: { type: Boolean, default: false },
  accepts_marketing_updated_at: Date,
  marketing_opt_in_level: String,
  tax_exempt: { type: Boolean, default: false },
  verified_email: { type: Boolean, default: true },
  addresses: mongoose.Schema.Types.Mixed,
  default_address: mongoose.Schema.Types.Mixed,
  orders_count: { type: Number, default: 0 },
  total_spent: String,
  last_order_id: String,
  last_order_name: String,
  tags: [String],
  note: String,
  created_at_shopify: Date,
  updated_at_shopify: Date,
  last_sync_ts: { type: Number, default: 0 },
  metafields: mongoose.Schema.Types.Mixed
}, {
  timestamps: true,
  collection: 'shopify_customers'
});

// Shopify Cart/Checkout Schema (for abandoned cart recovery)
const shopifyCartSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  contact_id: String,
  cart_token: { type: String, required: true },
  line_items: [{
    variant_id: String,
    product_id: String,
    title: String,
    variant_title: String,
    quantity: Number,
    price: String,
    image_url: String
  }],
  total_price: String,
  currency: { type: String, default: 'USD' },
  created_at_shopify: Date,
  updated_at_shopify: Date,
  abandoned_at: Date,
  recovered: { type: Boolean, default: false },
  recovery_attempts: { type: Number, default: 0 },
  last_recovery_attempt: Date,
  whatsapp_message_sent: { type: Boolean, default: false },
  checkout_url: String
}, {
  timestamps: true,
  collection: 'shopify_carts'
});

// Create indexes for better performance
const createIndexes = async () => {
  try {
    // Messages indexes
    await Message.collection.createIndex({ user_id: 1, timestamp: -1 });
    await Message.collection.createIndex({ from_digits: 1 });
    await Message.collection.createIndex({ to_digits: 1 });
    await Message.collection.createIndex({ direction: 1 });
    // Hot-path: fetch recent messages for a contact within a tenant
    await Message.collection.createIndex({ user_id: 1, from_digits: 1 }, { name: 'user_from_digits' });

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
    // Hot-path: lookups by tenant + contact
    await Handoff.collection.createIndex({ user_id: 1, contact_id: 1 }, { name: 'user_contact' });

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

    // Agent Stripe indexes
    await AgentStripeConnection.collection.createIndex({ user_id: 1 }, { unique: true, name: 'agent_stripe_user' });
    await AgentStripeConnection.collection.createIndex({ stripe_user_id: 1 }, { unique: true, sparse: true, name: 'agent_stripe_account' });

    // Payment request indexes
    await PaymentRequest.collection.createIndex({ user_id: 1, contact_id: 1, createdAt: -1 }, { name: 'payment_requests_contact_recent' });
    await PaymentRequest.collection.createIndex({ checkout_session_id: 1 }, { unique: true, sparse: true, name: 'payment_requests_session' });
    await PaymentRequest.collection.createIndex({ payment_intent_id: 1 }, { unique: true, sparse: true, name: 'payment_requests_intent' });

    // Usage stats indexes
    await UsageStats.collection.createIndex({ user_id: 1, month_year: 1 }, { unique: true });

    // Booking sessions TTL cleanup
    try {
      const sessionTtlHours = Number(process.env.BOOKING_SESSION_TTL_HOURS || 24);
      if (sessionTtlHours > 0) {
        await BookingSession.collection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: sessionTtlHours * 3600, name: 'ttl_booking_sessions_updatedAt' });
      }
    } catch {}

    // Appointments hot-path index: by tenant, phone, and time
    await Appointment.collection.createIndex({ user_id: 1, contact_phone: 1, start_ts: 1 }, { name: 'user_phone_startTs' });

    // Settings audit indexes
    await SettingsAudit.collection.createIndex({ user_id: 1, createdAt: -1 }, { name: 'settings_audit_user' });

    // Shopify indexes
    await ShopifyStore.collection.createIndex({ user_id: 1 }, { unique: true, name: 'shopify_store_user' });
    await ShopifyStore.collection.createIndex({ shop_domain: 1 }, { unique: true, sparse: true, name: 'shopify_store_domain' });

    await ShopifyProduct.collection.createIndex({ user_id: 1, shopify_id: 1 }, { unique: true, name: 'shopify_product_user_id' });
    await ShopifyProduct.collection.createIndex({ user_id: 1, handle: 1 }, { name: 'shopify_product_user_handle' });
    await ShopifyProduct.collection.createIndex({ user_id: 1, 'variants.sku': 1 }, { name: 'shopify_product_sku' });
    await ShopifyProduct.collection.createIndex({ user_id: 1, status: 1, is_available: 1 }, { name: 'shopify_product_status' });

    await ShopifyOrder.collection.createIndex({ user_id: 1, shopify_id: 1 }, { unique: true, name: 'shopify_order_user_id' });
    await ShopifyOrder.collection.createIndex({ user_id: 1, order_number: 1 }, { unique: true, name: 'shopify_order_user_number' });
    await ShopifyOrder.collection.createIndex({ user_id: 1, contact_id: 1 }, { name: 'shopify_order_contact' });
    await ShopifyOrder.collection.createIndex({ user_id: 1, financial_status: 1 }, { name: 'shopify_order_status' });
    await ShopifyOrder.collection.createIndex({ user_id: 1, created_at_shopify: -1 }, { name: 'shopify_order_created' });

    await ShopifyCustomer.collection.createIndex({ user_id: 1, shopify_id: 1 }, { unique: true, name: 'shopify_customer_user_id' });
    await ShopifyCustomer.collection.createIndex({ user_id: 1, email: 1 }, { name: 'shopify_customer_email' });
    await ShopifyCustomer.collection.createIndex({ user_id: 1, phone: 1 }, { name: 'shopify_customer_phone' });
    await ShopifyCustomer.collection.createIndex({ user_id: 1, contact_id: 1 }, { name: 'shopify_customer_contact' });

    await ShopifyCart.collection.createIndex({ user_id: 1, cart_token: 1 }, { unique: true, name: 'shopify_cart_user_token' });
    await ShopifyCart.collection.createIndex({ user_id: 1, contact_id: 1 }, { name: 'shopify_cart_contact' });
    await ShopifyCart.collection.createIndex({ user_id: 1, recovered: 1, createdAt: -1 }, { name: 'shopify_cart_recovery' });

    console.log('MongoDB indexes created successfully');
  } catch (error) {
    logHelpers.logError(error, { component: 'mongodb', operation: 'create_indexes' });
  }
};

// Shopify models
export const ShopifyStore = mongoose.model('ShopifyStore', shopifyStoreSchema);
export const ShopifyProduct = mongoose.model('ShopifyProduct', shopifyProductSchema);
export const ShopifyOrder = mongoose.model('ShopifyOrder', shopifyOrderSchema);
export const ShopifyCustomer = mongoose.model('ShopifyCustomer', shopifyCustomerSchema);
export const ShopifyCart = mongoose.model('ShopifyCart', shopifyCartSchema);

// Export models
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
export const AgentStripeConnection = mongoose.model('AgentStripeConnection', agentStripeSchema);
export const PaymentRequest = mongoose.model('PaymentRequest', paymentRequestSchema);
export const UsageStats = mongoose.model('UsageStats', usageStatsSchema);
export const UserPlan = mongoose.model('UserPlan', userPlanSchema);
export const QuickReply = mongoose.model('QuickReply', quickReplySchema);
export const Guide = mongoose.model('Guide', guideSchema);
export const Enquiry = mongoose.model('Enquiry', enquirySchema);
export const SettingsAudit = mongoose.model('SettingsAudit', settingsAuditSchema);

// Initialize indexes when module loads
// Note: Index creation is triggered post-connection from db-mongodb.mjs
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
  AgentStripeConnection,
  PaymentRequest,
  UsageStats,
  UserPlan,
  QuickReply,
  Guide,
  Enquiry,
  SettingsAudit,
  ShopifyStore,
  ShopifyProduct,
  ShopifyOrder,
  ShopifyCustomer,
  ShopifyCart
};
