import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import {
  isShopifyEnabled,
  generateOAuthUrl,
  exchangeCodeForToken,
  getStoreInfo,
  verifyWebhook,
  handleWebhook,
  getStoreConnection,
  disconnectStore,
  syncProducts,
  syncOrders,
  syncCustomers,
  getProductCatalog,
  searchProducts,
  createOrder,
  updateOrderFulfillment,
  registerWebhook,
  getShopifyRedirectUri
} from "../services/shopify.mjs";
import { renderSidebar, renderTopbar, getProfessionalHead } from "../utils.mjs";
import { getUserPlan, isPlanUpgraded } from "../services/usage.mjs";

export default function registerShopifyRoutes(app) {
  function normalizeShopDomain(input) {
    if (!input) return '';
    let raw = String(input).trim();
    if (!raw) return '';
    raw = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

    // If someone pasted an admin URL like admin.shopify.com/store/<slug>/...
    // try to derive the myshopify domain.
    const adminMatch = raw.match(/^admin\.shopify\.com\/store\/([^\/\?]+)/i);
    if (adminMatch?.[1]) {
      return `${adminMatch[1].toLowerCase()}.myshopify.com`;
    }

    // If they pasted with a path, keep only host portion
    const hostOnly = raw.split('/')[0];
    return hostOnly.toLowerCase();
  }

  // Shopify OAuth initiation
  app.get("/shopify/auth", ensureAuthed, (req, res) => {
    if (!isShopifyEnabled()) {
      return res.redirect('/settings/shopify?shopify_error=not_configured');
    }

    const userId = getCurrentUserId(req);
    let shopDomain = normalizeShopDomain(req.query.shop);

    if (!shopDomain) {
      return res.redirect('/settings/shopify?shopify_error=missing_shop');
    }

    // Shopify OAuth requires the shop domain to be a myshopify domain.
    if (!shopDomain.endsWith('.myshopify.com')) {
      return res.redirect('/settings/shopify?shopify_error=invalid_shop');
    }

    try {
      const authUrl = generateOAuthUrl(shopDomain, userId);
      res.redirect(authUrl);
    } catch (error) {
      console.error('Failed to generate OAuth URL:', error);
      res.redirect('/settings/shopify?shopify_error=oauth_init_failed');
    }
  });

  // Shopify OAuth callback
  app.get("/shopify/oauth/callback", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const code = String(req.query.code || '');
    const shop = normalizeShopDomain(req.query.shop);

    if (!code || !shop) {
      return res.redirect('/settings/shopify?shopify_error=missing_params');
    }
    if (!shop.endsWith('.myshopify.com')) {
      return res.redirect('/settings/shopify?shopify_error=invalid_shop');
    }

    try {
      // Optional safety: if the redirect URI is misconfigured, surface it early.
      if (!isShopifyEnabled() || !getShopifyRedirectUri()) {
        return res.redirect('/settings/shopify?shopify_error=not_configured');
      }

      // Exchange code for access token
      let tokenData;
      try {
        tokenData = await exchangeCodeForToken(shop, code);
      } catch (err) {
        console.error('Shopify token exchange failed:', err?.message || err);
        const reason = encodeURIComponent(String(err?.message || 'token_exchange_failed').slice(0, 160));
        return res.redirect(`/settings/shopify?shopify_error=auth_failed&stage=token&reason=${reason}`);
      }

      // Get store information
      let storeInfo;
      try {
        storeInfo = await getStoreInfo(shop, tokenData.access_token);
      } catch (err) {
        console.error('Shopify getStoreInfo failed:', err?.message || err);
        return res.redirect('/settings/shopify?shopify_error=auth_failed&stage=store');
      }

      // Save connection to database
      try {
        const { ShopifyStore } = await import('../schemas/mongodb.mjs');
        await ShopifyStore.findOneAndUpdate(
          { user_id: userId },
          {
            user_id: userId,
            shop_domain: shop,
            access_token: tokenData.access_token,
            scopes: tokenData.scope.split(','),
            is_active: true,
            store_info: storeInfo,
            last_sync_ts: Date.now(),
            sync_enabled: true,
            inventory_sync_enabled: false,
            abandoned_cart_enabled: false,
            order_notifications_enabled: true
          },
          { upsert: true, new: true }
        );
      } catch (err) {
        console.error('Shopify DB save failed:', err?.message || err);
        return res.redirect('/settings/shopify?shopify_error=auth_failed&stage=db');
      }

      // Register webhook for order updates
      try {
        const webhookUrl = `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/shopify/webhook`;
        await registerWebhook(userId, shop, tokenData.access_token, webhookUrl);
      } catch (webhookError) {
        console.warn('Failed to register webhook:', webhookError.message);
        // Don't fail the whole setup if webhook registration fails
      }

      res.redirect('/settings/shopify?shopify_success=true');
    } catch (error) {
      console.error('Shopify OAuth callback failed:', error);
      res.redirect('/settings/shopify?shopify_error=auth_failed&stage=unknown');
    }
  });

  // Shopify webhook endpoint
  app.post("/shopify/webhook", async (req, res) => {
    if (!isShopifyEnabled()) {
      return res.status(400).send('Shopify not configured');
    }

    const signature = req.headers['x-shopify-hmac-sha256'];
    const topic = req.headers['x-shopify-topic'];
    const shopDomain = req.headers['x-shopify-shop-domain'];

    // Verify webhook signature
    if (!verifyWebhook(req.rawBody, signature)) {
      console.error('Invalid webhook signature');
      return res.status(401).send('Invalid signature');
    }

    try {
      await handleWebhook(topic, req.body);
      res.json({ received: true });
    } catch (error) {
      console.error('Webhook handling failed:', error);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  // Get Shopify connection status
  app.get("/api/shopify/status", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);

    try {
      const status = await getStoreConnection(userId);
      res.json(status);
    } catch (error) {
      console.error('Failed to get Shopify status:', error);
      res.status(500).json({ error: 'Failed to get connection status' });
    }
  });

  // Disconnect Shopify store
  app.post("/api/shopify/disconnect", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);

    try {
      await disconnectStore(userId);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to disconnect Shopify:', error);
      res.status(500).json({ error: 'Failed to disconnect store' });
    }
  });

  // Sync products
  app.post("/api/shopify/sync/products", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);

    try {
      const connection = await getStoreConnection(userId);
      if (!connection.connected) {
        return res.status(400).json({ error: 'Shopify not connected' });
      }

      const { ShopifyStore } = await import('../schemas/mongodb.mjs');
      const store = await ShopifyStore.findOne({ user_id: userId });

      const result = await syncProducts(userId, store.shop_domain, store.access_token);
      res.json(result);
    } catch (error) {
      console.error('Failed to sync products:', error);
      res.status(500).json({ error: 'Failed to sync products' });
    }
  });

  // Sync orders
  app.post("/api/shopify/sync/orders", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);

    try {
      const connection = await getStoreConnection(userId);
      if (!connection.connected) {
        return res.status(400).json({ error: 'Shopify not connected' });
      }

      const { ShopifyStore } = await import('../schemas/mongodb.mjs');
      const store = await ShopifyStore.findOne({ user_id: userId });

      const result = await syncOrders(userId, store.shop_domain, store.access_token);
      res.json(result);
    } catch (error) {
      console.error('Failed to sync orders:', error);
      res.status(500).json({ error: 'Failed to sync orders' });
    }
  });

  // Sync customers
  app.post("/api/shopify/sync/customers", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);

    try {
      const connection = await getStoreConnection(userId);
      if (!connection.connected) {
        return res.status(400).json({ error: 'Shopify not connected' });
      }

      const { ShopifyStore } = await import('../schemas/mongodb.mjs');
      const store = await ShopifyStore.findOne({ user_id: userId });

      const result = await syncCustomers(userId, store.shop_domain, store.access_token);
      res.json(result);
    } catch (error) {
      console.error('Failed to sync customers:', error);
      res.status(500).json({ error: 'Failed to sync customers' });
    }
  });

  // Get product catalog
  app.get("/api/shopify/products", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { limit, search, category } = req.query;

    try {
      let products;
      if (search) {
        products = await searchProducts(userId, search, { limit: parseInt(limit) || 50 });
      } else {
        products = await getProductCatalog(userId, {
          limit: parseInt(limit) || 50,
          category
        });
      }

      res.json({ products });
    } catch (error) {
      console.error('Failed to get products:', error);
      res.status(500).json({ error: 'Failed to retrieve products' });
    }
  });

  // Get specific product
  app.get("/api/shopify/products/:productId", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { productId } = req.params;

    try {
      const { ShopifyProduct } = await import('../schemas/mongodb.mjs');
      const product = await ShopifyProduct.findOne({
        user_id: userId,
        shopify_id: productId
      }).lean();

      if (!product) {
        return res.status(404).json({ error: 'Product not found' });
      }

      res.json({ product });
    } catch (error) {
      console.error('Failed to get product:', error);
      res.status(500).json({ error: 'Failed to retrieve product' });
    }
  });

  // Get orders
  app.get("/api/shopify/orders", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { limit = 50, status, customer_id } = req.query;

    try {
      const { ShopifyOrder } = await import('../schemas/mongodb.mjs');

      const query = { user_id: userId };
      if (status) query.financial_status = status;
      if (customer_id) query['customer.id'] = customer_id;

      const orders = await ShopifyOrder.find(query)
        .sort({ created_at_shopify: -1 })
        .limit(parseInt(limit))
        .lean();

      res.json({ orders });
    } catch (error) {
      console.error('Failed to get orders:', error);
      res.status(500).json({ error: 'Failed to retrieve orders' });
    }
  });

  // Get specific order
  app.get("/api/shopify/orders/:orderId", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { orderId } = req.params;

    try {
      const { ShopifyOrder } = await import('../schemas/mongodb.mjs');
      const order = await ShopifyOrder.findOne({
        user_id: userId,
        shopify_id: orderId
      }).lean();

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      res.json({ order });
    } catch (error) {
      console.error('Failed to get order:', error);
      res.status(500).json({ error: 'Failed to retrieve order' });
    }
  });

  // Create order
  app.post("/api/shopify/orders", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const orderData = req.body;

    try {
      const connection = await getStoreConnection(userId);
      if (!connection.connected) {
        return res.status(400).json({ error: 'Shopify not connected' });
      }

      const { ShopifyStore } = await import('../schemas/mongodb.mjs');
      const store = await ShopifyStore.findOne({ user_id: userId });

      const order = await createOrder(userId, store.shop_domain, store.access_token, orderData);
      res.json({ order });
    } catch (error) {
      console.error('Failed to create order:', error);
      res.status(500).json({ error: 'Failed to create order' });
    }
  });

  // Update order fulfillment
  app.post("/api/shopify/orders/:orderId/fulfill", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { orderId } = req.params;
    const trackingInfo = req.body;

    try {
      const connection = await getStoreConnection(userId);
      if (!connection.connected) {
        return res.status(400).json({ error: 'Shopify not connected' });
      }

      const { ShopifyStore } = await import('../schemas/mongodb.mjs');
      const store = await ShopifyStore.findOne({ user_id: userId });

      const fulfillment = await updateOrderFulfillment(userId, store.shop_domain, store.access_token, orderId, trackingInfo);
      res.json({ fulfillment });
    } catch (error) {
      console.error('Failed to update fulfillment:', error);
      res.status(500).json({ error: 'Failed to update order fulfillment' });
    }
  });

  // Update Shopify settings
  app.post("/api/shopify/settings", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const settings = req.body;

    try {
      const { ShopifyStore } = await import('../schemas/mongodb.mjs');

      const updateData = {};
      if (settings.sync_enabled !== undefined) updateData.sync_enabled = settings.sync_enabled;
      if (settings.inventory_sync_enabled !== undefined) updateData.inventory_sync_enabled = settings.inventory_sync_enabled;
      if (settings.abandoned_cart_enabled !== undefined) updateData.abandoned_cart_enabled = settings.abandoned_cart_enabled;
      if (settings.order_notifications_enabled !== undefined) updateData.order_notifications_enabled = settings.order_notifications_enabled;

      await ShopifyStore.findOneAndUpdate(
        { user_id: userId },
        updateData
      );

      res.json({ success: true });
    } catch (error) {
      console.error('Failed to update Shopify settings:', error);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  // WhatsApp Commerce API endpoints

  // Get product catalog for WhatsApp
  app.get("/api/whatsapp/shopify/products", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { limit = 10, search } = req.query;

    try {
      let products;
      if (search) {
        products = await searchProducts(userId, search, { limit: parseInt(limit) });
      } else {
        products = await getProductCatalog(userId, { limit: parseInt(limit) });
      }

      // Format for WhatsApp display
      const formattedProducts = products.map(product => ({
        id: product.shopify_id,
        title: product.title,
        price: `$${product.price}`,
        image_url: product.image,
        description: product.body_html ? product.body_html.replace(/<[^>]*>/g, '').substring(0, 100) + '...' : '',
        variants: product.variants?.slice(0, 3) || [] // Limit variants for WhatsApp
      }));

      res.json({ products: formattedProducts });
    } catch (error) {
      console.error('Failed to get WhatsApp products:', error);
      res.status(500).json({ error: 'Failed to retrieve products' });
    }
  });

  // Create order from WhatsApp
  app.post("/api/whatsapp/shopify/orders", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { contact_id, products, customer_info, shipping_address } = req.body;

    try {
      const connection = await getStoreConnection(userId);
      if (!connection.connected) {
        return res.status(400).json({ error: 'Shopify not connected' });
      }

      const { ShopifyStore } = await import('../schemas/mongodb.mjs');
      const store = await ShopifyStore.findOne({ user_id: userId });

      // Transform products to line items
      const lineItems = products.map(product => ({
        variant_id: product.variant_id,
        quantity: product.quantity,
        price: product.price,
        title: product.title
      }));

      const orderData = {
        email: customer_info.email,
        phone: customer_info.phone,
        billing_address: shipping_address,
        shipping_address: shipping_address,
        line_items: lineItems,
        note: `WhatsApp Order - Contact ID: ${contact_id}`,
        tags: ['whatsapp_order']
      };

      const order = await createOrder(userId, store.shop_domain, store.access_token, orderData);

      res.json({
        order_id: order.id,
        order_number: order.order_number,
        total_price: order.total_price,
        status: order.financial_status
      });
    } catch (error) {
      console.error('Failed to create WhatsApp order:', error);
      res.status(500).json({ error: 'Failed to create order' });
    }
  });

  // Shopify settings page
  app.get("/settings/shopify", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const error = req.query.shopify_error;
    const success = req.query.shopify_success;

    try {
      const connection = await getStoreConnection(userId);
      const plan = await getUserPlan(userId);
      const isUpgraded = isPlanUpgraded(plan);
      const email = await getSignedInEmail({ cookies: { get: (name) => req.cookies?.[name] } });
      const redirectUri = getShopifyRedirectUri();
      const hasApiKey = Boolean(process.env.SHOPIFY_API_KEY);
      const hasApiSecret = Boolean(process.env.SHOPIFY_API_SECRET);

      const stage = String(req.query.stage || '');
      const stageLabel = stage ? ` (stage: ${stage})` : '';
      const reasonRaw = String(req.query.reason || '');
      const reasonLabel = (stage === 'token' && reasonRaw) ? ` — ${reasonRaw}` : '';
      const errorMessage = (() => {
        switch (String(error || '')) {
          case 'not_configured':
            return 'Shopify is not configured on the server. Ask the app owner to set SHOPIFY_API_KEY and SHOPIFY_API_SECRET in the deployment environment.';
          case 'missing_shop':
            return 'Please enter your Shopify store domain (e.g. mystore.myshopify.com).';
          case 'invalid_shop':
            return 'Please enter a valid Shopify store domain ending in .myshopify.com (e.g. code-orbit-dev.myshopify.com).';
          case 'missing_params':
            return 'Shopify did not return the expected OAuth parameters. Please try connecting again.';
          case 'oauth_init_failed':
            return 'Failed to start Shopify OAuth. Double-check your store domain and app configuration.';
          case 'auth_failed':
            return `Shopify authorization failed${stageLabel}${reasonLabel}. If this is stage "token", verify SHOPIFY_API_KEY/SHOPIFY_API_SECRET match the same app in Shopify Partners.`;
          default:
            return error ? 'Failed to connect. Please try again.' : '';
        }
      })();

      const html = `
        <html>${getProfessionalHead('Shopify Integration')}<body>
        <script src="/toast.js"></script>
        <style>
            .shopify-wrap {
              max-width: 1080px;
              margin: 0 auto;
            }
            .shopify-hero {
              background: linear-gradient(135deg, #96BF48 0%, #5E8E3E 100%);
              border-radius: 16px;
              padding: 40px;
              color: white;
              text-align: center;
              margin-bottom: 24px;
            }
            .shopify-hero img {
              width: 80px;
              height: 80px;
              margin-bottom: 16px;
            }
            .shopify-hero h1 {
              color: white;
              margin: 0 0 12px 0;
              font-size: 28px;
            }
            .shopify-hero p {
              opacity: 0.9;
              margin: 0 0 24px 0;
              font-size: 16px;
            }
            .connect-form {
              background: rgba(255,255,255,0.15);
              border-radius: 12px;
              padding: 24px;
              max-width: 500px;
              margin: 0 auto;
            }
            .connect-form input {
              width: 100%;
              padding: 14px 16px;
              border: 2px solid rgba(255,255,255,0.3);
              border-radius: 8px;
              background: rgba(255,255,255,0.9);
              font-size: 16px;
              margin-bottom: 16px;
              box-sizing: border-box;
            }
            .connect-form input:focus {
              outline: none;
              border-color: white;
              background: white;
            }
            .connect-form input::placeholder {
              color: #666;
            }
            .connect-btn {
              width: 100%;
              padding: 14px 24px;
              background: white;
              color: #5E8E3E;
              border: none;
              border-radius: 8px;
              font-size: 16px;
              font-weight: 600;
              cursor: pointer;
              transition: all 0.2s;
            }
            .connect-btn:hover {
              transform: translateY(-2px);
              box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            }
            .connected-card {
              background: white;
              border: 1px solid #e5e7eb;
              border-radius: 16px;
              padding: 22px;
              margin-bottom: 24px;
              box-shadow: 0 6px 18px rgba(17, 24, 39, 0.06);
            }
            .connected-header {
              display: flex;
              align-items: center;
              gap: 16px;
              margin-bottom: 18px;
            }
            .connected-badge {
              background: rgba(150, 191, 72, 0.14);
              color: #2f6b2f;
              padding: 6px 10px;
              border-radius: 999px;
              font-size: 12px;
              font-weight: 600;
              border: 1px solid rgba(150, 191, 72, 0.28);
              display: inline-flex;
              align-items: center;
              gap: 6px;
            }
            .store-name {
              font-size: 18px;
              font-weight: 600;
              color: #1f2937;
              margin-top: 6px;
              word-break: break-word;
            }
            .shopify-subtle {
              color: #6b7280;
              font-size: 13px;
              margin-top: 4px;
            }
            .shopify-stats {
              display: grid;
              grid-template-columns: repeat(3, minmax(0, 1fr));
              gap: 12px;
              margin: 14px 0 22px 0;
            }
            .shopify-stat {
              background: #f9fafb;
              border: 1px solid #eef0f3;
              border-radius: 12px;
              padding: 14px 12px;
              text-align: left;
            }
            .shopify-stat .label {
              font-size: 12px;
              color: #6b7280;
              margin-bottom: 6px;
            }
            .shopify-stat .value {
              font-weight: 700;
              color: #111827;
              display: flex;
              gap: 8px;
              align-items: center;
            }
            .settings-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
              gap: 16px;
              margin: 24px 0;
            }
            .setting-item {
              display: flex;
              align-items: center;
              gap: 12px;
              padding: 16px;
              background: #f9fafb;
              border-radius: 8px;
              border: 1px solid #eef0f3;
            }
            .setting-item input[type="checkbox"] {
              width: 20px;
              height: 20px;
              accent-color: #96BF48;
            }
            .actions-grid {
              display: flex;
              flex-wrap: wrap;
              gap: 12px;
              margin-top: 20px;
            }
            .actions-grid .btn-primary,
            .actions-grid .btn-ghost,
            .actions-grid .btn-danger {
              padding: 10px 14px;
              border-radius: 10px;
            }
            .features-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
              gap: 16px;
              margin-top: 24px;
            }
            .feature-card {
              background: white;
              border: 1px solid #e5e7eb;
              border-radius: 12px;
              padding: 20px;
            }
            .feature-card h4 {
              margin: 0 0 8px 0;
              display: flex;
              align-items: center;
              gap: 8px;
            }
            .feature-card p {
              margin: 0;
              color: #6b7280;
              font-size: 14px;
            }
            .alert {
              padding: 16px;
              border-radius: 8px;
              margin-bottom: 20px;
            }
            .alert-success {
              background: #d1fae5;
              color: #065f46;
              border: 1px solid #a7f3d0;
            }
            .alert-error {
              background: #fee2e2;
              color: #991b1b;
              border: 1px solid #fecaca;
            }
          </style>
        <div class="container">
          ${renderTopbar('<a href="/dashboard">Dashboard</a> / <a href="/settings">Settings</a> / Shopify', email)}
          <div class="layout">
            ${renderSidebar('settings', { showBookings: !!isUpgraded, isUpgraded })}
            <main class="main">
              <div class="shopify-wrap">
              <script>
                (function(){
                  var toastSuccess = ${JSON.stringify(success ? 'Successfully connected to Shopify!' : '')};
                  var toastError = ${JSON.stringify(errorMessage || '')};
                  if (window.Toast) {
                    if (toastSuccess) window.Toast.success(toastSuccess);
                    if (toastError) window.Toast.error(toastError);
                  }
                })();
              </script>

              ${(!hasApiKey || !hasApiSecret) ? `
                <div class="alert" style="background:#fff7ed; color:#9a3412; border:1px solid #fed7aa;">
                  <div style="font-weight:700; margin-bottom:6px;">Server configuration needed</div>
                  <div class="small" style="margin-bottom:10px;">
                    This deployment is missing Shopify credentials. Add these environment variables and redeploy:
                    <ul style="margin:8px 0 0 18px;">
                      <li><code>SHOPIFY_API_KEY</code> ${hasApiKey ? '✅' : '❌ missing'}</li>
                      <li><code>SHOPIFY_API_SECRET</code> ${hasApiSecret ? '✅' : '❌ missing'}</li>
                      <li><code>PUBLIC_BASE_URL</code> should be your domain (recommended)</li>
                    </ul>
                  </div>
                  <div class="small">
                    In Shopify Partners → App setup → Allowed redirection URL(s), add:
                    <div style="margin-top:6px; padding:10px; border:1px dashed #fdba74; border-radius:8px; background:#fff;">
                      <code>${redirectUri}</code>
                    </div>
                  </div>
                </div>
              ` : ''}

              ${!connection.connected ? `
                <div class="shopify-hero">
                  <svg width="80" height="80" viewBox="0 0 109 124" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M95.8 23.4c-.1-.6-.6-1-1.1-1-.5 0-9.3-.2-9.3-.2s-7.4-7.2-8.1-7.9c-.8-.8-2.3-.5-2.9-.4-.1 0-1.5.5-4.1 1.3-2.4-7-6.7-13.4-14.2-13.4h-.7c-2.1-2.8-4.8-4-7-4-17.4 0-25.7 21.7-28.3 32.8-6.8 2.1-11.6 3.6-12.2 3.8-3.8 1.2-3.9 1.3-4.4 4.9-.4 2.7-10.3 79.2-10.3 79.2l75.8 14.2 41-8.9S96 24 95.8 23.4zM66.9 19l-14 4.3V22c0-4.5-.6-8.2-1.7-11.1 4.3.7 7.2 5.5 8.7 9.8.1.3.1.5.2.7l6.8-2.4zM52.2 11.5c1.2 2.8 2 6.7 2 12v.9l-18.5 5.7c3.6-13.7 10.2-18.5 16.5-18.6zM44.5 3.4c.5 0 .9.2 1.4.5-7.9 3.7-16.3 13-19.9 31.5l-13.8 4.3C16.1 25.4 25.5 3.4 44.5 3.4z" fill="white"/>
                    <path d="M94.7 22.4c-.5 0-9.3-.2-9.3-.2s-7.4-7.2-8.1-7.9c-.3-.3-.7-.4-1.1-.5l-5.7 116.5 41-8.9S96 24 95.8 23.4c-.1-.6-.6-1-1.1-1z" fill="white" fill-opacity="0.5"/>
                    <path d="M58.8 42.2l-4.4 13.1s-3.9-2.1-8.6-2.1c-7 0-7.3 4.4-7.3 5.5 0 6 15.8 8.3 15.8 22.4 0 11.1-7 18.2-16.5 18.2-11.4 0-17.2-7.1-17.2-7.1l3-10s6 5.1 11.1 5.1c3.3 0 4.7-2.6 4.7-4.5 0-7.9-13-8.2-13-21.1 0-10.8 7.8-21.3 23.5-21.3 6.1 0 8.9 1.8 8.9 1.8z" fill="#5E8E3E"/>
                  </svg>
                  <h1>Connect Your Shopify Store</h1>
                  <p>Enable e-commerce features in WhatsApp. Let customers browse products, place orders, and get updates directly in chat.</p>
                  
                  <div class="connect-form">
                    <form action="/shopify/auth" method="GET" id="connectForm">
                      <input type="text" id="shop" name="shop" placeholder="yourstore.myshopify.com" required autocomplete="off">
                      <button type="submit" class="connect-btn">
                        🔗 Connect to Shopify
                      </button>
                    </form>
                    <p style="font-size: 12px; margin-top: 16px; opacity: 0.8;">
                      Enter your Shopify store URL (e.g., mystore.myshopify.com)
                    </p>
                    <p style="font-size: 12px; margin-top: 10px; opacity: 0.85;">
                      Redirect URL used by this app: <code style="background:rgba(255,255,255,0.25); padding:2px 6px; border-radius:6px;">${redirectUri}</code>
                    </p>
                  </div>
                </div>

                <div class="features-grid">
                  <div class="feature-card">
                    <h4>📦 Product Catalog</h4>
                    <p>Customers can browse your products directly in WhatsApp conversations</p>
                  </div>
                  <div class="feature-card">
                    <h4>🛒 Easy Ordering</h4>
                    <p>Enable customers to place orders through chat with guided checkout</p>
                  </div>
                  <div class="feature-card">
                    <h4>📱 Order Notifications</h4>
                    <p>Automatically notify customers about order status and shipping updates</p>
                  </div>
                  <div class="feature-card">
                    <h4>🛍️ Cart Recovery</h4>
                    <p>Send reminders for abandoned carts to recover potential sales</p>
                  </div>
                  <div class="feature-card">
                    <h4>📊 Inventory Sync</h4>
                    <p>Keep your WhatsApp catalog in sync with Shopify inventory</p>
                  </div>
                  <div class="feature-card">
                    <h4>💬 AI Commerce</h4>
                    <p>AI-powered product recommendations and shopping assistance</p>
                  </div>
                </div>
              ` : `
                <div class="connected-card">
                  <div class="connected-header">
                    <img src="/shopify-icon.png" alt="Shopify" style="width:40px; height:40px;"/>
                    <div>
                      <span class="connected-badge">✓ Connected</span>
                      <div class="store-name">${connection.shop_domain}</div>
                      <div class="shopify-subtle">Manage sync and commerce settings for this store.</div>
                    </div>
                    <div style="margin-left:auto; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                      <a href="/dashboard/shopify" class="btn-primary" style="text-decoration:none;">Open Shopify Dashboard</a>
                    </div>
                  </div>
                  
                  <div class="shopify-stats">
                    <div class="shopify-stat">
                      <div class="label">Status</div>
                      <div class="value" style="color:${connection.is_active ? '#059669' : '#dc2626'};">
                        <span>${connection.is_active ? '●' : '●'}</span>
                        <span>${connection.is_active ? 'Active' : 'Inactive'}</span>
                      </div>
                    </div>
                    <div class="shopify-stat">
                      <div class="label">Last sync</div>
                      <div class="value">${connection.last_sync_ts ? new Date(connection.last_sync_ts).toLocaleDateString() : 'Never'}</div>
                    </div>
                    <div class="shopify-stat">
                      <div class="label">Order notifications</div>
                      <div class="value">${connection.order_notifications_enabled ? 'Enabled' : 'Disabled'}</div>
                    </div>
                  </div>

                  <h3 style="margin: 0 0 12px 0;">Settings</h3>
                  <form id="shopifySettingsForm">
                    <div class="settings-grid">
                      <label class="setting-item">
                        <input type="checkbox" id="sync_enabled" ${connection.sync_enabled ? 'checked' : ''}>
                        <span>Auto-sync products & orders</span>
                      </label>
                      <label class="setting-item">
                        <input type="checkbox" id="inventory_sync_enabled" ${connection.inventory_sync_enabled ? 'checked' : ''}>
                        <span>Sync inventory levels</span>
                      </label>
                      <label class="setting-item">
                        <input type="checkbox" id="abandoned_cart_enabled" ${connection.abandoned_cart_enabled ? 'checked' : ''}>
                        <span>Abandoned cart recovery</span>
                      </label>
                      <label class="setting-item">
                        <input type="checkbox" id="order_notifications_enabled" ${connection.order_notifications_enabled ? 'checked' : ''}>
                        <span>WhatsApp order notifications</span>
                      </label>
                    </div>
                    <button type="submit" class="btn-primary" style="margin-top: 16px;">Save Settings</button>
                  </form>

                  <h3 style="margin: 24px 0 12px 0;">Actions</h3>
                  <div class="actions-grid">
                    <button id="syncProducts" class="btn-primary" type="button">Sync Products</button>
                    <button id="syncOrders" class="btn-primary" type="button">Sync Orders</button>
                    <button id="syncCustomers" class="btn-primary" type="button">Sync Customers</button>
                    <button id="disconnectStore" class="btn-danger" type="button">Disconnect Store</button>
                  </div>
                </div>

                <div class="features-grid">
                  <div class="feature-card">
                    <h4>📦 Product Catalog</h4>
                    <p>Customers can browse your products directly in WhatsApp conversations</p>
                  </div>
                  <div class="feature-card">
                    <h4>🛒 Easy Ordering</h4>
                    <p>Enable customers to place orders through chat with guided checkout</p>
                  </div>
                  <div class="feature-card">
                    <h4>📱 Order Notifications</h4>
                    <p>Automatically notify customers about order status and shipping updates</p>
                  </div>
                  <div class="feature-card">
                    <h4>🛍️ Cart Recovery</h4>
                    <p>Send reminders for abandoned carts to recover potential sales</p>
                  </div>
                </div>
              `}
              </div>
            </main>
          </div>
        </div>

          <script>
            // Auto-format shop URL
            document.getElementById('shop')?.addEventListener('blur', function() {
              let val = this.value.trim().toLowerCase();
              // Remove https:// or http://
              val = val.replace(/^https?:\\/\\//, '');
              // Remove trailing slash
              val = val.replace(/\\/$/, '');
              // Add .myshopify.com if not present
              if (val && !val.includes('.myshopify.com') && !val.includes('.')) {
                val = val + '.myshopify.com';
              }
              this.value = val;
            });

            ${connection.connected ? `
              document.getElementById('shopifySettingsForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const btn = e.target.querySelector('button[type="submit"]');
                btn.textContent = 'Saving...';
                btn.disabled = true;
                
                const formData = {
                  sync_enabled: document.getElementById('sync_enabled').checked,
                  inventory_sync_enabled: document.getElementById('inventory_sync_enabled').checked,
                  abandoned_cart_enabled: document.getElementById('abandoned_cart_enabled').checked,
                  order_notifications_enabled: document.getElementById('order_notifications_enabled').checked
                };

                try {
                  const response = await fetch('/api/shopify/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(formData)
                  });
                  const result = await response.json();
                  if (result.success) {
                    btn.textContent = '✓ Saved!';
                    setTimeout(() => { btn.textContent = 'Save Settings'; btn.disabled = false; }, 2000);
                  } else {
                    throw new Error('Failed');
                  }
                } catch (error) {
                  btn.textContent = 'Save Settings';
                  btn.disabled = false;
                  alert('Error saving settings');
                }
              });

              async function syncWithFeedback(endpoint, btn, successMsg) {
                const originalText = btn.textContent;
                btn.textContent = 'Syncing...';
                btn.disabled = true;
                try {
                  const response = await fetch(endpoint, { method: 'POST' });
                  const result = await response.json();
                  btn.textContent = '✓ Done!';
                  alert(successMsg(result));
                } catch (error) {
                  alert('Sync failed. Please try again.');
                } finally {
                  setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
                }
              }

              document.getElementById('syncProducts').addEventListener('click', function() {
                syncWithFeedback('/api/shopify/sync/products', this, r => \`Synced \${r.products_count || 0} products\`);
              });

              document.getElementById('syncOrders').addEventListener('click', function() {
                syncWithFeedback('/api/shopify/sync/orders', this, r => \`Synced \${r.orders_count || 0} orders\`);
              });

              document.getElementById('syncCustomers').addEventListener('click', async () => {
                try {
                  const response = await fetch('/api/shopify/sync/customers', { method: 'POST' });
                  const result = await response.json();
                  alert(\`Synced \${result.customers_count} customers\`);
                } catch (error) {
                  alert('Failed to sync customers');
                }
              });

              document.getElementById('disconnectStore').addEventListener('click', async () => {
                if (confirm('Are you sure you want to disconnect your Shopify store?')) {
                  try {
                    const response = await fetch('/api/shopify/disconnect', { method: 'POST' });
                    const result = await response.json();
                    if (result.success) {
                      location.reload();
                    } else {
                      alert('Failed to disconnect store');
                    }
                  } catch (error) {
                    alert('Error disconnecting store');
                  }
                }
              });
            ` : ''}
          </script>
        </body></html>
      `;

      res.send(html);
    } catch (error) {
      console.error('Failed to render Shopify settings:', error);
      res.status(500).send('Failed to load Shopify settings');
    }
  });

  // Full Shopify Dashboard
  app.get("/dashboard/shopify", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);

    try {
      const connection = await getStoreConnection(userId);
      const plan = await getUserPlan(userId);
      const isUpgraded = isPlanUpgraded(plan);
      const email = await getSignedInEmail({ cookies: { get: (name) => req.cookies?.[name] } });

      if (!connection.connected) {
        const html = `
          <html>${getProfessionalHead('Shopify Dashboard')}<body>
          <div class="container">
            ${renderTopbar('<a href="/dashboard">Dashboard</a> / Shopify', email)}
            <div class="layout">
              ${renderSidebar('dashboard', { showBookings: !!isUpgraded, isUpgraded })}
              <main class="main">
                <div class="section" style="text-align:center; padding:60px 20px;">
                  <svg width="80" height="80" viewBox="0 0 109 124" fill="#96BF48" xmlns="http://www.w3.org/2000/svg" style="margin-bottom:24px;">
                    <path d="M95.8 23.4c-.1-.6-.6-1-1.1-1-.5 0-9.3-.2-9.3-.2s-7.4-7.2-8.1-7.9c-.8-.8-2.3-.5-2.9-.4-.1 0-1.5.5-4.1 1.3-2.4-7-6.7-13.4-14.2-13.4h-.7c-2.1-2.8-4.8-4-7-4-17.4 0-25.7 21.7-28.3 32.8-6.8 2.1-11.6 3.6-12.2 3.8-3.8 1.2-3.9 1.3-4.4 4.9-.4 2.7-10.3 79.2-10.3 79.2l75.8 14.2 41-8.9S96 24 95.8 23.4z"/>
                  </svg>
                  <h2 style="margin:0 0 12px 0;">🔗 Connect Your Shopify Store</h2>
                  <p style="color:#6b7280; margin:0 0 24px 0;">Connect your Shopify store to access the full e-commerce dashboard and WhatsApp commerce features.</p>
                  <a href="/settings/shopify" class="btn-primary" style="display:inline-block; padding:12px 24px; text-decoration:none; border-radius:8px;">Connect Store →</a>
                </div>
              </main>
            </div>
          </div>
          </body></html>
        `;
        return res.send(html);
      }

      // Get recent orders and products
      const { ShopifyOrder, ShopifyProduct } = await import('../schemas/mongodb.mjs');

      const recentOrders = await ShopifyOrder.find({ user_id: userId })
        .sort({ created_at_shopify: -1 })
        .limit(5)
        .lean();

      const products = await ShopifyProduct.find({ user_id: userId, status: 'active' })
        .sort({ updated_at_shopify: -1 })
        .limit(8)
        .lean();

      const html = `
        <html>${getProfessionalHead('Shopify Dashboard')}<body>
        <div class="container">
          ${renderTopbar('<a href="/dashboard">Dashboard</a> / Shopify', email)}
          <div class="layout">
            ${renderSidebar('dashboard', { showBookings: !!isUpgraded, isUpgraded })}
            <main class="main">
              <div class="section">
                <h2 style="margin:0 0 8px 0;">🛍️ Shopify Dashboard</h2>
                <p class="small" style="margin:0 0 24px 0; color:#6b7280;">Manage your e-commerce store and WhatsApp commerce</p>
              </div>

              <div class="card" style="background:linear-gradient(135deg, #96BF48 0%, #5E8E3E 100%); color:white; margin-bottom:24px;">
                <div style="display: flex; align-items: center; gap: var(--space-3);">
                  <img src="/shopify-icon.svg" alt="Shopify" style="width: 32px; height: 32px;">
                  <div>
                    <h3 style="margin: 0; color: white;">${connection.shop_domain}</h3>
                    <p style="margin: 0; opacity: 0.9;">Last sync: ${connection.last_sync_ts ? new Date(connection.last_sync_ts).toLocaleString() : 'Never'}</p>
                  </div>
                </div>
                <div style="display: flex; gap: var(--space-2);">
                  <button id="syncProductsBtn" class="btn" style="background: rgba(255,255,255,0.2); color: white; border: 1px solid rgba(255,255,255,0.3);">Sync Products</button>
                  <button id="syncOrdersBtn" class="btn" style="background: rgba(255,255,255,0.2); color: white; border: 1px solid rgba(255,255,255,0.3);">Sync Orders</button>
                  <a href="/settings/shopify" class="btn" style="background: rgba(255,255,255,0.2); color: white; border: 1px solid rgba(255,255,255,0.3);">Settings</a>
                </div>
              </div>

              <div class="dashboard-grid">
                <!-- Recent Orders -->
                <div class="dashboard-card">
                  <div class="dashboard-card-header">
                    <h3>📦 Recent Orders</h3>
                    <a href="/dashboard/shopify/orders" class="btn btn-secondary">View All</a>
                  </div>
                  <div class="shopify-orders-grid">
                    ${recentOrders.map(order => `
                      <div class="shopify-order-card">
                        <div class="shopify-order-header">
                          <span class="shopify-order-number">#${order.order_number}</span>
                          <span class="shopify-order-status ${order.financial_status?.toLowerCase()}">${order.financial_status}</span>
                        </div>
                        <div class="shopify-order-details">
                          <div class="shopify-order-info">
                            <div class="shopify-order-info-label">Customer</div>
                            <div class="shopify-order-info-value">${order.customer?.first_name} ${order.customer?.last_name}</div>
                          </div>
                          <div class="shopify-order-info">
                            <div class="shopify-order-info-label">Total</div>
                            <div class="shopify-order-info-value">$${order.total_price}</div>
                          </div>
                          <div class="shopify-order-info">
                            <div class="shopify-order-info-label">Date</div>
                            <div class="shopify-order-info-value">${new Date(order.created_at_shopify).toLocaleDateString()}</div>
                          </div>
                          <div class="shopify-order-info">
                            <div class="shopify-order-info-label">Items</div>
                            <div class="shopify-order-info-value">${order.line_items?.length || 0} items</div>
                          </div>
                        </div>
                      </div>
                    `).join('')}
                  </div>
                </div>

                <!-- Products -->
                <div class="dashboard-card">
                  <div class="dashboard-card-header">
                    <h3>🛍️ Products</h3>
                    <a href="/dashboard/shopify/products" class="btn btn-secondary">View All</a>
                  </div>
                  <div class="shopify-products-grid">
                    ${products.map(product => `
                      <div class="shopify-product-card">
                        <img src="${product.images?.[0]?.src || '/placeholder.png'}" alt="${product.title}" class="shopify-product-image">
                        <div class="shopify-product-info">
                          <h4 class="shopify-product-title">${product.title}</h4>
                          <div class="shopify-product-price">$${product.variants?.[0]?.price || '0'}</div>
                          <p class="shopify-product-description">${product.body_html ? product.body_html.replace(/<[^>]*>/g, '').substring(0, 100) + '...' : 'No description'}</p>
                          <div class="shopify-product-actions">
                            <button class="btn btn-primary btn-sm">Edit</button>
                            <button class="btn btn-secondary btn-sm">View</button>
                          </div>
                        </div>
                      </div>
                    `).join('')}
                  </div>
                </div>
              </div>

              <!-- Commerce Features -->
              <div class="section" style="margin-top:24px;">
                <h3 style="margin:0 0 16px 0;">🚀 WhatsApp Commerce Features</h3>
                <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:12px;">
                  <div class="card" style="padding:12px;">📦 Product catalog browsing via WhatsApp</div>
                  <div class="card" style="padding:12px;">🛒 Order placement through chat</div>
                  <div class="card" style="padding:12px;">📱 Order status notifications</div>
                  <div class="card" style="padding:12px;">🚚 Shipping tracking updates</div>
                  <div class="card" style="padding:12px;">🛍️ Abandoned cart recovery</div>
                  <div class="card" style="padding:12px;">📊 Inventory synchronization</div>
                  <div class="card" style="padding:12px;">💬 Automated customer support</div>
                  <div class="card" style="padding:12px;">💳 Payment processing integration</div>
                </div>
              </div>
            </main>
          </div>
        </div>

          <script>
            // Shopify Dashboard JavaScript
            document.getElementById('syncProductsBtn').addEventListener('click', async () => {
              const btn = document.getElementById('syncProductsBtn');
              btn.textContent = 'Syncing...';
              btn.disabled = true;

              try {
                const response = await fetch('/api/shopify/sync/products', { method: 'POST' });
                const result = await response.json();
                alert(\`Synced \${result.products_count} products\`);
                location.reload();
              } catch (error) {
                alert('Failed to sync products');
              } finally {
                btn.textContent = 'Sync Products';
                btn.disabled = false;
              }
            });

            document.getElementById('syncOrdersBtn').addEventListener('click', async () => {
              const btn = document.getElementById('syncOrdersBtn');
              btn.textContent = 'Syncing...';
              btn.disabled = true;

              try {
                const response = await fetch('/api/shopify/sync/orders', { method: 'POST' });
                const result = await response.json();
                alert(\`Synced \${result.orders_count} orders\`);
                location.reload();
              } catch (error) {
                alert('Failed to sync orders');
              } finally {
                btn.textContent = 'Sync Orders';
                btn.disabled = false;
              }
            });
          </script>
        </body></html>
      `;

      res.send(html);
    } catch (error) {
      console.error('Failed to render Shopify dashboard:', error);
      res.status(500).send('Failed to load Shopify dashboard');
    }
  });
}
