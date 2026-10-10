// Classic script on purpose: it runs before the module graph resolves, and it must stay loadable
// in contexts where modules are blocked (file:// double-click, Electron shell, older webviews).
//
// The gate is the protocol, not a try/catch: registering a service worker from a file:// origin
// throws a SecurityError *asynchronously* out of the promise, so the registration is skipped
// outright instead of being attempted and swallowed.
(function () {
  'use strict';

  var proto = location.protocol;
  var served = proto === 'http:' || proto === 'https:';
  var status = { attempted: false, ok: false, scope: null, error: null, protocol: proto };

  function announce() {
    try {
      document.dispatchEvent(new CustomEvent('pentapack:sw', { detail: status }));
    } catch (e) {
      /* CustomEvent is missing on very old engines; nothing depends on the signal */
    }
  }

  if (!served || !('serviceWorker' in navigator)) {
    status.error = served ? 'no serviceWorker api' : proto + ' is not registerable';
    window.__pentapackSW = status;
    return;
  }

  status.attempted = true;
  try {
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then(function (reg) {
        status.ok = true;
        status.scope = reg.scope;
        announce();
      })
      .catch(function (err) {
        status.error = String((err && err.message) || err);
        announce();
      });
  } catch (err) {
    status.error = String((err && err.message) || err);
  }

  window.__pentapackSW = status;
})();
