// Tourne dans le monde ISOLATED — accès aux APIs chrome (storage, runtime)
// Reçoit les données Steam depuis steam-bridge-main.js via CustomEvent

// Guard contre les injections multiples
if (document.documentElement.getAttribute('data-steam-bridge') === '2') return;
document.documentElement.setAttribute('data-steam-bridge', '2');

(function () {

  function handleSession({ sessionid, steamid, profileURL }) {
    if (!sessionid && !steamid) return;

    const vanity = profileURL
      ? profileURL.replace(/.*\/(id|profiles)\/([^/]+)\/?$/, '$2')
      : null;
    const profileType = profileURL && profileURL.includes('/id/') ? 'id' : 'profiles';

    console.log('[SteamBridge] Session reçue — steamid:', steamid, '| vanity:', vanity);

    if (sessionid) {
      chrome.storage.session.set({ sessionid, steamid, vanity, profileType }, () => {
        if (chrome.runtime.lastError) {
          console.error('[SteamBridge] storage.set error:', chrome.runtime.lastError.message);
        } else {
          console.log('[SteamBridge] Session stockée OK');
        }
      });
      chrome.runtime.sendMessage({ type: 'STEAM_SESSION', sessionid, steamid, vanity, profileType })
        .catch(() => {});
    }
  }

  // Écoute l'événement envoyé par le MAIN world
  document.addEventListener('__sbo_session', e => handleSession(e.detail));

  // Envoie un ping pour déclencher un re-dispatch depuis le MAIN world
  // (cas où l'événement initial a été émis avant que ce listener soit prêt)
  document.dispatchEvent(new CustomEvent('__sbo_ping'));

  // ── Réception billing depuis le MAIN world (hooks fetch/XHR) ─────────────────
  document.addEventListener('__sbo_billing', e => {
    chrome.runtime.sendMessage({ type: 'BILLING_CAPTURED', billing: e.detail }).catch(() => {});
  });

  // ── Capture DOM : l'adresse est pré-remplie par Steam dès l'ouverture de la
  //    boîte d'achat. Le DOM est partagé avec le monde ISOLATED → on lit directement.
  function readBillingFromDOM() {
    const get = name => {
      for (const el of document.querySelectorAll(`input[name="${name}"]`)) {
        if (el.value && el.value.trim()) return el.value.trim();
      }
      return '';
    };
    const billing = {};
    for (const k of ['first_name', 'last_name', 'billing_address', 'billing_address_two', 'billing_city', 'billing_country', 'billing_state']) {
      const v = get(k);
      if (v) billing[k] = v;
    }
    const pc = get('billing_postal_code') || get('billing_po');
    if (pc) { billing.billing_po = pc; billing.billing_postal_code = pc; }

    if (billing.billing_address && billing.billing_country) {
      chrome.runtime.sendMessage({ type: 'BILLING_CAPTURED', billing }).catch(() => {});
      return true;
    }
    return false;
  }

  // Sur les pages marché : observe l'apparition de la boîte d'achat puis capture
  if (location.href.includes('/market')) {
    if (!readBillingFromDOM()) {
      const obs = new MutationObserver(() => { if (readBillingFromDOM()) obs.disconnect(); });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      // Sécurité : on coupe l'observation après 5 min pour ne pas tourner indéfiniment
      setTimeout(() => obs.disconnect(), 5 * 60 * 1000);
    }
  }

})();
