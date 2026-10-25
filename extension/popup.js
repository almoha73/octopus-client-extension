const DEFAULT_WEBAPP_URL =
  'https://script.google.com/macros/s/AKfycbyXUPxpUlzVcXnb_c2nfffleF-yaRulmOPCkysjVOuol8JmBOaFdA4HZdYEuXgso9IH/exec';

document.addEventListener('DOMContentLoaded', async () => {
  const syncBtn = document.getElementById('sync-now-btn');
  const saveBtn = document.getElementById('save-btn');
  const monthsSelect = document.getElementById('months-select');
  const webAppInput = document.getElementById('webapp-url');
  const autoSyncCheckbox = document.getElementById('auto-sync');
  const statusBadge = document.getElementById('status-badge');
  const statusMessage = document.getElementById('status-message');
  const lastSyncTime = document.getElementById('last-sync-time');
  const accountSubtitle = document.getElementById('account-subtitle');
  const cardsContainer = document.getElementById('cards-container');

  function formatFrNum(val) {
    return Number(val || 0).toLocaleString('fr-FR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function renderSummary(summary) {
    if (!summary) return;
    if (summary.accountNumber) {
      accountSubtitle.textContent = `Compte actif : ${summary.accountNumber}`;
    }
    if (summary.syncedAt) {
      lastSyncTime.textContent = `Scanné le ${summary.syncedAt}${summary.sheetSynced ? ' • Google Sheet mis à jour' : ''}`;
    }

    if (Array.isArray(summary.properties) && summary.properties.length > 0) {
      cardsContainer.innerHTML = summary.properties
        .map((p) => {
          const typeLabel =
            p.utilityType === 'GAS'
              ? '🔥 Gaz (PCE)'
              : p.isHpHc
              ? '⚡ Option HP / HC (PDL)'
              : '⚡ Option Base (PDL)';
          const rescueBadge = p.rescueModeUsed
            ? `<div style="margin-top:4px;font-size:10px;color:#fbbf24;font-weight:700">🛟 Mode Secours kWh actif (coûts en erreur côté Octopus)</div>`
            : '';
          const costPart =
            p.totalEur > 0 ? ` • ${formatFrNum(p.totalEur)} € TTC` : ' • (kWh bruts récupérés)';

          return `
            <div class="prop-card">
              <div class="prop-title">${p.displayName || p.name}</div>
              <div class="prop-sub">${typeLabel} ${p.pdl} • ${p.address || ''}</div>
              <div class="prop-stats">${p.daysCount} jours${p.lastDate ? ` (→ ${p.lastDate})` : ''} • ${formatFrNum(p.totalKwh)} kWh${costPart}</div>
              ${rescueBadge}
            </div>
          `;
        })
        .join('');
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
    syncBtn.textContent = '⏳ Scan en cours...';
    statusBadge.textContent = 'Scan API...';
    statusBadge.className = 'badge badge-sync';
    statusMessage.className = 'status-box hidden';

    let pageToken = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id && tab.url && tab.url.includes('octopusenergy.fr')) {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_COOKIE_TOKEN' });
        if (resp && resp.accessToken) pageToken = resp.accessToken;
      }
    } catch (e) {}

    chrome.runtime.sendMessage(
      {
        type: 'OCTOPUS_SYNC_NOW',
        accessToken: pageToken,
        isAuto: false,
        monthsToFetch: Number(monthsSelect.value) || 12
      },
      (res) => {
        syncBtn.disabled = false;
        syncBtn.textContent = '🔄 Scanner le compte';

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
          const count = (res.summary && res.summary.properties && res.summary.properties.length) || 0;
          showStatus(`✅ ${count} compteur(s) récupéré(s) ! Ouvrez le Tableau de bord pour visualiser.`, false);
        } else {
          statusBadge.textContent = 'Erreur';
          statusBadge.className = 'badge badge-err';
          showStatus((res && res.error) || 'Erreur inconnue', true);
        }
      }
    );
  });
});
