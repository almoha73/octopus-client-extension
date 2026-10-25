/**
 * Content Script - Octopus Energy Sync
 * S'exécute automatiquement sur https://octopusenergy.fr/espace-client/*
 * et synchronise les 2 logements vers Google Sheets.
 */

(function () {
  if (window.__octopusSyncInjected) return;
  window.__octopusSyncInjected = true;

  function getCookieToken() {
    const match = document.cookie.match(/(?:^|;\s*)accessToken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function showToast(text, isError = false) {
    let toast = document.getElementById('octopus-gsheet-sync-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'octopus-gsheet-sync-toast';
      Object.assign(toast.style, {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: '999999',
        padding: '12px 18px',
        borderRadius: '12px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '13px',
        fontWeight: '600',
        color: '#ffffff',
        boxShadow: '0 10px 25px rgba(0,0,0,0.35)',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
      });
      document.body.appendChild(toast);
    }

    toast.style.background = isError
      ? 'linear-gradient(135deg, #991b1b, #dc2626)'
      : 'linear-gradient(135deg, #180048, #581c87)';
    toast.style.border = isError ? '1px solid #f87171' : '1px solid #f050f8';
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    toast.textContent = text;

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
    }, 5500);
  }

  function triggerAutoSync() {
    const token = getCookieToken();
    if (!token) return;

    chrome.runtime.sendMessage(
      {
        type: 'OCTOPUS_SYNC_NOW',
        accessToken: token,
        isAuto: true
      },
      (res) => {
        if (chrome.runtime.lastError || !res) return;
        if (res.skipped) return;
        if (res.ok && res.summary) {
          const s = res.summary;
          showToast(
            `🐙 Octopus Sync : St Merd (${s.lapleau.daysCount} j) & Bordeaux (${s.bordeaux.daysCount} j) synchronisés vers Google Sheets !`
          );
        } else if (res.error) {
          showToast(`⚠️ Octopus Sync : ${res.error}`, true);
        }
      }
    );
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'GET_PAGE_COOKIE_TOKEN') {
      sendResponse({ accessToken: getCookieToken() });
    }
  });

  // Lancer la synchronisation automatique après le chargement de l'espace client
  setTimeout(triggerAutoSync, 2000);
})();
