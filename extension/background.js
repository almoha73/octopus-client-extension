/**
 * Service Worker d'arrière-plan - Octopus Energy Sync & Diagnostic Universel
 * - Rafraîchit automatiquement le jeton JWT (accessToken) via le refreshToken si expiré le matin
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

// Configuration connue et garantie pour les 2 logements du compte propriétaire A-3E0B5AD1
const KNOWN_OWNER_PROPERTIES = {
  '717277': {
    key: 'lapleau',
    accountNumber: OWNER_ACCOUNT_NUMBER,
    propertyId: '717277',
    address: '4 Route De Lapleau, St Merd De Lapleau, 19320',
    postcode: '19320',
    name: 'St Merd De Lapleau (19320)',
    displayName: '🏡 St Merd De Lapleau (19320)',
    pdl: '17566859598256',
    utilityType: 'ELECTRICITY',
    isHpHc: false
  },
  '78601': {
    key: 'bordeaux',
    accountNumber: OWNER_ACCOUNT_NUMBER,
    propertyId: '78601',
    address: '38 Rue Commandant Hautreux, Res Les Allees Balgu 3 415, Bordeaux, 33300',
    postcode: '33300',
    name: 'Bordeaux (33300)',
    displayName: '🏢 Bordeaux (33300)',
    pdl: '16185528047969',
    utilityType: 'ELECTRICITY',
    isHpHc: true
  }
};

// 1. Requête légère et 100% fiable pour lister les comptes et logements du client connecté
const VIEWER_ACCOUNTS_QUERY = `query GetViewerAccounts {
  viewer {
    accounts {
      number
      ... on AccountType {
        properties {
          id
          address
          postcode
        }
      }
    }
  }
}`;

// 2. Requête officielle utilisée par l'espace client octopusenergy.fr pour récupérer les contrats et compteurs (PDL/PCE)
const ACCOUNT_AGREEMENTS_QUERY = `query GetAccountAgreements($accountNumber: String!) {
  agreements(first: 50, accountNumber: $accountNumber) {
    edges {
      node {
        __typename
        supplyPoint {
          __typename
          id
          marketName
          externalIdentifier
          meterPoint {
            __typename
            id
            propertyId
            isSmartMeter
            ... on ElectricityMeterPoint {
              subscribedMaxPower
              offPeakValues {
                label
              }
            }
            ... on GasMeterPoint {
              annualConsumption
            }
          }
        }
      }
    }
  }
}`;

// 3. Requête de secours par logement avec pagination Relay explicite (first: 20)
const PROPERTY_SUPPLY_POINTS_QUERY = `query GetPropertySupplyPoints($propertyId: ID!) {
  property(id: $propertyId) {
    id
    address
    postcode
    supplyPointsInterface(first: 20) {
      edges {
        node {
          id
          marketName
          externalIdentifier
          ... on SupplyPointType {
            meterPoint {
              __typename
              id
              propertyId
              isSmartMeter
            }
          }
        }
      }
    }
  }
}`;

// 4. Mutation Kraken pour rafraîchir automatiquement un accessToken expiré via le cookie refreshToken
const REFRESH_TOKEN_MUTATION = `mutation RefreshKrakenToken($input: ObtainJSONWebTokenInput!) {
  obtainKrakenToken(input: $input) {
    token
    refreshToken
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
      explicitRefreshToken: message.refreshToken || null,
      isAuto: Boolean(message.isAuto),
      monthsToFetch: Number(message.monthsToFetch) || 12
    })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

/**
 * Vérifie si un jeton JWT (accessToken) est expiré ou expire dans moins de 30 secondes
 */
function isJwtExpired(token) {
  if (!token || typeof token !== 'string') return true;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    if (payload && typeof payload.exp === 'number') {
      return payload.exp * 1000 < Date.now() + 30000;
    }
  } catch (e) {}
  return false;
}

/**
 * Lit les cookies accessToken et refreshToken depuis l'API chrome.cookies et/ou l'onglet actif
 */
async function readOctopusCookies(explicitToken = null, explicitRefreshToken = null) {
  let accessToken = explicitToken && explicitToken.length > 20 ? explicitToken : null;
  let refreshToken = explicitRefreshToken && explicitRefreshToken.length > 10 ? explicitRefreshToken : null;

  try {
    const allCookies = await chrome.cookies.getAll({ domain: 'octopusenergy.fr' });
    for (const c of allCookies || []) {
      if (c.name === 'accessToken' && c.value && !accessToken) {
        accessToken = decodeURIComponent(c.value);
      }
      if (c.name === 'refreshToken' && c.value && !refreshToken) {
        refreshToken = decodeURIComponent(c.value);
      }
    }
  } catch (e) {}

  if (!accessToken) {
    try {
      const c = await chrome.cookies.get({ url: 'https://octopusenergy.fr', name: 'accessToken' });
      if (c && c.value) accessToken = decodeURIComponent(c.value);
    } catch (e) {}
  }

  if (!refreshToken) {
    try {
      const c = await chrome.cookies.get({ url: 'https://octopusenergy.fr', name: 'refreshToken' });
      if (c && c.value) refreshToken = decodeURIComponent(c.value);
    } catch (e) {}
  }

  // Fallback via scripting sur un onglet octopusenergy.fr ouvert (utile si l'extension vient d'être rechargée)
  if ((!accessToken || isJwtExpired(accessToken)) && chrome.tabs && chrome.scripting) {
    try {
      const tabs = await chrome.tabs.query({ url: ['https://octopusenergy.fr/*', 'https://*.octopusenergy.fr/*'] });
      for (const tab of tabs || []) {
        if (!tab.id) continue;
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const getCk = (name) => {
              const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
              return m ? decodeURIComponent(m[1]) : null;
            };
            return {
              accessToken: getCk('accessToken'),
              refreshToken: getCk('refreshToken'),
              href: window.location.href
            };
          }
        });
        const res = results && results[0] && results[0].result;
        if (res) {
          if (res.accessToken && (!accessToken || isJwtExpired(accessToken))) {
            accessToken = res.accessToken;
          }
          if (res.refreshToken && !refreshToken) {
            refreshToken = res.refreshToken;
          }
        }
      }
    } catch (e) {}
  }

  return { accessToken, refreshToken };
}

/**
 * Rafraîchit le jeton JWT Kraken à l'aide du refreshToken et met à jour le cookie Chrome
 */
async function refreshKrakenAccessToken(refreshToken) {
  if (!refreshToken) return null;
  try {
    const response = await fetch(KRAKEN_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        operationName: 'RefreshKrakenToken',
        query: REFRESH_TOKEN_MUTATION,
        variables: {
          input: { refreshToken }
        }
      })
    });
    if (!response.ok) return null;
    const json = await response.json();
    const tokenData = json && json.data && json.data.obtainKrakenToken;
    if (tokenData && tokenData.token) {
      try {
        await chrome.cookies.set({
          url: 'https://octopusenergy.fr',
          name: 'accessToken',
          value: tokenData.token,
          path: '/',
          secure: true,
          sameSite: 'lax'
        });
        if (tokenData.refreshToken) {
          await chrome.cookies.set({
            url: 'https://octopusenergy.fr',
            name: 'refreshToken',
            value: tokenData.refreshToken,
            path: '/',
            secure: true,
            sameSite: 'lax'
          });
        }
      } catch (e) {}
      return tokenData.token;
    }
  } catch (e) {}
  return null;
}

/**
 * Récupère un accessToken valide (et le rafraîchit automatiquement s'il a expiré pendant la nuit)
 */
async function getValidAccessToken(explicitToken = null, explicitRefreshToken = null) {
  const { accessToken, refreshToken } = await readOctopusCookies(explicitToken, explicitRefreshToken);

  if (accessToken && !isJwtExpired(accessToken)) {
    return { token: accessToken, refreshToken };
  }

  // Si l'accessToken est expiré ou absent mais qu'on a un refreshToken, on le régénère !
  if (refreshToken) {
    const freshToken = await refreshKrakenAccessToken(refreshToken);
    if (freshToken) {
      return { token: freshToken, refreshToken };
    }
  }

  return { token: accessToken || null, refreshToken: refreshToken || null };
}

async function graphqlRequest(token, query, variables = {}, operationName = undefined) {
  const body = { query, variables };
  if (operationName) body.operationName = operationName;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  if (token) {
    headers.Authorization = token;
  }

  const response = await fetch(KRAKEN_GRAPHQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Erreur HTTP API Octopus (${response.status})`);
  }

  return await response.json();
}

function isGraphqlAuthError(json) {
  if (!json || !Array.isArray(json.errors)) return false;
  return json.errors.some((e) => {
    const msg = String((e && e.message) || '').toLowerCase();
    const code = String((e && e.extensions && e.extensions.errorCode) || '');
    const type = String((e && e.extensions && e.extensions.errorType) || '');
    return (
      type === 'AUTHORIZATION' ||
      code === 'KT-CT-1111' ||
      code === 'KT-CT-1112' ||
      code === 'KT-CT-1143' ||
      msg.includes('expired') ||
      msg.includes('authorization') ||
      msg.includes('credential') ||
      msg.includes('jwt')
    );
  });
}

function normalizeMeterId(rawId) {
  if (!rawId) return null;
  const s = String(rawId).trim();
  if (/^\d{10,16}$/.test(s)) return s;
  try {
    const decoded = atob(s);
    if (decoded && decoded.includes(':')) {
      const afterColon = decoded.split(':').pop().trim();
      if (afterColon) return afterColon;
    }
  } catch (e) {}
  return s;
}

function pickBestPdl(sp, mp) {
  const candidates = [
    mp && mp.id,
    sp && sp.externalIdentifier,
    sp && sp.id
  ]
    .map(normalizeMeterId)
    .filter(Boolean);

  const digits14 = candidates.find((c) => /^\d{14}$/.test(c));
  if (digits14) return digits14;
  const digitsAny = candidates.find((c) => /^\d{10,16}$/.test(c));
  if (digitsAny) return digitsAny;
  return candidates[0] || null;
}

/**
 * Découvre automatiquement tous les comptes, logements et compteurs (Électricité Linky & Gaz Gazpar)
 */
async function discoverClientSupplyPoints(token, refreshToken = null) {
  let activeToken = token;
  let viewerJson = await graphqlRequest(activeToken, VIEWER_ACCOUNTS_QUERY, {}, 'GetViewerAccounts');

  // Si le jeton a expiré côté Kraken, on tente un rafraîchissement immédiat via refreshToken
  if (
    (!viewerJson.data || !viewerJson.data.viewer) &&
    isGraphqlAuthError(viewerJson) &&
    refreshToken
  ) {
    const refreshed = await refreshKrakenAccessToken(refreshToken);
    if (refreshed) {
      activeToken = refreshed;
      viewerJson = await graphqlRequest(activeToken, VIEWER_ACCOUNTS_QUERY, {}, 'GetViewerAccounts');
    }
  }

  if (!viewerJson.data || !viewerJson.data.viewer) {
    if (isGraphqlAuthError(viewerJson)) {
      throw new Error(
        'Votre session Octopus Energy a expiré. Rafraîchissez la page octopusenergy.fr (touche F5) puis réessayez.'
      );
    }
    if (viewerJson.errors && viewerJson.errors.length > 0) {
      throw new Error(viewerJson.errors[0].message || 'Impossible de lire le profil Octopus Energy.');
    }
  }

  const accounts =
    (viewerJson.data && viewerJson.data.viewer && viewerJson.data.viewer.accounts) || [];
  const discovered = [];
  const seenKeys = new Set();

  for (const acc of accounts) {
    const accountNumber = acc.number || OWNER_ACCOUNT_NUMBER;
    const props = acc.properties || [];
    const propById = new Map();
    for (const p of props) {
      if (p && p.id) {
        propById.set(String(p.id), p);
      }
    }

    // 1. Si le logement fait partie des 2 logements connus du compte propriétaire A-3E0B5AD1,
    //    on garantit ses métadonnées exactes (PDL, nom, option Base vs HP/HC)
    for (const p of props) {
      const pid = String(p.id);
      if (KNOWN_OWNER_PROPERTIES[pid]) {
        const known = { ...KNOWN_OWNER_PROPERTIES[pid], accountNumber };
        if (p.address) known.address = p.address;
        if (p.postcode) known.postcode = p.postcode;
        discovered.push(known);
        seenKeys.add(`${pid}_${known.pdl}`);
      }
    }

    // 2. Découverte universelle via agreements(first: 50, accountNumber) — méthode officielle de l'espace client
    try {
      const agJson = await graphqlRequest(
        activeToken,
        ACCOUNT_AGREEMENTS_QUERY,
        { accountNumber },
        'GetAccountAgreements'
      );
      const agEdges =
        (agJson && agJson.data && agJson.data.agreements && agJson.data.agreements.edges) || [];

      for (const edge of agEdges) {
        const node = edge && edge.node;
        const sp = node && node.supplyPoint;
        if (!sp) continue;
        const mp = sp.meterPoint || {};
        const propId = String(mp.propertyId || '');
        const pInfo = propById.get(propId) || {
          id: propId || 'logement',
          address: '',
          postcode: ''
        };

        const pdl = pickBestPdl(sp, mp);
        if (!pdl) continue;

        const dedupKey = `${pInfo.id}_${pdl}`;
        if (seenKeys.has(dedupKey)) continue;
        seenKeys.add(dedupKey);

        const isGas =
          mp.__typename === 'GasMeterPoint' ||
          node.__typename === 'GasSpecificAgreementType' ||
          /gas|gaz/i.test(sp.marketName || '');

        const hasOffPeak =
          Array.isArray(mp.offPeakValues) && mp.offPeakValues.length > 0;
        const shortCity = extractCityFromAddress(pInfo.address, pInfo.postcode);
        const energyBadge = isGas ? '🔥 Gaz' : '⚡ Élec';

        discovered.push({
          key: `prop_${pInfo.id}_${pdl}`,
          accountNumber,
          propertyId: String(pInfo.id),
          address: pInfo.address || `Logement ${pInfo.id}`,
          postcode: pInfo.postcode || '',
          name: `${shortCity} (${pInfo.postcode || pInfo.id})`,
          displayName: `${isGas ? '🔥' : '🏡'} ${shortCity} (${pInfo.postcode || energyBadge})`,
          pdl: String(pdl),
          utilityType: isGas ? 'GAS' : 'ELECTRICITY',
          subscribedMaxPower: mp.subscribedMaxPower || null,
          isHpHc: hasOffPeak || String(pInfo.id) === '78601'
        });
      }
    } catch (e) {}

    // 3. Pour tout logement qui n'aurait pas encore été associé à un compteur via agreements,
    //    on interroge supplyPointsInterface(first: 20) sur ce logement
    for (const p of props) {
      const pid = String(p.id);
      const alreadyFoundForProp = discovered.some((d) => d.propertyId === pid);
      if (alreadyFoundForProp) continue;

      try {
        const spJson = await graphqlRequest(
          activeToken,
          PROPERTY_SUPPLY_POINTS_QUERY,
          { propertyId: pid },
          'GetPropertySupplyPoints'
        );
        const spEdges =
          (spJson &&
            spJson.data &&
            spJson.data.property &&
            spJson.data.property.supplyPointsInterface &&
            spJson.data.property.supplyPointsInterface.edges) ||
          [];

        for (const edge of spEdges) {
          const node = edge && edge.node;
          if (!node) continue;
          const mp = node.meterPoint || {};
          const pdl = pickBestPdl(node, mp);
          if (!pdl) continue;

          const dedupKey = `${pid}_${pdl}`;
          if (seenKeys.has(dedupKey)) continue;
          seenKeys.add(dedupKey);

          const isGas =
            mp.__typename === 'GasMeterPoint' || /gas|gaz/i.test(node.marketName || '');
          const shortCity = extractCityFromAddress(p.address, p.postcode);
          const energyBadge = isGas ? '🔥 Gaz' : '⚡ Élec';

          discovered.push({
            key: `prop_${pid}_${pdl}`,
            accountNumber,
            propertyId: pid,
            address: p.address || `Logement ${pid}`,
            postcode: p.postcode || '',
            name: `${shortCity} (${p.postcode || pid})`,
            displayName: `${isGas ? '🔥' : '🏡'} ${shortCity} (${p.postcode || energyBadge})`,
            pdl: String(pdl),
            utilityType: isGas ? 'GAS' : 'ELECTRICITY',
            isHpHc: pid === '78601'
          });
        }
      } catch (e) {}

      // 4. Ultime repli : si aucun PDL n'est remonté pour ce logement, on l'ajoute quand même
      //    (GetPropertyMeasurements fonctionnera sans filtre marketSupplyPointId)
      if (!discovered.some((d) => d.propertyId === pid)) {
        const shortCity = extractCityFromAddress(p.address, p.postcode);
        discovered.push({
          key: `prop_${pid}`,
          accountNumber,
          propertyId: pid,
          address: p.address || `Logement ${pid}`,
          postcode: p.postcode || '',
          name: `${shortCity} (${p.postcode || pid})`,
          displayName: `🏡 ${shortCity} (${p.postcode || pid})`,
          pdl: '',
          utilityType: 'ELECTRICITY',
          isHpHc: pid === '78601'
        });
      }
    }
  }

  return { discovered, activeToken };
}

function extractCityFromAddress(address, postcode) {
  if (!address) return 'Logement';
  const parts = String(address)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
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
    const gf = {
      readingFrequencyType: 'DAY_INTERVAL'
    };
    if (prop.pdl) {
      gf.marketSupplyPointId = prop.pdl;
    }
    return [{ gasFilters: gf }];
  }
  const ef = {
    readingFrequencyType: 'DAY_INTERVAL'
  };
  if (prop.pdl) {
    ef.marketSupplyPointId = prop.pdl;
  }
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

function mergeRowsByDate(existingRows, incomingRows) {
  const map = new Map();
  for (const r of existingRows || []) {
    if (Array.isArray(r) && r[0]) map.set(r[0], r);
  }
  for (const r of incomingRows || []) {
    if (Array.isArray(r) && r[0]) map.set(r[0], r);
  }
  return Array.from(map.values()).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

async function runFullSync({
  explicitToken = null,
  explicitRefreshToken = null,
  isAuto = false,
  monthsToFetch = 12
} = {}) {
  if (isSyncing) {
    return { ok: false, error: 'Synchronisation déjà en cours...' };
  }

  const cfg = await chrome.storage.local.get([
    'webAppUrl',
    'autoSync',
    'lastSyncAtMs',
    'syncedData'
  ]);
  if (isAuto && cfg.autoSync === false) {
    return { ok: false, skipped: true, reason: 'Synchronisation automatique désactivée' };
  }

  if (isAuto && cfg.lastSyncAtMs && Date.now() - cfg.lastSyncAtMs < 5 * 60 * 1000) {
    return { ok: true, skipped: true, reason: 'Déjà synchronisé récemment' };
  }

  const { token, refreshToken } = await getValidAccessToken(explicitToken, explicitRefreshToken);
  if (!token) {
    throw new Error(
      'Session Octopus Energy non détectée. Connectez-vous sur octopusenergy.fr/espace-client puis rafraîchissez la page (F5).'
    );
  }

  isSyncing = true;
  try {
    // 1. Auto-découverte universelle des logements et compteurs du client connecté
    const { discovered: discoveredProps, activeToken } = await discoverClientSupplyPoints(
      token,
      refreshToken
    );
    if (!discoveredProps.length) {
      throw new Error(
        'Aucun logement ou compteur trouvé. Rafraîchissez votre onglet octopusenergy.fr (touche F5) puis réessayez.'
      );
    }

    const accountNumber = discoveredProps[0].accountNumber;
    const isOwnerAccount = accountNumber === OWNER_ACCOUNT_NUMBER;
    const effectiveMonths = isAuto ? 3 : monthsToFetch;

    const propertiesPayload = [];
    let lapleauRows = null;
    let bordeauxRows = null;

    for (const prop of discoveredProps) {
      const parsed = await fetchPropertyDataMonthByMonth(prop, activeToken, effectiveMonths);
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
      const prevSynced = cfg.syncedData || {};
      storageUpdate.syncedData = {
        lapleau: mergeRowsByDate(prevSynced.lapleau, lapleauRows),
        bordeaux: mergeRowsByDate(prevSynced.bordeaux, bordeauxRows)
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
