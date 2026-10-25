/**
 * Service Worker d'arrière-plan - Octopus Energy Sync & Diagnostic Universel
 * - Auto-découvre tous les comptes, logements, compteurs Linky (PDL) et Gazpar (PCE)
 *   de n'importe quel client connecté sur octopusenergy.fr
 * - Récupère les consommations mois par mois (avec coûts € TTC)
 * - Mode Secours automatique : si le calcul de coût Octopus est en erreur sur l'espace client,
 *   récupère automatiquement les kWh bruts Linky/Gazpar sans metaData !
 * - Synchronise vers Google Sheets (si configuré pour le compte) et alimente le Tableau de bord visuel.
 */

const DEFAULT_WEBAPP_URL =
  'https://script.google.com/macros/s/AKfycbyXUPxpUlzVcXnb_c2nfffleF-yaRulmOPCkysjVOuol8JmBOaFdA4HZdYEuXgso9IH/exec';
const DEFAULT_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1xATSqg21M2ILGiKw2aj2Z4YGLd-NuB0GQhYrpR33ROQ/edit';

const OWNER_ACCOUNT_NUMBER = 'A-3E0B5AD1';
const KRAKEN_GRAPHQL_URL = 'https://api.oefr-kraken.energy/v1/graphql/';

const DISCOVER_QUERY = `query DiscoverClientProperties {
  viewer {
    accounts {
      number
      ... on AccountType {
        properties {
          id
          address
          postcode
          supplyPointsInterface {
            edges {
              node {
                id
                marketName
                externalIdentifier
                ... on SupplyPointType {
                  meterPoint {
                    __typename
                    id
                    isSmartMeter
                    ... on ElectricityMeterPoint {
                      subscribedMaxPower
                      offPeakLabel
                    }
                    ... on GasMeterPoint {
                      annualConsumption
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const MEASUREMENTS_WITH_COST_QUERY = `query GetPropertyMeasurements($propertyId: ID!, $startAt: DateTime!, $endAt: DateTime!, $utilityFilters: [UtilityFiltersInput]!, $first: Int) {
  property(id: $propertyId) {
    measurements(
      startAt: $startAt
      endAt: $endAt
      utilityFilters: $utilityFilters
      first: $first
    ) {
      edges {
        node {
          ... on IntervalMeasurementType {
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
          }
        }
      }
    }
  }
}`;

// Requête Mode Secours (sans metaData.statistics) lorsque le moteur de coût Octopus plante sur un contrat
const MEASUREMENTS_RAW_KWH_QUERY = `query GetPropertyMeasurementsRaw($propertyId: ID!, $startAt: DateTime!, $endAt: DateTime!, $utilityFilters: [UtilityFiltersInput]!, $first: Int) {
  property(id: $propertyId) {
    measurements(
      startAt: $startAt
      endAt: $endAt
      utilityFilters: $utilityFilters
      first: $first
    ) {
      edges {
        node {
          ... on IntervalMeasurementType {
            __typename
            value
            startAt
            source
          }
        }
      }
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
    runFullSync({
      explicitToken: message.accessToken || null,
      isAuto: Boolean(message.isAuto),
      monthsToFetch: Number(message.monthsToFetch) || 12
    })
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
  } catch (e) {}
  return null;
}

async function graphqlRequest(token, query, variables = {}, operationName = undefined) {
  const body = { query, variables };
  if (operationName) body.operationName = operationName;

  const response = await fetch(KRAKEN_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: token
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Erreur HTTP API Octopus (${response.status})`);
  }

  return await response.json();
}

/**
 * Découvre automatiquement tous les comptes, logements et compteurs (Électricité Linky & Gaz Gazpar)
 */
async function discoverClientSupplyPoints(token) {
  const json = await graphqlRequest(token, DISCOVER_QUERY);
  if (json.errors && json.errors.length > 0 && !json.data) {
    throw new Error(json.errors[0].message || 'Impossible de lire les logements du compte');
  }

  const accounts = (json.data && json.data.viewer && json.data.viewer.accounts) || [];
  const discovered = [];

  for (const acc of accounts) {
    const accountNumber = acc.number || 'Compte';
    const props = acc.properties || [];

    for (const p of props) {
      const spEdges = (p.supplyPointsInterface && p.supplyPointsInterface.edges) || [];
      for (const edge of spEdges) {
        const node = edge && edge.node;
        if (!node) continue;
        const mp = node.meterPoint || {};
        const typename = mp.__typename || '';
        const isGas = typename === 'GasMeterPoint' || /gas|gaz/i.test(node.marketName || '');
        const marketSupplyPointId = node.externalIdentifier || mp.id || node.id;
        if (!marketSupplyPointId) continue;

        const shortCity = extractCityFromAddress(p.address, p.postcode);
        const energyBadge = isGas ? '🔥 Gaz' : '⚡ Élec';

        discovered.push({
          key: `prop_${p.id}_${marketSupplyPointId}`,
          accountNumber,
          propertyId: String(p.id),
          address: p.address || `Logement ${p.id}`,
          postcode: p.postcode || '',
          name: `${shortCity} (${p.postcode || p.id})`,
          displayName: `${isGas ? '🔥' : '🏡'} ${shortCity} (${p.postcode || energyBadge})`,
          pdl: String(marketSupplyPointId),
          utilityType: isGas ? 'GAS' : 'ELECTRICITY',
          subscribedMaxPower: mp.subscribedMaxPower || null,
          offPeakLabel: mp.offPeakLabel || null,
          isHpHc: Boolean(mp.offPeakLabel) || String(p.id) === '78601'
        });
      }
    }
  }

  return discovered;
}

function extractCityFromAddress(address, postcode) {
  if (!address) return 'Logement';
  const parts = String(address)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    // Souvent: "Rue..., Ville, CodePostal"
    const candidate = parts[parts.length - 2];
    if (candidate && !/^\d+$/.test(candidate)) return candidate;
  }
  return parts[0];
}

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

function getRecentMonthWindows(monthsCount = 12) {
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth();
  const windows = [];
  for (let i = monthsCount - 1; i >= 0; i--) {
    const dStart = new Date(Date.UTC(curY, curM - i, 1));
    const dEnd = new Date(Date.UTC(curY, curM - i + 1, 1));
    windows.push({
      ym: `${dStart.getUTCFullYear()}-${String(dStart.getUTCMonth() + 1).padStart(2, '0')}`,
      startAt: getParisMonthStartIso(dStart.getUTCFullYear(), dStart.getUTCMonth()),
      endAt: getParisMonthStartIso(dEnd.getUTCFullYear(), dEnd.getUTCMonth())
    });
  }
  return windows;
}

function buildUtilityFilters(prop, includeReadingQuality = true) {
  if (prop.utilityType === 'GAS') {
    return [
      {
        gasFilters: {
          readingFrequencyType: 'DAY_INTERVAL',
          marketSupplyPointId: prop.pdl
        }
      }
    ];
  }
  const ef = {
    readingFrequencyType: 'DAY_INTERVAL',
    marketSupplyPointId: prop.pdl
  };
  if (includeReadingQuality) {
    ef.readingQuality = 'ACTUAL';
  }
  return [{ electricityFilters: ef }];
}

/**
 * Récupère un mois de mesures avec repli automatique en Mode Secours (kWh bruts)
 * si le calcul de coût Octopus (metaData.statistics) plante sur le contrat du client.
 */
async function fetchMonthWithFallback(prop, windowObj, token) {
  const baseVars = {
    propertyId: prop.propertyId,
    first: 35,
    startAt: windowObj.startAt,
    endAt: windowObj.endAt,
    utilityFilters: buildUtilityFilters(prop, true)
  };

  // 1. Tentative normale avec coûts (metaData.statistics)
  try {
    const res = await graphqlRequest(
      token,
      MEASUREMENTS_WITH_COST_QUERY,
      baseVars,
      'GetPropertyMeasurements'
    );
    const edges =
      res &&
      res.data &&
      res.data.property &&
      res.data.property.measurements &&
      res.data.property.measurements.edges;

    if (Array.isArray(edges) && edges.length > 0) {
      return { edges, fallbackUsed: false };
    }
    if (res.errors && res.errors.length > 0) {
      // Erreur sur metaData -> bascule en mode secours kWh bruts
      const rawRes = await graphqlRequest(
        token,
        MEASUREMENTS_RAW_KWH_QUERY,
        baseVars,
        'GetPropertyMeasurementsRaw'
      );
      const rawEdges =
        (rawRes &&
          rawRes.data &&
          rawRes.data.property &&
          rawRes.data.property.measurements &&
          rawRes.data.property.measurements.edges) ||
        [];
      if (rawEdges.length > 0) {
        return { edges: rawEdges, fallbackUsed: true };
      }
    }
  } catch (e) {
    // Repli en mode secours
  }

  // 2. Tentative Mode Secours sans metaData et sans filtre readingQuality
  try {
    const rescueVars = {
      ...baseVars,
      utilityFilters: buildUtilityFilters(prop, false)
    };
    const rawRes = await graphqlRequest(
      token,
      MEASUREMENTS_RAW_KWH_QUERY,
      rescueVars,
      'GetPropertyMeasurementsRaw'
    );
    const rawEdges =
      (rawRes &&
        rawRes.data &&
        rawRes.data.property &&
        rawRes.data.property.measurements &&
        rawRes.data.property.measurements.edges) ||
      [];
    return { edges: rawEdges, fallbackUsed: rawEdges.length > 0 };
  } catch (e) {
    return { edges: [], fallbackUsed: false };
  }
}

function parsePropertyMeasurements(edges, prop, fallbackMonthsCount = 0) {
  const rows = [];
  let totalKwh = 0;
  let totalEur = 0;
  let detectedHpHc = Boolean(prop.isHpHc);
  let daysWithCost = 0;

  for (const edge of edges || []) {
    const m = edge && edge.node;
    if (!m || !m.startAt) continue;

    const isoDate = String(m.startAt).substring(0, 10);
    const kwhTotal = Number(Number(m.value || 0).toFixed(3));
    const stats = (m.metaData && m.metaData.statistics) || [];

    for (const s of stats) {
      if (s && (s.label === 'Heures Pleines' || s.label === 'Heures Creuses')) {
        detectedHpHc = true;
      }
    }

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
      } else if (lbl === 'Heures Pleines') {
        hpKwh += val;
        hpEur += amt;
      } else if (lbl === 'Heures Creuses') {
        hcKwh += val;
        hcEur += amt;
      } else {
        baseEur += amt;
      }
    }

    const dayConsoEur = detectedHpHc ? hpEur + hcEur : baseEur;
    if (dayConsoEur > 0 || aboEur > 0) {
      daysWithCost++;
    }

    totalKwh += kwhTotal;
    totalEur += dayConsoEur + aboEur;

    if (detectedHpHc) {
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
    isHpHc: detectedHpHc,
    daysCount: rows.length,
    daysWithCost,
    rescueModeUsed: fallbackMonthsCount > 0 || (rows.length > 0 && daysWithCost === 0),
    firstDate: rows.length ? rows[0][0] : null,
    lastDate: rows.length ? rows[rows.length - 1][0] : null,
    totalKwh: Number(totalKwh.toFixed(2)),
    totalEur: Number(totalEur.toFixed(2))
  };
}

async function fetchPropertyDataMonthByMonth(prop, token, monthsCount = 12) {
  const windows = getRecentMonthWindows(monthsCount);
  const allEdges = [];
  let fallbackMonthsCount = 0;

  for (const w of windows) {
    const { edges, fallbackUsed } = await fetchMonthWithFallback(prop, w, token);
    if (fallbackUsed) fallbackMonthsCount++;
    allEdges.push(...edges);
  }

  return parsePropertyMeasurements(allEdges, prop, fallbackMonthsCount);
}

async function runFullSync({ explicitToken = null, isAuto = false, monthsToFetch = 6 } = {}) {
  if (isSyncing) {
    return { ok: false, error: 'Synchronisation déjà en cours...' };
  }

  const cfg = await chrome.storage.local.get(['webAppUrl', 'autoSync', 'lastSyncAtMs']);
  if (isAuto && cfg.autoSync === false) {
    return { ok: false, skipped: true, reason: 'Synchronisation automatique désactivée' };
  }

  if (isAuto && cfg.lastSyncAtMs && Date.now() - cfg.lastSyncAtMs < 5 * 60 * 1000) {
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
    // 1. Auto-découverte universelle des logements et compteurs du client connecté
    const discoveredProps = await discoverClientSupplyPoints(token);
    if (!discoveredProps.length) {
      throw new Error('Aucun logement ou compteur trouvé sur ce compte Octopus Energy.');
    }

    const accountNumber = discoveredProps[0].accountNumber;
    const isOwnerAccount = accountNumber === OWNER_ACCOUNT_NUMBER;
    const effectiveMonths = isAuto ? 3 : monthsToFetch;

    const propertiesPayload = [];
    let lapleauRows = null;
    let bordeauxRows = null;

    for (const prop of discoveredProps) {
      const parsed = await fetchPropertyDataMonthByMonth(prop, token, effectiveMonths);
      prop.isHpHc = parsed.isHpHc;

      propertiesPayload.push({
        ...prop,
        daysCount: parsed.daysCount,
        daysWithCost: parsed.daysWithCost,
        rescueModeUsed: parsed.rescueModeUsed,
        firstDate: parsed.firstDate,
        lastDate: parsed.lastDate,
        totalKwh: parsed.totalKwh,
        totalEur: parsed.totalEur,
        rows: parsed.rows
      });

      if (prop.propertyId === '717277') lapleauRows = parsed.rows;
      if (prop.propertyId === '78601') bordeauxRows = parsed.rows;
    }

    // 2. Si c'est votre compte personnel (A-3E0B5AD1), on pousse aussi vers votre Google Sheet
    let sheetSynced = false;
    if (isOwnerAccount && (lapleauRows || bordeauxRows)) {
      const webAppUrl = (cfg.webAppUrl || DEFAULT_WEBAPP_URL).trim();
      if (webAppUrl) {
        try {
          const sheetResp = await fetch(webAppUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
              lapleau: lapleauRows || [],
              bordeaux: bordeauxRows || []
            })
          });
          sheetSynced = sheetResp.ok;
        } catch (e) {}
      }
    }

    const summary = {
      syncedAt: new Date().toLocaleString('fr-FR'),
      accountNumber,
      isOwnerAccount,
      sheetSynced,
      properties: propertiesPayload.map((p) => ({
        key: p.key,
        propertyId: p.propertyId,
        name: p.name,
        displayName: p.displayName,
        address: p.address,
        pdl: p.pdl,
        utilityType: p.utilityType,
        isHpHc: p.isHpHc,
        daysCount: p.daysCount,
        daysWithCost: p.daysWithCost,
        rescueModeUsed: p.rescueModeUsed,
        firstDate: p.firstDate,
        lastDate: p.lastDate,
        totalKwh: p.totalKwh,
        totalEur: p.totalEur
      })),
      spreadsheetUrl: DEFAULT_SHEET_URL
    };

    const storageUpdate = {
      lastSyncSummary: summary,
      lastSyncStatus: 'success',
      lastSyncError: null,
      lastSyncAtMs: Date.now(),
      universalClientData: {
        accountNumber,
        isOwnerAccount,
        syncedAt: summary.syncedAt,
        properties: propertiesPayload
      }
    };

    if (isOwnerAccount && (lapleauRows || bordeauxRows)) {
      storageUpdate.syncedData = {
        lapleau: lapleauRows || [],
        bordeaux: bordeauxRows || []
      };
    }

    await chrome.storage.local.set(storageUpdate);

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
