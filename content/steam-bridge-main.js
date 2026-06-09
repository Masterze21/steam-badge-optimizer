// Tourne dans le MAIN world — accès aux variables JavaScript de la page Steam
// (window.g_sessionID, g_steamID, etc. sont invisibles depuis le monde ISOLATED)

// Guard contre les injections multiples (tryInjectIntoSteamTabs peut être appelé plusieurs fois)
if (window.__sbo_main_loaded) return;
window.__sbo_main_loaded = true;

(function () {

  // ── Session Steam ────────────────────────────────────────────────────────────
  function dispatch() {
    const sessionid  = window.g_sessionID  || '';
    const steamid    = window.g_steamID    || '';
    const profileURL = window.g_strProfileURL || '';
    document.dispatchEvent(new CustomEvent('__sbo_session', {
      detail: { sessionid, steamid, profileURL }
    }));
  }

  dispatch();
  document.addEventListener('__sbo_ping', dispatch);

  // ── Hook fetch pour capturer les infos de facturation ────────────────────────
  // window.fetch est dans le MAIN world — impossible à hooker depuis l'isolated world
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const [input, init] = args;
    const url = typeof input === 'string' ? input : input?.url;
    if (url && url.includes('/market/createbuyorder/') && init?.body) {
      try {
        const body = init.body instanceof FormData
          ? Object.fromEntries(init.body.entries())
          : Object.fromEntries(new URLSearchParams(init.body).entries());
        const billingFields = [
          'billing_address', 'billing_city', 'billing_country',
          'billing_po', 'billing_state', 'first_name', 'last_name', 'tradefee_tax',
        ];
        const billing = {};
        let hasData = false;
        for (const f of billingFields) {
          if (body[f] !== undefined) { billing[f] = body[f]; hasData = true; }
        }
        if (hasData) {
          // Envoie les données de billing vers l'isolated world via CustomEvent
          document.dispatchEvent(new CustomEvent('__sbo_billing', { detail: billing }));
        }
      } catch (_) {}
    }
    return origFetch.apply(this, args);
  };

})();
