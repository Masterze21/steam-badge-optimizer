// Tourne dans le MAIN world — accès aux variables JavaScript de la page Steam
// (window.g_sessionID, g_steamID, etc. sont invisibles depuis le monde ISOLATED)

(function () {
  // Garde anti-injection multiple — DOIT être à l'intérieur de la fonction
  // (un `return` au top-level est une SyntaxError : Chrome n'encapsule pas
  //  les content scripts MAIN world → tout le fichier échouerait à parser).
  if (window.__sbo_main_loaded) return;
  window.__sbo_main_loaded = true;

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

  // ── Capture des infos de facturation sur /market/createbuyorder/ ─────────────
  // Steam (et Steam Inventory Helper) peuvent passer l'ordre via fetch OU XHR :
  // on hooke les DEUX au niveau du MAIN world (invisibles depuis l'isolated world).
  const BILLING_KEYS = [
    'first_name', 'last_name',
    'billing_address', 'billing_address_two', 'billing_city',
    'billing_country', 'billing_state', 'billing_po', 'billing_postal_code',
    'save_my_address', 'tradefee_tax',
  ];

  function captureFromBody(obj) {
    if (!obj) return;
    const billing = {};
    let has = false;
    for (const k of BILLING_KEYS) {
      if (obj[k] !== undefined && obj[k] !== '') { billing[k] = obj[k]; has = true; }
    }
    if (has && (billing.billing_address || billing.billing_country)) {
      document.dispatchEvent(new CustomEvent('__sbo_billing', { detail: billing }));
    }
  }

  function bodyToObj(body) {
    try {
      if (!body) return null;
      if (body instanceof FormData) return Object.fromEntries(body.entries());
      if (typeof body === 'string') return Object.fromEntries(new URLSearchParams(body).entries());
    } catch (_) {}
    return null;
  }

  // Hook fetch
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const [input, init] = args;
    const url = typeof input === 'string' ? input : (input && input.url);
    if (url && url.includes('/market/createbuyorder/') && init && init.body) {
      captureFromBody(bodyToObj(init.body));
    }
    return origFetch.apply(this, args);
  };

  // Hook XMLHttpRequest (jQuery $J.ajax → XHR : la voie réelle du marché Steam)
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__sbo_url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__sbo_url && String(this.__sbo_url).includes('/market/createbuyorder/')) {
        captureFromBody(bodyToObj(body));
      }
    } catch (_) {}
    return origSend.apply(this, arguments);
  };
})();
