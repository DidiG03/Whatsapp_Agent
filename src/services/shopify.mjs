/**
 * Shopify service for e-commerce integration
 * Handles OAuth, API calls, webhooks, and data synchronization
 */

import crypto from 'crypto';
import axios from 'axios';

// Initialize Shopify API client
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_SCOPES = process.env.SHOPIFY_SCOPES || 'read_products,write_products,read_orders,write_orders,read_customers,write_customers,read_inventory,write_inventory';

function normalizeBaseUrl(url) {
  if (!url) return '';
  return String(url).trim().replace(/\/+$/, '');
}

/**
 * Resolve the OAuth redirect URI.
 * Prefers explicit SHOPIFY_REDIRECT_URI, otherwise derives from PUBLIC_BASE_URL/NGROK_URL.
 */
export function getShopifyRedirectUri() {
  const explicit = (process.env.SHOPIFY_REDIRECT_URI || '').trim();
  if (explicit) return explicit;

  const base =
    normalizeBaseUrl(process.env.PUBLIC_BASE_URL) ||
    normalizeBaseUrl(process.env.NGROK_URL) ||
    '';

  if (base) return `${base}/shopify/oauth/callback`;

  const port = process.env.PORT || 3000;
  return `http://localhost:${port}/shopify/oauth/callback`;
}

/**
 * Check if Shopify integration is properly configured
 */
export function isShopifyEnabled() {
  const redirectUri = getShopifyRedirectUri();
  return !!(SHOPIFY_API_KEY && SHOPIFY_API_SECRET && redirectUri);
}

/**
 * Generate Shopify OAuth URL for store authorization
 */
export function generateOAuthUrl(shopDomain, state = null) {
  if (!isShopifyEnabled()) {
    throw new Error('Shopify is not configured');
  }

  const redirectUri = getShopifyRedirectUri();
  const params = new URLSearchParams({
    client_id: SHOPIFY_API_KEY,
    scope: SHOPIFY_SCOPES,
    redirect_uri: redirectUri,
    state: state || crypto.randomBytes(16).toString('hex')
  });

  return `https://${shopDomain}/admin/oauth/authorize?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 */
export async function exchangeCodeForToken(shopDomain, code) {
  if (!isShopifyEnabled()) {
    throw new Error('Shopify is not configured');
  }

  try {
    const response = await axios.post(`https://${shopDomain}/admin/oauth/access_token`, {
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code: code
    });

    return {
      access_token: response.data.access_token,
      scope: response.data.scope
    };
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    let oauthError =
      (data && typeof data === 'object' && (data.error_description || data.error)) ? (data.error_description || data.error) :
      '';

    // Sometimes Shopify returns an HTML error page (e.g., when shopDomain is wrong).
    if (!oauthError && typeof data === 'string') {
      const titleMatch = data.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      oauthError = titleMatch?.[1] ? `HTML:${titleMatch[1]}` : 'HTML_RESPONSE';
    }

    const detail = oauthError || error?.message || 'unknown_error';
    console.error('Failed to exchange code for token:', {
      status,
      shopDomain,
      message: error?.message,
      responseType: typeof data,
    });
    throw new Error(`SHOPIFY_TOKEN_EXCHANGE_FAILED:${detail}`);
  }
}

/**
 * Verify Shopify webhook signature
 */
export function verifyWebhook(rawBody, signature, secret = process.env.SHOPIFY_WEBHOOK_SECRET) {
  if (!secret) return false;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody, 'utf8');
  const computedSignature = hmac.digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(signature, 'base64'),
    Buffer.from(computedSignature, 'base64')
  );
}

/**
 * Create Shopify API client for a store
 */
export function createShopifyClient(shopDomain, accessToken, apiVersion = '2024-01') {
  const baseURL = `https://${shopDomain}/admin/api/${apiVersion}`;

  return axios.create({
    baseURL,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });
}

/**
 * Get store information
 */
export async function getStoreInfo(shopDomain, accessToken) {
  try {
    const client = createShopifyClient(shopDomain, accessToken);
    const response = await client.get('/shop.json');
    return response.data.shop;
  } catch (error) {
    console.error('Failed to get store info:', error.response?.data || error.message);
    throw new Error('Failed to retrieve store information');
  }
}

/**
 * Sync products from Shopify
 */
export async function syncProducts(userId, shopDomain, accessToken, options = {}) {
  try {
    const { ShopifyProduct, ShopifyStore } = await import('../schemas/mongodb.mjs');
    const client = createShopifyClient(shopDomain, accessToken);

    let allProducts = [];
    let nextUrl = '/products.json?limit=250';

    // Fetch all products with pagination
    while (nextUrl) {
      const response = await client.get(nextUrl);
      const products = response.data.products || [];

      // Transform and save products
      for (const product of products) {
        const productData = {
          user_id: userId,
          shopify_id: product.id.toString(),
          title: product.title,
          handle: product.handle,
          product_type: product.product_type,
          vendor: product.vendor,
          tags: product.tags || [],
          status: product.status,
          published_at: product.published_at ? new Date(product.published_at) : null,
          created_at_shopify: new Date(product.created_at),
          updated_at_shopify: new Date(product.updated_at),
          body_html: product.body_html,
          metafields: product.metafields || [],
          variants: (product.variants || []).map(variant => ({
            id: variant.id.toString(),
            title: variant.title,
            price: variant.price,
            compare_at_price: variant.compare_at_price,
            inventory_quantity: variant.inventory_quantity,
            sku: variant.sku,
            barcode: variant.barcode,
            weight: variant.weight,
            weight_unit: variant.weight_unit,
            option1: variant.option1,
            option2: variant.option2,
            option3: variant.option3,
            taxable: variant.taxable,
            requires_shipping: variant.requires_shipping,
            inventory_policy: variant.inventory_policy,
            inventory_management: variant.inventory_management
          })),
          images: (product.images || []).map(image => ({
            id: image.id.toString(),
            src: image.src,
            alt: image.alt,
            width: image.width,
            height: image.height
          })),
          options: product.options || [],
          last_sync_ts: Date.now(),
          is_available: product.status === 'active' && (product.variants || []).some(v => v.inventory_quantity > 0)
        };

        await ShopifyProduct.findOneAndUpdate(
          { user_id: userId, shopify_id: product.id.toString() },
          productData,
          { upsert: true, new: true }
        );
      }

      allProducts.push(...products);

      // Check for next page
      const linkHeader = response.headers.link;
      nextUrl = null;
      if (linkHeader) {
        const nextLink = linkHeader.split(',').find(link => link.includes('rel="next"'));
        if (nextLink) {
          const match = nextLink.match(/<([^>]+)>/);
          if (match) {
            nextUrl = match[1].replace(`https://${shopDomain}/admin/api/${client.defaults.baseURL.split('/').pop()}`, '');
          }
        }
      }
    }

    // Update last sync timestamp
    await ShopifyStore.findOneAndUpdate(
      { user_id: userId },
      { last_sync_ts: Date.now() }
    );

    console.log(`Synced ${allProducts.length} products for user ${userId}`);
    return { success: true, products_count: allProducts.length };
  } catch (error) {
    console.error('Failed to sync products:', error.response?.data || error.message);
    throw new Error('Failed to sync products from Shopify');
  }
}

/**
 * Sync orders from Shopify
 */
export async function syncOrders(userId, shopDomain, accessToken, options = {}) {
  try {
    const { ShopifyOrder } = await import('../schemas/mongodb.mjs');
    const client = createShopifyClient(shopDomain, accessToken);

    const sinceId = options.since_id || 0;
    let allOrders = [];
    let nextUrl = `/orders.json?limit=250&since_id=${sinceId}`;

    // Fetch all orders with pagination
    while (nextUrl) {
      const response = await client.get(nextUrl);
      const orders = response.data.orders || [];

      // Transform and save orders
      for (const order of orders) {
        const orderData = {
          user_id: userId,
          shopify_id: order.id.toString(),
          order_number: order.order_number,
          email: order.email,
          phone: order.phone,
          customer: order.customer,
          billing_address: order.billing_address,
          shipping_address: order.shipping_address,
          financial_status: order.financial_status,
          fulfillment_status: order.fulfillment_status,
          order_status_url: order.order_status_url,
          tags: order.tags || [],
          note: order.note,
          created_at_shopify: new Date(order.created_at),
          updated_at_shopify: new Date(order.updated_at),
          processed_at: order.processed_at ? new Date(order.processed_at) : null,
          closed_at: order.closed_at ? new Date(order.closed_at) : null,
          cancelled_at: order.cancelled_at ? new Date(order.cancelled_at) : null,
          cancel_reason: order.cancel_reason,
          currency: order.currency,
          total_price: order.total_price,
          subtotal_price: order.subtotal_price,
          total_tax: order.total_tax,
          total_discounts: order.total_discounts,
          total_shipping_price: order.total_shipping_price_set?.shop_money?.amount || '0',
          line_items: (order.line_items || []).map(item => ({
            id: item.id.toString(),
            variant_id: item.variant_id?.toString(),
            product_id: item.product_id?.toString(),
            title: item.title,
            variant_title: item.variant_title,
            quantity: item.quantity,
            price: item.price,
            total_discount: item.total_discount,
            sku: item.sku,
            vendor: item.vendor,
            properties: item.properties || []
          })),
          shipping_lines: (order.shipping_lines || []).map(line => ({
            title: line.title,
            price: line.price,
            code: line.code,
            source: line.source
          })),
          tax_lines: (order.tax_lines || []).map(tax => ({
            title: tax.title,
            price: tax.price,
            rate: tax.rate
          })),
          discount_codes: (order.discount_codes || []).map(code => ({
            code: code.code,
            amount: code.amount,
            type: code.type
          })),
          last_sync_ts: Date.now(),
          whatsapp_notifications_sent: []
        };

        await ShopifyOrder.findOneAndUpdate(
          { user_id: userId, shopify_id: order.id.toString() },
          orderData,
          { upsert: true, new: true }
        );
      }

      allOrders.push(...orders);

      // Check for next page
      const linkHeader = response.headers.link;
      nextUrl = null;
      if (linkHeader) {
        const nextLink = linkHeader.split(',').find(link => link.includes('rel="next"'));
        if (nextLink) {
          const match = nextLink.match(/<([^>]+)>/);
          if (match) {
            nextUrl = match[1].replace(`https://${shopDomain}/admin/api/${client.defaults.baseURL.split('/').pop()}`, '');
          }
        }
      }
    }

    console.log(`Synced ${allOrders.length} orders for user ${userId}`);
    return { success: true, orders_count: allOrders.length };
  } catch (error) {
    console.error('Failed to sync orders:', error.response?.data || error.message);
    throw new Error('Failed to sync orders from Shopify');
  }
}

/**
 * Sync customers from Shopify
 */
export async function syncCustomers(userId, shopDomain, accessToken, options = {}) {
  try {
    const { ShopifyCustomer } = await import('../schemas/mongodb.mjs');
    const client = createShopifyClient(shopDomain, accessToken);

    let allCustomers = [];
    let nextUrl = '/customers.json?limit=250';

    // Fetch all customers with pagination
    while (nextUrl) {
      const response = await client.get(nextUrl);
      const customers = response.data.customers || [];

      // Transform and save customers
      for (const customer of customers) {
        const customerData = {
          user_id: userId,
          shopify_id: customer.id.toString(),
          email: customer.email,
          phone: customer.phone,
          first_name: customer.first_name,
          last_name: customer.last_name,
          accepts_marketing: customer.accepts_marketing,
          accepts_marketing_updated_at: customer.accepts_marketing_updated_at ? new Date(customer.accepts_marketing_updated_at) : null,
          marketing_opt_in_level: customer.marketing_opt_in_level,
          tax_exempt: customer.tax_exempt,
          verified_email: customer.verified_email,
          addresses: customer.addresses,
          default_address: customer.default_address,
          orders_count: customer.orders_count,
          total_spent: customer.total_spent,
          last_order_id: customer.last_order_id,
          last_order_name: customer.last_order_name,
          tags: customer.tags || [],
          note: customer.note,
          created_at_shopify: new Date(customer.created_at),
          updated_at_shopify: new Date(customer.updated_at),
          metafields: customer.metafields || [],
          last_sync_ts: Date.now()
        };

        await ShopifyCustomer.findOneAndUpdate(
          { user_id: userId, shopify_id: customer.id.toString() },
          customerData,
          { upsert: true, new: true }
        );
      }

      allCustomers.push(...customers);

      // Check for next page
      const linkHeader = response.headers.link;
      nextUrl = null;
      if (linkHeader) {
        const nextLink = linkHeader.split(',').find(link => link.includes('rel="next"'));
        if (nextLink) {
          const match = nextLink.match(/<([^>]+)>/);
          if (match) {
            nextUrl = match[1].replace(`https://${shopDomain}/admin/api/${client.defaults.baseURL.split('/').pop()}`, '');
          }
        }
      }
    }

    console.log(`Synced ${allCustomers.length} customers for user ${userId}`);
    return { success: true, customers_count: allCustomers.length };
  } catch (error) {
    console.error('Failed to sync customers:', error.response?.data || error.message);
    throw new Error('Failed to sync customers from Shopify');
  }
}

/**
 * Get product catalog for WhatsApp display
 */
export async function getProductCatalog(userId, options = {}) {
  try {
    const { ShopifyProduct } = await import('../schemas/mongodb.mjs');

    const query = { user_id: userId, status: 'active', is_available: true };
    const products = await ShopifyProduct.find(query)
      .sort({ createdAt: -1 })
      .limit(options.limit || 50)
      .lean();

    return products.map(product => ({
      id: product.shopify_id,
      title: product.title,
      handle: product.handle,
      price: product.variants?.[0]?.price || '0',
      compare_at_price: product.variants?.[0]?.compare_at_price,
      image: product.images?.[0]?.src,
      vendor: product.vendor,
      tags: product.tags,
      variants: product.variants?.map(v => ({
        id: v.id,
        title: v.title,
        price: v.price,
        inventory_quantity: v.inventory_quantity,
        sku: v.sku
      })) || []
    }));
  } catch (error) {
    console.error('Failed to get product catalog:', error.message);
    throw new Error('Failed to retrieve product catalog');
  }
}

/**
 * Search products for WhatsApp
 */
export async function searchProducts(userId, searchTerm, options = {}) {
  try {
    const { ShopifyProduct } = await import('../schemas/mongodb.mjs');

    const regex = new RegExp(searchTerm, 'i');
    const query = {
      user_id: userId,
      status: 'active',
      is_available: true,
      $or: [
        { title: regex },
        { vendor: regex },
        { tags: regex },
        { 'variants.sku': regex },
        { 'variants.title': regex }
      ]
    };

    const products = await ShopifyProduct.find(query)
      .limit(options.limit || 20)
      .lean();

    return products;
  } catch (error) {
    console.error('Failed to search products:', error.message);
    throw new Error('Failed to search products');
  }
}

/**
 * Create order via Shopify API
 */
export async function createOrder(userId, shopDomain, accessToken, orderData) {
  try {
    const client = createShopifyClient(shopDomain, accessToken);

    const response = await client.post('/orders.json', {
      order: {
        email: orderData.email,
        phone: orderData.phone,
        customer: orderData.customer_id ? { id: orderData.customer_id } : undefined,
        billing_address: orderData.billing_address,
        shipping_address: orderData.shipping_address,
        line_items: orderData.line_items.map(item => ({
          variant_id: item.variant_id,
          quantity: item.quantity,
          price: item.price,
          title: item.title
        })),
        shipping_lines: orderData.shipping_lines || [],
        note: orderData.note,
        tags: ['whatsapp_order', ...(orderData.tags || [])],
        metafields: [{
          key: 'source',
          value: 'whatsapp_agent',
          type: 'single_line_text_field',
          namespace: 'whatsapp_agent'
        }]
      }
    });

    const order = response.data.order;

    // Save to our database
    const { ShopifyOrder } = await import('../schemas/mongodb.mjs');
    await ShopifyOrder.findOneAndUpdate(
      { user_id: userId, shopify_id: order.id.toString() },
      {
        user_id: userId,
        shopify_id: order.id.toString(),
        order_number: order.order_number,
        email: order.email,
        phone: order.phone,
        customer: order.customer,
        billing_address: order.billing_address,
        shipping_address: order.shipping_address,
        financial_status: order.financial_status,
        fulfillment_status: order.fulfillment_status,
        currency: order.currency,
        total_price: order.total_price,
        subtotal_price: order.subtotal_price,
        line_items: order.line_items,
        created_at_shopify: new Date(order.created_at),
        updated_at_shopify: new Date(order.updated_at),
        last_sync_ts: Date.now(),
        whatsapp_notifications_sent: []
      },
      { upsert: true, new: true }
    );

    return order;
  } catch (error) {
    console.error('Failed to create order:', error.response?.data || error.message);
    throw new Error('Failed to create order in Shopify');
  }
}

/**
 * Update order fulfillment status
 */
export async function updateOrderFulfillment(userId, shopDomain, accessToken, orderId, trackingInfo) {
  try {
    const client = createShopifyClient(shopDomain, accessToken);

    // First, create a fulfillment
    const fulfillmentData = {
      fulfillment: {
        tracking_number: trackingInfo.tracking_number,
        tracking_url: trackingInfo.tracking_url,
        tracking_company: trackingInfo.tracking_company,
        notify_customer: true
      }
    };

    const response = await client.post(`/orders/${orderId}/fulfillments.json`, fulfillmentData);

    // Update our database
    const { ShopifyOrder } = await import('../schemas/mongodb.mjs');
    await ShopifyOrder.findOneAndUpdate(
      { user_id: userId, shopify_id: orderId },
      {
        fulfillment_status: 'fulfilled',
        tracking_numbers: [trackingInfo.tracking_number],
        tracking_urls: [trackingInfo.tracking_url],
        updated_at_shopify: new Date(),
        last_sync_ts: Date.now()
      }
    );

    return response.data.fulfillment;
  } catch (error) {
    console.error('Failed to update fulfillment:', error.response?.data || error.message);
    throw new Error('Failed to update order fulfillment');
  }
}

/**
 * Register webhook for order updates
 */
export async function registerWebhook(userId, shopDomain, accessToken, webhookUrl) {
  try {
    const client = createShopifyClient(shopDomain, accessToken);

    const webhookData = {
      webhook: {
        topic: 'orders/create',
        address: webhookUrl,
        format: 'json'
      }
    };

    const response = await client.post('/webhooks.json', webhookData);
    const webhook = response.data.webhook;

    // Store webhook ID
    const { ShopifyStore } = await import('../schemas/mongodb.mjs');
    await ShopifyStore.findOneAndUpdate(
      { user_id: userId },
      { webhook_id: webhook.id.toString() }
    );

    return webhook;
  } catch (error) {
    console.error('Failed to register webhook:', error.response?.data || error.message);
    throw new Error('Failed to register webhook');
  }
}

/**
 * Handle incoming Shopify webhook
 */
export async function handleWebhook(topic, data) {
  try {
    switch (topic) {
      case 'orders/create':
      case 'orders/updated':
        await handleOrderWebhook(data);
        break;
      case 'products/update':
        await handleProductWebhook(data);
        break;
      case 'customers/create':
      case 'customers/update':
        await handleCustomerWebhook(data);
        break;
      case 'checkouts/create':
      case 'checkouts/update':
        await handleCheckoutWebhook(data);
        break;
      default:
        console.log(`Unhandled webhook topic: ${topic}`);
    }
  } catch (error) {
    console.error('Failed to handle webhook:', error.message);
    throw error;
  }
}

/**
 * Handle order webhook
 */
async function handleOrderWebhook(orderData) {
  try {
    // Find the store by webhook ID or domain
    const { ShopifyStore, ShopifyOrder } = await import('../schemas/mongodb.mjs');

    // For now, we'll need to find the user by matching the order data
    // In production, you might want to include user_id in webhook metadata
    const store = await ShopifyStore.findOne({ webhook_id: orderData.webhook_id });

    if (!store) {
      console.warn('Could not find store for webhook');
      return;
    }

    const userId = store.user_id;

    // Update or create order
    await ShopifyOrder.findOneAndUpdate(
      { user_id: userId, shopify_id: orderData.id.toString() },
      {
        user_id: userId,
        shopify_id: orderData.id.toString(),
        order_number: orderData.order_number,
        email: orderData.email,
        phone: orderData.phone,
        customer: orderData.customer,
        billing_address: orderData.billing_address,
        shipping_address: orderData.shipping_address,
        financial_status: orderData.financial_status,
        fulfillment_status: orderData.fulfillment_status,
        currency: orderData.currency,
        total_price: orderData.total_price,
        subtotal_price: orderData.subtotal_price,
        line_items: orderData.line_items,
        created_at_shopify: new Date(orderData.created_at),
        updated_at_shopify: new Date(orderData.updated_at),
        last_sync_ts: Date.now()
      },
      { upsert: true, new: true }
    );

    console.log(`Updated order ${orderData.order_number} for user ${userId}`);
  } catch (error) {
    console.error('Failed to handle order webhook:', error.message);
  }
}

/**
 * Handle product webhook
 */
async function handleProductWebhook(productData) {
  try {
    // Similar logic to handleOrderWebhook
    console.log('Product webhook received:', productData.id);
    // Implementation would be similar to syncProducts for individual product
  } catch (error) {
    console.error('Failed to handle product webhook:', error.message);
  }
}

/**
 * Handle customer webhook
 */
async function handleCustomerWebhook(customerData) {
  try {
    console.log('Customer webhook received:', customerData.id);
    // Implementation would be similar to syncCustomers for individual customer
  } catch (error) {
    console.error('Failed to handle customer webhook:', error.message);
  }
}

/**
 * Handle checkout webhook (for abandoned carts)
 */
async function handleCheckoutWebhook(checkoutData) {
  try {
    // Find store and save cart data for abandoned cart recovery
    console.log('Checkout webhook received:', checkoutData.token);
  } catch (error) {
    console.error('Failed to handle checkout webhook:', error.message);
  }
}

/**
 * Send WhatsApp order notification
 */
export async function sendOrderNotification(userId, orderId, contactId, messageType = 'confirmation') {
  try {
    const { ShopifyOrder } = await import('../schemas/mongodb.mjs');
    const { sendWhatsAppMessage } = await import('./whatsapp.mjs');

    const order = await ShopifyOrder.findOne({ user_id: userId, shopify_id: orderId });
    if (!order) return false;

    // Check if notification already sent
    if (order.whatsapp_notifications_sent.includes(messageType)) {
      return true;
    }

    let message = '';

    switch (messageType) {
      case 'confirmation':
        message = `🎉 Order Confirmed!\n\nOrder #${order.order_number}\nTotal: $${order.total_price}\n\nThank you for your purchase! We'll send you updates on your order status.`;
        break;
      case 'shipped':
        message = `🚚 Order Shipped!\n\nOrder #${order.order_number} has been shipped.\n${order.tracking_numbers?.[0] ? `Tracking: ${order.tracking_urls?.[0] || order.tracking_numbers[0]}` : ''}`;
        break;
      case 'delivered':
        message = `✅ Order Delivered!\n\nOrder #${order.order_number} has been delivered successfully. Thank you for shopping with us!`;
        break;
    }

    if (message) {
      await sendWhatsAppMessage(userId, contactId, message);

      // Mark notification as sent
      await ShopifyOrder.findOneAndUpdate(
        { user_id: userId, shopify_id: orderId },
        { $push: { whatsapp_notifications_sent: messageType } }
      );
    }

    return true;
  } catch (error) {
    console.error('Failed to send order notification:', error.message);
    return false;
  }
}

/**
 * Get store connection status
 */
export async function getStoreConnection(userId) {
  try {
    const { ShopifyStore } = await import('../schemas/mongodb.mjs');
    const store = await ShopifyStore.findOne({ user_id: userId }).lean();

    if (!store) {
      return { connected: false };
    }

    return {
      connected: true,
      shop_domain: store.shop_domain,
      is_active: store.is_active,
      last_sync_ts: store.last_sync_ts,
      sync_enabled: store.sync_enabled,
      inventory_sync_enabled: store.inventory_sync_enabled,
      abandoned_cart_enabled: store.abandoned_cart_enabled,
      order_notifications_enabled: store.order_notifications_enabled
    };
  } catch (error) {
    console.error('Failed to get store connection:', error.message);
    return { connected: false, error: error.message };
  }
}

/**
 * Disconnect Shopify store
 */
export async function disconnectStore(userId) {
  try {
    const { ShopifyStore } = await import('../schemas/mongodb.mjs');
    await ShopifyStore.findOneAndDelete({ user_id: userId });
    return { success: true };
  } catch (error) {
    console.error('Failed to disconnect store:', error.message);
    throw new Error('Failed to disconnect Shopify store');
  }
}


