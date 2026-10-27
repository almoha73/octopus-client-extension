/**
 * Content Script - Octopus Energy Sync & Diagnostic Universel
 * S'exécute sur https://octopusenergy.fr/espace-client/*
 */

(function () {
  if (window.__octopusSyncInjected) return;
  window.__octopusSyncInjected = true;

  function getCookieValue(name) {
    const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
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
        gap: '10px',
        maxWidth: '460px'
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
    }, 6000);
  }

  function triggerAutoSync() {
    const token = getCookieValue('accessToken');
    const refreshToken = getCookieValue('refreshToken');
    if (!token && !refreshToken) return;

    chrome.runtime.sendMessage(
      {
        type: 'OCTOPUS_SYNC_NOW',
        accessToken: token,
        refreshToken: refreshToken,
        isAuto: true
      },
      (res) => {
        if (chrome.runtime.lastError || !res) return;
        if (res.skipped) return;
        if (res.ok && res.summary) {
          const s = res.summary;
          const props = s.properties || [];
          const details = props.map((p) => `${p.name}: ${p.daysCount} j`).join(' • ');
          const rescueAny = props.some((p) => p.rescueModeUsed);
          showToast(
            `🐙 Octopus (${s.accountNumber}) : ${details}${rescueAny ? ' [🛟 Mode Secours kWh actif]' : ''}`
          );
        } else if (res.error) {
          showToast(`⚠️ Octopus Sync : ${res.error}`, true);
        }
      }
    );
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'GET_PAGE_COOKIE_TOKEN') {
      sendResponse({
        accessToken: getCookieValue('accessToken'),
        refreshToken: getCookieValue('refreshToken')
      });
    }
  });

  setTimeout(triggerAutoSync, 2000);
})();
