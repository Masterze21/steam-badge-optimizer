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
})();
