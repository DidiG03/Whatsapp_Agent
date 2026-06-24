(function () {
  'use strict';

  var AUTH_LINK_SELECTOR = 'a.landing-auth-link';
  var pageReady = document.readyState === 'complete';
  var pendingHref = null;
  var pendingLink = null;

  function ensureClerkReady() {
    if (typeof window.ensureClerkScriptLoaded === 'function') {
      return window.ensureClerkScriptLoaded();
    }
    return Promise.resolve();
  }

  function navigateToAuth(href, link) {
    if (link) {
      link.classList.add('landing-auth-link--pending');
      link.setAttribute('aria-busy', 'true');
    }
    ensureClerkReady().finally(function () {
      window.location.href = href;
    });
  }

  function markReady() {
    pageReady = true;
    document.body.classList.remove('landing-page--loading');
    ensureClerkReady();

    if (pendingHref) {
      var target = pendingHref;
      var link = pendingLink;
      pendingHref = null;
      pendingLink = null;
      navigateToAuth(target, link);
      return;
    }

    document.querySelectorAll('.landing-auth-link--pending').forEach(function (link) {
      link.classList.remove('landing-auth-link--pending');
      link.removeAttribute('aria-busy');
    });
  }

  function onAuthLinkClick(event) {
    var link = event.target.closest(AUTH_LINK_SELECTOR);
    if (!link) return;

    var href = link.getAttribute('href') || link.pathname;
    event.preventDefault();

    if (!pageReady) {
      pendingHref = href;
      pendingLink = link;
      link.classList.add('landing-auth-link--pending');
      link.setAttribute('aria-busy', 'true');
      return;
    }

    navigateToAuth(href, link);
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!document.body.classList.contains('landing-page')) return;

    document.body.classList.add('landing-page--loading');
    document.addEventListener('click', onAuthLinkClick, true);

    if (pageReady) {
      markReady();
      return;
    }

    window.addEventListener('load', markReady, { once: true });
  });
})();
