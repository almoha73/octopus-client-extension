const DEFAULT_WEBAPP_URL =
  'https://script.google.com/macros/s/AKfycbyXUPxpUlzVcXnb_c2nfffleF-yaRulmOPCkysjVOuol8JmBOaFdA4HZdYEuXgso9IH/exec';

document.addEventListener('DOMContentLoaded', async () => {
  const syncBtn = document.getElementById('sync-now-btn');
  const saveBtn = document.getElementById('save-btn');
  const webAppInput = document.getElementById('webapp-url');
  const autoSyncCheckbox = document.getElementById('auto-sync');
  const statusBadge = document.getElementById('status-badge');
  const statusMessage = document.getElementById('status-message');
  const lastSyncTime = document.getElementById('last-sync-time');
  const lapleauStats = document.getElementById('lapleau-stats');
  const bordeauxStats = document.getElementById('bordeaux-stats');

  function formatFrNum(val) {
    return Number(val || 0).toLocaleString('fr-FR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function renderSummary(summary) {
    if (!summary) return;
    if (summary.syncedAt) {
      lastSyncTime.textContent = `Synchronisé le ${summary.syncedAt}`;
    }
    if (summary.lapleau) {
      const l = summary.lapleau;
      lapleauStats.textContent = `${l.daysCount} jours (→ ${l.lastDate}) • ${formatFrNum(l.totalKwh)} kWh • ${formatFrNum(l.totalEur)} € TTC`;
    }
    if (summary.bordeaux) {
      const b = summary.bordeaux;
      bordeauxStats.textContent = `${b.daysCount} jours (→ ${b.lastDate}) • ${formatFrNum(b.totalKwh)} kWh • ${formatFrNum(b.totalEur)} € TTC`;
    }
  }

  function showStatus(text, isError = false) {
    statusMessage.textContent = text;
    statusMessage.className = `status-box ${isError ? 'err' : 'ok'}`;
  }

  const stored = await chrome.storage.local.get([
    'webAppUrl',
    'autoSync',
    'lastSyncSummary',
    'lastSyncStatus',
    'lastSyncError'
  ]);

  webAppInput.value = stored.webAppUrl || DEFAULT_WEBAPP_URL;
  autoSyncCheckbox.checked = stored.autoSync !== false;

  if (stored.lastSyncSummary) {
    renderSummary(stored.lastSyncSummary);
  }
  if (stored.lastSyncStatus === 'error' && stored.lastSyncError) {
    statusBadge.textContent = 'Erreur';
    statusBadge.className = 'badge badge-err';
    showStatus(stored.lastSyncError, true);
  } else if (stored.lastSyncStatus === 'success') {
    statusBadge.textContent = 'À jour';
    statusBadge.className = 'badge badge-ok';
  }

  saveBtn.addEventListener('click', async () => {
    const url = webAppInput.value.trim() || DEFAULT_WEBAPP_URL;
    await chrome.storage.local.set({
      webAppUrl: url,
      autoSync: autoSyncCheckbox.checked
    });
    showStatus('Paramètres enregistrés !', false);
  });

  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = '⏳ Synchronisation...';
    statusBadge.textContent = 'En cours...';
    statusBadge.className = 'badge badge-sync';
    statusMessage.className = 'status-box hidden';

    let pageToken = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id && tab.url && tab.url.includes('octopusenergy.fr')) {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_COOKIE_TOKEN' });
        if (resp && resp.accessToken) pageToken = resp.accessToken;
      }
    } catch (e) {
      // fallback to chrome.cookies in background.js
    }

    chrome.runtime.sendMessage(
      {
        type: 'OCTOPUS_SYNC_NOW',
        accessToken: pageToken,
        isAuto: false
      },
      (res) => {
        syncBtn.disabled = false;
        syncBtn.textContent = '🔄 Synchroniser maintenant';

        if (chrome.runtime.lastError) {
          statusBadge.textContent = 'Erreur';
          statusBadge.className = 'badge badge-err';
          showStatus(chrome.runtime.lastError.message, true);
          return;
        }

        if (res && res.ok) {
          statusBadge.textContent = 'À jour';
          statusBadge.className = 'badge badge-ok';
          renderSummary(res.summary);
          showStatus('✅ Synchronisation réussie vers votre Google Sheet !', false);
        } else {
          statusBadge.textContent = 'Erreur';
          statusBadge.className = 'badge badge-err';
          showStatus((res && res.error) || 'Erreur inconnue', true);
        }
      }
    );
  });
});
