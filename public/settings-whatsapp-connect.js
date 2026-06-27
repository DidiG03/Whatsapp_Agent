(function () {
  function initWhatsAppConnect() {
    const card = document.getElementById('wa-connect-card');
    if (!card) return;

    const config = window.__META_WA_CONNECT__ || {};
    const statusEl = document.getElementById('wa-connect-status');
    const errorEl = document.getElementById('wa-connect-error');
    const successEl = document.getElementById('wa-connect-success');
    const connectBtn = document.getElementById('wa-connect-btn');
    const manualConnectBtn = document.getElementById('wa-manual-connect-btn');
    const manualSetupEl = document.getElementById('wa-manual-setup');
    const disconnectBtn = document.getElementById('wa-connect-disconnect');
    const testBtn = document.getElementById('wa-connect-test');
    const detailsEl = document.getElementById('wa-connect-details');
    let pendingSignup = null;
    let pendingCode = null;

    function setInlineMessage(el, message) {
      if (!el) return;
      if (message) {
        el.textContent = message;
        el.hidden = false;
      } else {
        el.textContent = '';
        el.hidden = true;
      }
    }

    function renderStatus(data) {
      if (!data) return;
      const connected = !!data.connected;
      const nextStepEl = document.getElementById('wa-connect-next-step');
      if (statusEl) {
        statusEl.textContent = '';
        const dot = document.createElement('span');
        dot.className = 'wa-connect-status__dot' + (connected ? ' wa-connect-status__dot--ok' : '');
        const label = document.createElement('span');
        const strong = document.createElement('strong');
        strong.textContent = connected ? 'Connected' : 'Not connected';
        label.appendChild(strong);
        statusEl.appendChild(dot);
        statusEl.appendChild(label);
      }
      if (connectBtn) connectBtn.textContent = connected ? 'Reconnect WhatsApp' : 'Connect WhatsApp';
      if (disconnectBtn) disconnectBtn.hidden = !connected;
      if (testBtn) testBtn.hidden = !connected;
      if (nextStepEl) nextStepEl.hidden = connected;
      if (detailsEl) {
        detailsEl.hidden = !connected;
        const phoneId = document.getElementById('wa-connected-phone-id');
        const wabaId = document.getElementById('wa-connected-waba-id');
        const businessPhone = document.getElementById('wa-connected-business-phone');
        if (phoneId) phoneId.textContent = data.phoneNumberId || '\u2014';
        if (wabaId) wabaId.textContent = data.wabaId || '\u2014';
        if (businessPhone) {
          businessPhone.textContent = data.businessPhone
            ? ('+' + String(data.businessPhone).replace(/\D/g, ''))
            : '\u2014';
        }
      }
    }

    async function refreshStatus() {
      try {
        const resp = await window.authManager.authenticatedFetch('/api/settings/whatsapp/status', {
          headers: { Accept: 'application/json' }
        });
        const data = await resp.json();
        if (resp.ok) {
          renderStatus(data);
          if (!data.connected) {
            setInlineMessage(errorEl, '');
          }
        }
      } catch (_) {}
    }

    function readManualField(name) {
      const field = document.querySelector('input[name="' + name + '"]');
      return field ? String(field.value || '').trim() : '';
    }

    function applyConnectionFields(data) {
      const verifyField = document.querySelector('input[name="verify_token"]');
      if (verifyField && data.verify_token) verifyField.value = data.verify_token;
      const phoneField = document.querySelector('input[name="phone_number_id"]');
      if (phoneField && data.phone_number_id) phoneField.value = data.phone_number_id;
      const wabaField = document.querySelector('input[name="waba_id"]');
      if (wabaField && data.waba_id) wabaField.value = data.waba_id;
      const businessPhoneField = document.querySelector('input[name="business_phone"]');
      if (businessPhoneField && data.business_phone) businessPhoneField.value = data.business_phone;
    }

    function openManualSetup() {
      if (!manualSetupEl) return;
      manualSetupEl.open = true;
      manualSetupEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const phoneField = document.querySelector('input[name="phone_number_id"]');
      if (phoneField) phoneField.focus();
    }

    async function connectManually() {
      const phoneNumberId = readManualField('phone_number_id');
      const whatsappToken = readManualField('whatsapp_token');
      const wabaId = readManualField('waba_id');
      const businessPhone = readManualField('business_phone');
      const verifyToken = readManualField('verify_token');

      if (!phoneNumberId) {
        setInlineMessage(errorEl, 'Phone number ID is required for manual setup.');
        openManualSetup();
        return;
      }
      if (!whatsappToken) {
        setInlineMessage(errorEl, 'WhatsApp token is required for manual setup.');
        openManualSetup();
        return;
      }

      setInlineMessage(errorEl, '');
      setInlineMessage(successEl, '');
      if (manualConnectBtn) {
        manualConnectBtn.disabled = true;
        manualConnectBtn.textContent = 'Connecting...';
      }

      try {
        const resp = await window.authManager.authenticatedFetch('/api/settings/whatsapp/connect/manual', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            phone_number_id: phoneNumberId,
            whatsapp_token: whatsappToken,
            waba_id: wabaId || null,
            business_phone: businessPhone || null,
            verify_token: verifyToken || null
          })
        });
        const data = await resp.json();
        if (!resp.ok || !data.success) {
          throw new Error(data.error || 'Failed to connect WhatsApp manually');
        }
        setInlineMessage(successEl, 'WhatsApp connected successfully.');
        renderStatus(data.status || data);
        await refreshStatus();
        applyConnectionFields(data);
      } catch (error) {
        console.error('WhatsApp manual connect failed:', error);
        setInlineMessage(errorEl, (error && error.message) || 'Failed to connect WhatsApp manually.');
        openManualSetup();
      } finally {
        if (manualConnectBtn) {
          manualConnectBtn.disabled = false;
          manualConnectBtn.textContent = 'Connect manually';
        }
      }
    }

    async function completeConnection() {
      if (!pendingCode || !pendingSignup || !pendingSignup.phone_number_id) return;
      setInlineMessage(errorEl, '');
      setInlineMessage(successEl, '');
      if (connectBtn) {
        connectBtn.disabled = true;
        connectBtn.textContent = 'Connecting...';
      }
      try {
        const resp = await window.authManager.authenticatedFetch('/api/settings/whatsapp/connect', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            code: pendingCode,
            phone_number_id: pendingSignup.phone_number_id,
            waba_id: pendingSignup.waba_id || null,
            business_id: pendingSignup.business_id || null
          })
        });
        const data = await resp.json();
        if (!resp.ok || !data.success) {
          throw new Error(data.error || 'Failed to connect WhatsApp');
        }
        pendingSignup = null;
        pendingCode = null;
        setInlineMessage(successEl, 'WhatsApp connected successfully.');
        renderStatus(data.status || data);
        await refreshStatus();
        applyConnectionFields(data);
      } catch (error) {
        console.error('WhatsApp connect failed:', error);
        setInlineMessage(errorEl, (error && error.message) || 'Failed to connect WhatsApp.');
      } finally {
        if (connectBtn) {
          connectBtn.disabled = false;
          connectBtn.textContent = 'Reconnect WhatsApp';
        }
      }
    }

    function tryCompleteConnection() {
      if (pendingCode && pendingSignup && pendingSignup.phone_number_id) {
        completeConnection();
      }
    }

    window.addEventListener('message', function (event) {
      if (!event.origin.endsWith('facebook.com')) return;
      try {
        const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (!payload || payload.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (payload.event === 'CANCEL') {
          const msg = (payload.data && payload.data.error_message) || 'WhatsApp setup was cancelled.';
          setInlineMessage(errorEl, msg);
          if (connectBtn) {
            connectBtn.disabled = false;
            connectBtn.textContent = 'Connect WhatsApp';
          }
          return;
        }
        if (payload.data) {
          pendingSignup = payload.data;
          tryCompleteConnection();
        }
      } catch (_) {}
    });

    function launchEmbeddedSignup() {
      if (!config.enabled) {
        setInlineMessage(errorEl, 'Embedded Signup is not configured. Add META_APP_ID, META_APP_SECRET, and META_EMBEDDED_SIGNUP_CONFIG_ID to your environment.');
        return;
      }
      if (!window.location.protocol.startsWith('https')) {
        var httpsUrl = String(config.publicBaseUrl || '').replace(/\/$/, '');
        var httpsHint = httpsUrl
          ? ('Meta requires HTTPS for WhatsApp connect. Open ' + httpsUrl + '/settings#whatsapp instead of localhost.')
          : 'Meta requires HTTPS for WhatsApp connect. Use your ngrok or production URL, not localhost.';
        setInlineMessage(errorEl, httpsHint);
        return;
      }
      if (!window.FB) {
        setInlineMessage(errorEl, 'Meta SDK is still loading. Please try again in a moment.');
        return;
      }
      setInlineMessage(errorEl, '');
      setInlineMessage(successEl, '');
      pendingSignup = null;
      pendingCode = null;
      if (connectBtn) {
        connectBtn.disabled = true;
        connectBtn.textContent = 'Connecting...';
      }
      try {
        window.FB.login(function (response) {
          if (response && response.authResponse && response.authResponse.code) {
            pendingCode = response.authResponse.code;
            tryCompleteConnection();
            return;
          }
          if (response && (response.status === 'not_authorized' || response.status === 'unknown')) {
            setInlineMessage(errorEl, 'Meta sign-in was cancelled.');
          } else {
            setInlineMessage(errorEl, 'Meta did not return an authorization code. Complete the popup, or try again in a private window without tracker blockers.');
          }
          if (connectBtn) {
            connectBtn.disabled = false;
            connectBtn.textContent = 'Connect WhatsApp';
          }
        }, {
          config_id: config.configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: { setup: {} }
        });
      } catch (error) {
        console.error('FB.login failed:', error);
        setInlineMessage(errorEl, 'Meta login failed. Use an HTTPS URL (ngrok or production), not localhost.');
        if (connectBtn) {
          connectBtn.disabled = false;
          connectBtn.textContent = 'Connect WhatsApp';
        }
      }
    }

    function loadFacebookSdk() {
      if (!config.enabled || !config.appId) return;
      window.fbAsyncInit = function () {
        window.FB.init({
          appId: config.appId,
          cookie: true,
          xfbml: false,
          version: config.graphVersion || 'v21.0'
        });
      };
      if (document.getElementById('facebook-jssdk')) return;
      const script = document.createElement('script');
      script.id = 'facebook-jssdk';
      script.async = true;
      script.defer = true;
      script.crossOrigin = 'anonymous';
      script.src = 'https://connect.facebook.net/en_US/sdk.js';
      document.body.appendChild(script);
    }

    if (connectBtn) connectBtn.addEventListener('click', launchEmbeddedSignup);
    if (manualConnectBtn) manualConnectBtn.addEventListener('click', connectManually);
    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', async function () {
        if (!window.confirm('Disconnect WhatsApp from Code Orbit?')) return;
        setInlineMessage(errorEl, '');
        setInlineMessage(successEl, '');
        try {
          const resp = await window.authManager.authenticatedFetch('/api/settings/whatsapp/disconnect', {
            method: 'POST',
            headers: { Accept: 'application/json' }
          });
          const data = await resp.json();
          if (!resp.ok || !data.success) throw new Error(data.error || 'Disconnect failed');
          setInlineMessage(successEl, 'WhatsApp disconnected.');
          renderStatus(data.status);
          await refreshStatus();
          const phoneField = document.querySelector('input[name="phone_number_id"]');
          if (phoneField) phoneField.value = '';
          const wabaField = document.querySelector('input[name="waba_id"]');
          if (wabaField) wabaField.value = '';
          const businessPhoneField = document.querySelector('input[name="business_phone"]');
          if (businessPhoneField) businessPhoneField.value = '';
        } catch (error) {
          setInlineMessage(errorEl, (error && error.message) || 'Failed to disconnect WhatsApp.');
        }
      });
    }
    if (testBtn) {
      testBtn.addEventListener('click', async function () {
        setInlineMessage(errorEl, '');
        setInlineMessage(successEl, '');
        testBtn.disabled = true;
        testBtn.textContent = 'Testing...';
        try {
          const resp = await window.authManager.authenticatedFetch('/api/settings/whatsapp/status?validate=1', {
            headers: { Accept: 'application/json' }
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || 'Connection test failed');
          if (!data.connected) {
            throw new Error('WhatsApp is not connected. Use Connect WhatsApp, or set up manually below.');
          }
          if (data.tokenStatus === 'ok') {
            setInlineMessage(successEl, 'Connection is healthy.');
          } else {
            throw new Error(data.tokenMessage || 'Token is invalid or expired. Click Reconnect WhatsApp.');
          }
        } catch (error) {
          setInlineMessage(errorEl, (error && error.message) || 'Connection test failed.');
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = 'Test connection';
        }
      });
    }

    loadFacebookSdk();
    refreshStatus();
  }

  window.initWhatsAppConnect = initWhatsAppConnect;
})();
