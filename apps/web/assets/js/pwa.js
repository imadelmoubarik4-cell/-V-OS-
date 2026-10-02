(function () {
  'use strict';
  // Alcedo PWA bootstrap: register the service worker on every load (so the app
  // is installable and works offline, not only when notifications are enabled),
  // and offer an install affordance — the native prompt on Android/desktop, a
  // one-time "Add to Home Screen" hint on iOS (which has no install prompt).
  var deferredPrompt = null;
  var DISMISS_KEY = 'alcedo.pwa.installDismissed';

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
  }
  function dismissed() {
    try { return window.localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; }
  }
  function remember() {
    try { window.localStorage.setItem(DISMISS_KEY, '1'); } catch (e) { /* private mode */ }
  }
  function isiOS() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent) && !window.MSStream;
  }
  function removeBanner() {
    var el = document.getElementById('pwa-install');
    if (el) el.remove();
  }
  function showBanner(message, actionLabel, onAction) {
    if (dismissed() || isStandalone() || document.getElementById('pwa-install') || !document.body) return;
    var bar = document.createElement('div');
    bar.id = 'pwa-install';
    bar.className = 'pwa-install';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Install Alcedo');

    var text = document.createElement('span');
    text.className = 'pwa-install__text';
    text.textContent = message;
    bar.appendChild(text);

    if (actionLabel && onAction) {
      var action = document.createElement('button');
      action.type = 'button';
      action.className = 'pwa-install__action';
      action.textContent = actionLabel;
      action.addEventListener('click', onAction);
      bar.appendChild(action);
    }

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'pwa-install__close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', function () { remember(); removeBanner(); });
    bar.appendChild(close);

    document.body.appendChild(bar);
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('service-worker.js', { scope: './' }).catch(function () { /* unsupported */ });
    });
  }

  // Android / desktop Chrome: stash the native prompt and surface an Install button.
  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    showBanner('Install Alcedo on this device.', 'Install', function () {
      removeBanner();
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      if (deferredPrompt.userChoice && deferredPrompt.userChoice.finally) {
        deferredPrompt.userChoice.finally(function () { deferredPrompt = null; });
      } else {
        deferredPrompt = null;
      }
    });
  });

  window.addEventListener('appinstalled', function () { remember(); removeBanner(); });

  // iOS Safari has no install prompt — show the one-time Add to Home Screen hint.
  if (isiOS() && !isStandalone() && !dismissed()) {
    window.addEventListener('load', function () {
      showBanner('Add Alcedo to your Home Screen: tap Share, then “Add to Home Screen”.', null, null);
    });
  }
})();
