

export const testUsers = {
  valid: {
    id: 'user_123456789',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User'
  },
  admin: {
    id: 'admin_123456789',
    email: 'admin@example.com',
    firstName: 'Admin',
    lastName: 'User'
  }
};

export const testContacts = {
  valid: {
    contact_id: '+1234567890',
    display_name: 'John Doe',
    notes: 'VIP customer',
    tags: ['vip', 'premium']
  },
  minimal: {
    contact_id: '+0987654321',
    display_name: 'Jane Smith'
  }
};

export const testMessages = {
  inbound: {
    id: 'msg_inbound_123',
    direction: 'inbound',
    from_id: '+1234567890',
    to_id: '+0987654321',
    type: 'text',
    text_body: 'Hello, I need help with my order',
    timestamp: Math.floor(Date.now() / 1000),
    raw: {
      id: 'msg_inbound_123',
      from: '+1234567890',
      to: '+0987654321',
      type: 'text',
      text: { body: 'Hello, I need help with my order' }
    }
  },
  outbound: {
    id: 'msg_outbound_123',
    direction: 'outbound',
    from_id: '+0987654321',
    to_id: '+1234567890',
    type: 'text',
    text_body: 'Hi! I can help you with that. What\'s your order number?',
    timestamp: Math.floor(Date.now() / 1000),
    raw: {
      id: 'msg_outbound_123',
      from: '+0987654321',
      to: '+1234567890',
      type: 'text',
      text: { body: 'Hi! I can help you with that. What\'s your order number?' }
    }
  },
  template: {
    id: 'msg_template_123',
    direction: 'outbound',
    from_id: '+0987654321',
    to_id: '+1234567890',
    type: 'template',
    text_body: 'Hello {{1}}, your order {{2}} is ready for pickup!',
    timestamp: Math.floor(Date.now() / 1000),
    raw: {
      id: 'msg_template_123',
      from: '+0987654321',
      to: '+1234567890',
      type: 'template',
      template: {
        name: 'order_ready',
        language: { code: 'en_US' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'John' },
              { type: 'text', text: '#12345' }
            ]
          }
        ]
      }
    }
  }
};

export const testWhatsAppWebhooks = {
  message: {
    object: 'whatsapp_business_account',
    entry: [{
      id: '123456789',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '+0987654321',
            phone_number_id: '123456789'
          },
          messages: [testMessages.inbound.raw]
        },
        field: 'messages'
      }]
    }]
  },
  status: {
    object: 'whatsapp_business_account',
    entry: [{
      id: '123456789',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '+0987654321',
            phone_number_id: '123456789'
          },
          statuses: [{
            id: 'msg_inbound_123',
            status: 'delivered',
            timestamp: Math.floor(Date.now() / 1000),
            recipient_id: '+1234567890'
          }]
        },
        field: 'messages'
      }]
    }]
  }
};

export const testStripeWebhooks = {
  checkoutCompleted: {
    id: 'evt_test_webhook',
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_123',
        object: 'checkout.session',
        customer: 'cus_test_123',
        subscription: 'sub_test_123',
        payment_status: 'paid',
        amount_total: 2900,
        currency: 'usd'
      }
    }
  },
  subscriptionUpdated: {
    id: 'evt_test_webhook_2',
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_test_123',
        object: 'subscription',
        customer: 'cus_test_123',
        status: 'active',
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
      }
    }
  }
};

export const testSettings = {
  valid: {
    user_id: 'user_123456789',
    business_name: 'Test Business',
    business_phone: '+1234567890',
    ai_tone: 'friendly',
    entry_greeting: 'Hello! How can I help you today?',
    ai_style: 'professional',
    ai_blocked_topics: 'politics,religion'
  },
  minimal: {
    user_id: 'user_123456789',
    business_name: 'Minimal Business'
  }
};

export const testKBItems = {
  hours: {
    user_id: 'user_123456789',
    title: 'Business Hours',
    content: 'We are open Monday-Friday from 9:00 AM to 5:00 PM EST.'
  },
  location: {
    user_id: 'user_123456789',
    title: 'Location',
    content: 'We are located at 123 Main Street, Anytown, ST 12345.'
  },
  contact: {
    user_id: 'user_123456789',
    title: 'Contact Information',
    content: 'You can reach us at (555) 123-4567 or email us at info@example.com.'
  }
};

export const testNotifications = {
  escalation: {
    user_id: 'user_123456789',
    type: 'escalation',
    title: 'New Support Escalation',
    message: 'John Doe requested to speak with a human: Need help with order',
    link: '/inbox/+1234567890',
    metadata: JSON.stringify({
      contact_id: '+1234567890',
      contact_name: 'John Doe',
      reason: 'Need help with order'
    })
  },
  booking: {
    user_id: 'user_123456789',
    type: 'booking',
    title: 'New Booking',
    message: 'Jane Smith booked an appointment for tomorrow at 2:00 PM',
    link: '/dashboard',
    metadata: JSON.stringify({
      contact_id: '+0987654321',
      contact_name: 'Jane Smith',
      appointment_time: '2024-01-15T14:00:00Z'
    })
  }
};

export const testUsageStats = {
  currentMonth: {
    user_id: 'user_123456789',
    month_year: '2024-01',
    inbound_messages: 150,
    outbound_messages: 120,
    template_messages: 5
  },
  previousMonth: {
    user_id: 'user_123456789',
    month_year: '2023-12',
    inbound_messages: 200,
    outbound_messages: 180,
    template_messages: 8
  }
};

export const testUserPlans = {
  free: {
    user_id: 'user_123456789',
    plan_name: 'free',
    status: 'active',
    monthly_limit: 100,
    whatsapp_numbers: 1
  },
  starter: {
    user_id: 'user_123456789',
    plan_name: 'starter',
    status: 'active',
    monthly_limit: 1000,
    whatsapp_numbers: 2,
    stripe_customer_id: 'cus_test_123',
    stripe_subscription_id: 'sub_test_123'
  }
};
