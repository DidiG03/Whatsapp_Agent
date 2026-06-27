(function () {
  (async function checkAuthOnLoad() {
    await window.authManager.checkAuthOnLoad();
  })();

  window.checkAuthThenSubmit = async function checkAuthThenSubmit(form) {
    return window.authManager.submitFormWithAuth(form);
  };

  window.toggleReveal = function toggleReveal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
  };

  window.copyValue = async function copyValue(id) {
    const el = document.getElementById(id);
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.value || '');
    } catch (_) {}
  };

  function clerkAccountErrorMessage(error, fallback) {
    const errors = error && error.errors;
    if (Array.isArray(errors) && errors.length) {
      const first = errors[0] || {};
      const code = String(first.code || '').toLowerCase();
      if (code.includes('reverification') || code === 'session_reverification_required') {
        return 'For your security, please sign out and sign in again, then retry.';
      }
      if (code === 'form_identifier_exists') {
        return 'That email is already linked to another account.';
      }
      return first.longMessage || first.message || fallback;
    }
    const message = String((error && error.message) || '').trim();
    if (/reverification|verification required/i.test(message)) {
      return 'For your security, please sign out and sign in again, then retry.';
    }
    return message || fallback;
  }

  function initAccountEmailForm() {
    const form = document.getElementById('account-email-form');
    if (!form) return;

    const clerkEnabled = form.dataset.clerkEnabled === 'true';
    const currentEmailInput = document.getElementById('account-current-email');
    const newEmailInput = document.getElementById('account-new-email');
    const codeInput = document.getElementById('account-email-code');
    const verifyStep = document.getElementById('account-email-verify-step');
    const verifyHint = document.getElementById('account-email-verify-hint');
    const errorEl = document.getElementById('account-email-error');
    const successEl = document.getElementById('account-email-success');
    const submitBtn = document.getElementById('account-email-submit');
    const resendBtn = document.getElementById('account-email-resend');
    const cancelBtn = document.getElementById('account-email-cancel');
    let pendingEmailAddress = null;
    let verifyMode = false;

    function setMessage(el, message) {
      if (!el) return;
      if (message) {
        el.textContent = message;
        el.hidden = false;
      } else {
        el.textContent = '';
        el.hidden = true;
      }
    }

    function setVerifyMode(enabled, targetEmail) {
      verifyMode = enabled;
      if (verifyStep) verifyStep.hidden = !enabled;
      if (resendBtn) resendBtn.hidden = !enabled;
      if (cancelBtn) cancelBtn.hidden = !enabled;
      if (newEmailInput) newEmailInput.readOnly = enabled;
      if (submitBtn) submitBtn.textContent = enabled ? 'Verify & set as primary' : 'Send verification code';
      if (verifyHint && targetEmail) {
        verifyHint.textContent = 'Enter the 6-digit code sent to ' + targetEmail + '.';
      }
      if (!enabled) {
        pendingEmailAddress = null;
        if (codeInput) codeInput.value = '';
      }
    }

    function getCurrentPrimaryEmail(user) {
      const primary = user && user.primaryEmailAddress && user.primaryEmailAddress.emailAddress;
      return String(primary || (currentEmailInput && currentEmailInput.value) || '').trim();
    }

    async function prepareEmailVerification(user, targetEmail) {
      const normalizedTarget = targetEmail.toLowerCase();
      const existing = (user.emailAddresses || []).find(function (entry) {
        return String(entry.emailAddress || '').trim().toLowerCase() === normalizedTarget;
      });

      let emailAddress = existing || null;
      if (!emailAddress) {
        const created = await user.createEmailAddress({ email: targetEmail });
        await user.reload();
        emailAddress = user.emailAddresses.find(function (entry) { return entry.id === created.id; }) || null;
      }

      if (!emailAddress) {
        throw new Error('Could not add the email address. Please try again.');
      }

      if (emailAddress.verification && emailAddress.verification.status === 'verified') {
        await user.update({ primaryEmailAddressId: emailAddress.id });
        await user.reload();
        return { alreadyVerified: true, emailAddress: emailAddress };
      }

      await emailAddress.prepareVerification({ strategy: 'email_code' });
      return { alreadyVerified: false, emailAddress: emailAddress };
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        setMessage(errorEl, '');
        setMessage(successEl, '');
        setVerifyMode(false);
      });
    }

    if (resendBtn) {
      resendBtn.addEventListener('click', async function () {
        setMessage(errorEl, '');
        setMessage(successEl, '');
        if (!pendingEmailAddress) return;
        resendBtn.disabled = true;
        resendBtn.textContent = 'Sending...';
        try {
          await window.authManager.initClerk();
          await pendingEmailAddress.prepareVerification({ strategy: 'email_code' });
          setMessage(successEl, 'Verification code resent.');
        } catch (error) {
          console.error('Email code resend failed:', error);
          setMessage(errorEl, clerkAccountErrorMessage(error, 'Failed to resend verification code.'));
        } finally {
          resendBtn.disabled = false;
          resendBtn.textContent = 'Resend code';
        }
      });
    }

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      setMessage(errorEl, '');
      setMessage(successEl, '');

      if (!clerkEnabled) {
        setMessage(errorEl, 'Email changes require Clerk authentication.');
        return;
      }

      const targetEmail = String((newEmailInput && newEmailInput.value) || '').trim();
      if (!targetEmail) {
        setMessage(errorEl, 'Enter a new email address.');
        if (newEmailInput) newEmailInput.focus();
        return;
      }

      if (submitBtn) submitBtn.disabled = true;

      try {
        await window.authManager.initClerk();
        const user = window.Clerk && window.Clerk.user;
        if (!user) {
          window.authManager.handleUnauthorized();
          return;
        }

        const currentEmail = getCurrentPrimaryEmail(user);
        if (targetEmail.toLowerCase() === currentEmail.toLowerCase()) {
          setMessage(errorEl, 'That is already your current email address.');
          return;
        }

        if (!verifyMode) {
          if (submitBtn) submitBtn.textContent = 'Sending...';
          const result = await prepareEmailVerification(user, targetEmail);
          if (result.alreadyVerified) {
            if (currentEmailInput) currentEmailInput.value = targetEmail;
            setVerifyMode(false);
            setMessage(successEl, 'Primary email updated successfully.');
            if (window.history && window.history.replaceState) {
              window.history.replaceState(null, '', '/settings#account');
            }
            return;
          }
          pendingEmailAddress = result.emailAddress;
          setVerifyMode(true, targetEmail);
          setMessage(successEl, 'Verification code sent. Check your inbox.');
          if (codeInput) codeInput.focus();
          return;
        }

        const code = String((codeInput && codeInput.value) || '').trim();
        if (!code) {
          setMessage(errorEl, 'Enter the verification code from your email.');
          if (codeInput) codeInput.focus();
          return;
        }
        if (!pendingEmailAddress) {
          setMessage(errorEl, 'Verification expired. Send a new code to continue.');
          setVerifyMode(false);
          return;
        }

        if (submitBtn) submitBtn.textContent = 'Verifying...';
        await pendingEmailAddress.attemptVerification({ code: code });
        await user.update({ primaryEmailAddressId: pendingEmailAddress.id });
        await user.reload();

        const updatedEmail = getCurrentPrimaryEmail(user);
        if (currentEmailInput && updatedEmail) currentEmailInput.value = updatedEmail;
        if (newEmailInput) newEmailInput.value = '';
        setVerifyMode(false);
        setMessage(successEl, 'Primary email updated successfully.');
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', '/settings#account');
        }
      } catch (error) {
        console.error('Email update failed:', error);
        setMessage(errorEl, clerkAccountErrorMessage(error, verifyMode
          ? 'Verification failed. Check the code and try again.'
          : 'Failed to start email update.'));
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = verifyMode ? 'Verify & set as primary' : 'Send verification code';
        }
      }
    });
  }

  function clerkPasswordErrorMessage(error) {
    return clerkAccountErrorMessage(error, 'Failed to update password.');
  }

  function initAccountPasswordForm() {
    const form = document.getElementById('account-password-form');
    if (!form) return;

    const clerkEnabled = form.dataset.clerkEnabled === 'true';
    const errorEl = document.getElementById('account-password-error');
    const successEl = document.getElementById('account-password-success');
    const submitBtn = document.getElementById('account-password-submit');
    const currentInput = document.getElementById('account-current-password');
    const newInput = document.getElementById('account-new-password');
    const confirmInput = document.getElementById('account-confirm-password');
    const signOutCheckbox = document.getElementById('account-sign-out-sessions');

    function setMessage(el, message) {
      if (!el) return;
      if (message) {
        el.textContent = message;
        el.hidden = false;
      } else {
        el.textContent = '';
        el.hidden = true;
      }
    }

    function clearPasswordFields() {
      if (currentInput) currentInput.value = '';
      if (newInput) newInput.value = '';
      if (confirmInput) confirmInput.value = '';
    }

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      setMessage(errorEl, '');
      setMessage(successEl, '');

      if (!clerkEnabled) {
        setMessage(errorEl, 'Password changes require Clerk authentication.');
        return;
      }

      const passwordEnabled = form.dataset.passwordEnabled === 'true';
      const newPassword = String((newInput && newInput.value) || '');
      const confirmPassword = String((confirmInput && confirmInput.value) || '');
      const currentPassword = String((currentInput && currentInput.value) || '');

      if (passwordEnabled && !currentPassword) {
        setMessage(errorEl, 'Enter your current password.');
        if (currentInput) currentInput.focus();
        return;
      }
      if (!newPassword || newPassword.length < 8) {
        setMessage(errorEl, 'New password must be at least 8 characters.');
        if (newInput) newInput.focus();
        return;
      }
      if (newPassword !== confirmPassword) {
        setMessage(errorEl, 'New password and confirmation do not match.');
        if (confirmInput) confirmInput.focus();
        return;
      }
      if (passwordEnabled && currentPassword === newPassword) {
        setMessage(errorEl, 'New password must be different from your current password.');
        if (newInput) newInput.focus();
        return;
      }

      const signOutOfOtherSessions = signOutCheckbox ? signOutCheckbox.checked : true;
      if (signOutOfOtherSessions && !window.confirm('You will be signed out of all other devices after this change. Continue?')) {
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Updating...';
      }

      try {
        await window.authManager.initClerk();
        const user = window.Clerk && window.Clerk.user;
        if (!user) {
          window.authManager.handleUnauthorized();
          return;
        }

        const params = { newPassword: newPassword, signOutOfOtherSessions: signOutOfOtherSessions };
        if (passwordEnabled) params.currentPassword = currentPassword;

        await user.updatePassword(params);
        clearPasswordFields();
        setMessage(successEl, passwordEnabled
          ? 'Password updated successfully.'
          : 'Password set successfully. You can now sign in with email and password.');
      } catch (error) {
        console.error('Password update failed:', error);
        setMessage(errorEl, clerkPasswordErrorMessage(error));
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = form.dataset.passwordEnabled === 'true' ? 'Update password' : 'Set password';
        }
      }
    });
  }

  function initAiConfiguration(root) {
    const scope = root || document;
    const radios = scope.querySelectorAll('input[name="conversation_mode"]');
    const info = scope.querySelector('#escalation_info') || document.getElementById('escalation_info');
    const messages = scope.querySelector('#escalation_messages') || document.getElementById('escalation_messages');
    if (!radios.length) return;

    function syncEscalationPanels() {
      const mode = (scope.querySelector('input[name="conversation_mode"]:checked') || document.querySelector('input[name="conversation_mode"]:checked'))?.value;
      const show = mode === 'escalation';
      if (info) info.classList.toggle('hidden', !show);
      if (messages) messages.classList.toggle('hidden', !show);
    }

    radios.forEach(function (radio) {
      radio.addEventListener('change', syncEscalationPanels);
    });
    syncEscalationPanels();
  }

  window.initSettingsAiPanel = initAiConfiguration;

  async function initAccountMeta() {
    try {
      const response = await fetch('/api/settings/account-meta', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const data = await response.json();
      if (!response.ok || !data.success) return;

      const emailInput = document.getElementById('account-current-email');
      if (emailInput && data.primaryEmail) {
        emailInput.value = data.primaryEmail;
      }

      const emailHint = document.getElementById('account-email-hint');
      if (emailHint) {
        emailHint.textContent = data.signedInWithGoogle
          ? 'You signed in with Google. To change your login email, add a new address, verify it, and it will become your primary email. Your Google sign-in will remain linked.'
          : 'To change your primary email, add a new address and verify it with the code we send you.';
      }

      const passwordHint = document.getElementById('account-password-hint');
      const passwordForm = document.getElementById('account-password-form');
      const currentWrap = document.getElementById('account-current-password-wrap');
      const currentInput = document.getElementById('account-current-password');
      const submitBtn = document.getElementById('account-password-submit');
      if (passwordHint) {
        passwordHint.textContent = data.passwordEnabled
          ? 'Update your sign-in password. For security, your current password is required.'
          : 'You signed in without a password. Set one to also sign in with email and password.';
      }
      if (passwordForm) {
        passwordForm.dataset.passwordEnabled = data.passwordEnabled ? 'true' : 'false';
      }
      if (currentWrap) {
        currentWrap.hidden = !data.passwordEnabled;
      }
      if (currentInput) {
        currentInput.required = !!data.passwordEnabled;
      }
      if (submitBtn) {
        submitBtn.textContent = data.passwordEnabled ? 'Update password' : 'Set password';
      }
    } catch (error) {
      console.warn('Account meta fetch failed:', error);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (window.__CSRF_TOKEN__) {
      document.querySelectorAll('form').forEach(function (form) {
        if (form.querySelector('input[name="_csrf"]')) return;
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = '_csrf';
        input.value = window.__CSRF_TOKEN__;
        form.appendChild(input);
      });
    }
    initAccountPasswordForm();
    initAccountEmailForm();
    initAccountMeta();
  });
})();
