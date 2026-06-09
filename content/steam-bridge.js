// Injecté sur steamcommunity.com — accède à window.g_sessionID (HTTP-only cookie inaccessible côté extension)

(function () {
  const sessionid = window.g_sessionID;
  const steamid = window.g_steamID;
  const vanity = window.g_strProfileURL ? window.g_strProfileURL.replace(/.*\/(id|profiles)\/([^/]+)\/?$/, '$2') : null;
  const profileType = window.g_strProfileURL && window.g_strProfileURL.includes('/id/') ? 'id' : 'profiles';

  if (sessionid) {
    // Écriture directe dans chrome.storage.session — fonctionne même si le service worker
    // n'est pas actif (évite la perte de session en MV3 quand le SW est tué).
    chrome.storage.session.set({ sessionid, steamid, vanity, profileType });
    // On notifie quand même le SW s'il est actif (ex: pour des actions immédiates).
    chrome.runtime.sendMessage({ type: 'STEAM_SESSION', sessionid, steamid, vanity, profileType })
      .catch(() => { /* SW endormi — pas grave, storage.session est déjà écrit */ });
  }

  // Capture billing info quand l'user fait un buy manuel
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const [input, init] = args;
    const url = typeof input === 'string' ? input : input.url;
    if (url && url.includes('/market/createbuyorder/') && init && init.body) {
      try {
        const body = init.body instanceof FormData
          ? Object.fromEntries(init.body.entries())
          : Object.fromEntries(new URLSearchParams(init.body).entries());
        const billingFields = ['billing_address', 'billing_city', 'billing_country',
          'billing_po', 'billing_state', 'first_name', 'last_name', 'tradefee_tax'];
        const billing = {};
        let hasData = false;
        for (const f of billingFields) {
          if (body[f] !== undefined) { billing[f] = body[f]; hasData = true; }
        }
        if (hasData) {
          chrome.runtime.sendMessage({ type: 'BILLING_CAPTURED', billing });
        }
      } catch (_) {}
    }
    return origFetch.apply(this, args);
  };
})();
