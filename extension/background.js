/**
 * Service Worker d'arrière-plan - Octopus Energy Sync
 * Récupère les mesures des 2 logements mois par mois sur l'API GraphQL Kraken
 * (pour respecter le prorata mensuel exact de l'abonnement)
 * et les fusionne dans Google Sheets via Google Apps Script.
 */

const DEFAULT_WEBAPP_URL =
  'https://script.google.com/macros/s/AKfycbyXUPxpUlzVcXnb_c2nfffleF-yaRulmOPCkysjVOuol8JmBOaFdA4HZdYEuXgso9IH/exec';
const DEFAULT_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1xATSqg21M2ILGiKw2aj2Z4YGLd-NuB0GQhYrpR33ROQ/edit';

const KRAKEN_GRAPHQL_URL = 'https://api.oefr-kraken.energy/v1/graphql/';

const PROPERTIES = [
  {
    key: 'lapleau',
    id: '717277',
    name: 'St Merd De Lapleau (19320)',
    pdl: '17566859598256',
    isHpHc: false
  },
  {
    key: 'bordeaux',
    id: '78601',
    name: 'Bordeaux (33300)',
    pdl: '16185528047969',
    isHpHc: true
  }
];

const MEASUREMENTS_QUERY = `query GetPropertyMeasurements($propertyId: ID!, $startAt: DateTime!, $endAt: DateTime!, $utilityFilters: [UtilityFiltersInput]!, $first: Int) {
  property(id: $propertyId) {
    measurements(
      startAt: $startAt
      endAt: $endAt
      utilityFilters: $utilityFilters
      first: $first
    ) {
      edges {
        node {
          ...IntervalMeasurement
        }
      }
    }
  }
}

fragment IntervalMeasurement on IntervalMeasurementType {
  __typename
  value
  startAt
  source
  metaData {
    statistics {
      costInclTax {
        estimatedAmount
        costCurrency
      }
      label
      value
    }
  }
}`;

let isSyncing = false;

chrome.runtime.onInstalled.addListener(async () => {
  const cfg = await chrome.storage.local.get(['webAppUrl', 'autoSync']);
  const updates = {};
  if (!cfg.webAppUrl) updates.webAppUrl = DEFAULT_WEBAPP_URL;
  if (typeof cfg.autoSync !== 'boolean') updates.autoSync = true;
  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OCTOPUS_SYNC_NOW') {
    runFullSync(message.accessToken || null, Boolean(message.isAuto))
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function getAccessToken(explicitToken) {
  if (explicitToken && explicitToken.length > 20) {
    return explicitToken;
  }
  try {
    const cookie = await chrome.cookies.get({
      url: 'https://octopusenergy.fr',
      name: 'accessToken'
    });
    if (cookie && cookie.value) {
      return decodeURIComponent(cookie.value);
    }
  } catch (e) {
    // fallback
  }
  return null;
}

/**
 * Retourne l'ISO 8601 du 1er du mois à 00:00:00 en heure de Paris (+01:00 ou +02:00)
 */
function getParisMonthStartIso(year, monthIndex0) {
  const dtUtc = new Date(Date.UTC(year, monthIndex0, 1, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    timeZoneName: 'longOffset'
  }).formatToParts(dtUtc);
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  let offset = '+01:00';
  if (tzPart && tzPart.value) {
    const m = tzPart.value.match(/GMT([+-]\d{2}:\d{2})/);
    if (m) offset = m[1];
  }
  const y = dtUtc.getUTCFullYear();
  const m = String(dtUtc.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01T00:00:00${offset}`;
}

/**
 * Génère les fenêtres mensuelles des N derniers mois jusqu'au mois courant inclus
 */
function getRecentMonthWindows(monthsCount = 3) {
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth();
  const windows = [];
  for (let i = monthsCount - 1; i >= 0; i--) {
    const dStart = new Date(Date.UTC(curY, curM - i, 1));
    const dEnd = new Date(Date.UTC(curY, curM - i + 1, 1));
    windows.push({
      startAt: getParisMonthStartIso(dStart.getUTCFullYear(), dStart.getUTCMonth()),
      endAt: getParisMonthStartIso(dEnd.getUTCFullYear(), dEnd.getUTCMonth())
    });
  }
  return windows;
}

function parsePropertyMeasurements(edges, isHpHc) {
  const rows = [];
  let totalKwh = 0;
  let totalEur = 0;

  for (const edge of edges || []) {
    const m = edge && edge.node;
    if (!m || !m.startAt) continue;

    const isoDate = String(m.startAt).substring(0, 10);
    const kwhTotal = Number(Number(m.value || 0).toFixed(3));
    const stats = (m.metaData && m.metaData.statistics) || [];

    let aboEur = 0;
    let baseEur = 0;
    let hpKwh = 0;
    let hcKwh = 0;
    let hpEur = 0;
    let hcEur = 0;

    for (const s of stats) {
      const lbl = s && s.label;
      const amt = Number((s && s.costInclTax && s.costInclTax.estimatedAmount) || 0) / 100.0;
      const val = Number((s && s.value) || 0);

      if (lbl === 'ABONNEMENT') {
        aboEur += amt;
      } else if (lbl === 'Base') {
        baseEur += amt;
      } else if (lbl === 'Heures Pleines') {
        hpKwh += val;
        hpEur += amt;
      } else if (lbl === 'Heures Creuses') {
        hcKwh += val;
        hcEur += amt;
      }
    }

    totalKwh += kwhTotal;

    if (isHpHc) {
      totalEur += hpEur + hcEur + aboEur;
      rows.push([
        isoDate,
        kwhTotal,
        Number(hpKwh.toFixed(3)),
        Number(hcKwh.toFixed(3)),
        Number(hpEur.toFixed(4)),
        Number(hcEur.toFixed(4)),
        Number(aboEur.toFixed(4))
      ]);
    } else {
      totalEur += baseEur + aboEur;
      rows.push([
        isoDate,
        kwhTotal,
        Number(baseEur.toFixed(4)),
        Number(aboEur.toFixed(4))
      ]);
    }
  }

  return {
    rows,
    daysCount: rows.length,
    firstDate: rows.length ? rows[0][0] : null,
    lastDate: rows.length ? rows[rows.length - 1][0] : null,
    totalKwh: Number(totalKwh.toFixed(2)),
    totalEur: Number(totalEur.toFixed(2))
  };
}

async function fetchPropertyDataMonthByMonth(prop, token) {
  const windows = getRecentMonthWindows(3);
  const allEdges = [];

  for (const w of windows) {
    const payload = {
      operationName: 'GetPropertyMeasurements',
      query: MEASUREMENTS_QUERY,
      variables: {
        propertyId: prop.id,
        first: 35,
        startAt: w.startAt,
        endAt: w.endAt,
        utilityFilters: [
          {
            electricityFilters: {
              readingQuality: 'ACTUAL',
              readingFrequencyType: 'DAY_INTERVAL',
              marketSupplyPointId: prop.pdl
            }
          }
        ]
      }
    };

    const response = await fetch(KRAKEN_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: token
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Erreur API Octopus (${response.status})`);
    }

    const json = await response.json();
    if (json.errors && json.errors.length > 0) {
      throw new Error(json.errors[0].message || 'Jeton Octopus expiré ou invalide');
    }

    const edges =
      (json.data &&
        json.data.property &&
        json.data.property.measurements &&
        json.data.property.measurements.edges) ||
      [];
    allEdges.push(...edges);
  }

  return parsePropertyMeasurements(allEdges, prop.isHpHc);
}

async function runFullSync(explicitToken, isAuto = false) {
  if (isSyncing) {
    return { ok: false, error: 'Synchronisation déjà en cours...' };
  }

  const cfg = await chrome.storage.local.get(['webAppUrl', 'autoSync', 'lastSyncAtMs']);
  if (isAuto && cfg.autoSync === false) {
    return { ok: false, skipped: true, reason: 'Synchronisation automatique désactivée' };
  }

  if (isAuto && cfg.lastSyncAtMs && Date.now() - cfg.lastSyncAtMs < 10 * 60 * 1000) {
    return { ok: true, skipped: true, reason: 'Déjà synchronisé récemment' };
  }

  const token = await getAccessToken(explicitToken);
  if (!token) {
    throw new Error(
      'Session Octopus Energy non détectée. Connectez-vous sur octopusenergy.fr/espace-client.'
    );
  }

  isSyncing = true;
  try {
    const lapleauData = await fetchPropertyDataMonthByMonth(PROPERTIES[0], token);
    const bordeauxData = await fetchPropertyDataMonthByMonth(PROPERTIES[1], token);

    const webAppUrl = (cfg.webAppUrl || DEFAULT_WEBAPP_URL).trim();

    const sheetResp = await fetch(webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        lapleau: lapleauData.rows,
        bordeaux: bordeauxData.rows
      })
    });

    if (!sheetResp.ok) {
      throw new Error(`Erreur Google Sheets (${sheetResp.status})`);
    }

    let sheetResult = {};
    try {
      sheetResult = await sheetResp.json();
    } catch (e) {
      sheetResult = { status: 'ok' };
    }

    if (sheetResult.status === 'error') {
      throw new Error(sheetResult.message || 'Erreur lors de la mise à jour du Sheet');
    }

    const summary = {
      syncedAt: new Date().toLocaleString('fr-FR'),
      lapleau: {
        name: PROPERTIES[0].name,
        daysCount: lapleauData.daysCount,
        firstDate: lapleauData.firstDate,
        lastDate: lapleauData.lastDate,
        totalKwh: lapleauData.totalKwh,
        totalEur: lapleauData.totalEur
      },
      bordeaux: {
        name: PROPERTIES[1].name,
        daysCount: bordeauxData.daysCount,
        firstDate: bordeauxData.firstDate,
        lastDate: bordeauxData.lastDate,
        totalKwh: bordeauxData.totalKwh,
        totalEur: bordeauxData.totalEur
      },
      spreadsheetUrl: sheetResult.spreadsheetUrl || DEFAULT_SHEET_URL
    };

    await chrome.storage.local.set({
      lastSyncSummary: summary,
      lastSyncStatus: 'success',
      lastSyncError: null,
      lastSyncAtMs: Date.now(),
      syncedData: {
        lapleau: lapleauData.rows,
        bordeaux: bordeauxData.rows
      }
    });

    return { ok: true, summary };
  } catch (err) {
    await chrome.storage.local.set({
      lastSyncStatus: 'error',
      lastSyncError: err.message
    });
    throw err;
  } finally {
    isSyncing = false;
  }
}
