// Tourne dans le monde ISOLATED — accès aux APIs chrome (storage, runtime)
// Reçoit les données Steam depuis steam-bridge-main.js via CustomEvent

(function () {
  // Garde anti-injection multiple — à l'intérieur de la fonction (pas de return top-level)
  if (document.documentElement.getAttribute('data-steam-bridge') === '2') return;
  document.documentElement.setAttribute('data-steam-bridge', '2');

  function handleSession({ sessionid, steamid, profileURL }) {
    if (!sessionid && !steamid) return;

    const vanity = profileURL
      ? profileURL.replace(/.*\/(id|profiles)\/([^/]+)\/?$/, '$2')
      : null;
    const profileType = profileURL && profileURL.includes('/id/') ? 'id' : 'profiles';

    if (sessionid) {
      chrome.storage.session.set({ sessionid, steamid, vanity, profileType });
      chrome.runtime.sendMessage({ type: 'STEAM_SESSION', sessionid, steamid, vanity, profileType })
        .catch(() => {});
    }
  }

  // Écoute l'événement envoyé par le MAIN world
  document.addEventListener('__sbo_session', e => handleSession(e.detail));

  // Ping pour déclencher un re-dispatch depuis le MAIN world
  document.dispatchEvent(new CustomEvent('__sbo_ping'));

  // ── Réception billing depuis le MAIN world (hooks fetch/XHR) ─────────────────
  document.addEventListener('__sbo_billing', e => {
    chrome.runtime.sendMessage({ type: 'BILLING_CAPTURED', billing: e.detail }).catch(() => {});
  });

  // ── Capture DOM : Steam pré-remplit l'adresse dans la boîte d'achat.
  //    Le DOM est partagé avec le monde ISOLATED → on lit directement.
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

    // Capture complète exigée — un billing partiel provoque success:22 sur createbuyorder
    const complete = billing.first_name && billing.last_name && billing.billing_address
      && billing.billing_city && billing.billing_country && (billing.billing_po || billing.billing_postal_code);
    if (complete) {
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
      setTimeout(() => obs.disconnect(), 5 * 60 * 1000); // coupe au bout de 5 min
    }
  }
})();
