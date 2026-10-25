/**
 * ============================================================================
 * OCTOPUS ENERGY - SUIVI CONSOMMATION MULTI-LOGEMENTS (Google Apps Script)
 * ============================================================================
 * Feuille Google Sheet cible :
 * https://docs.google.com/spreadsheets/d/1xATSqg21M2ILGiKw2aj2Z4YGLd-NuB0GQhYrpR33ROQ/edit
 *
 * COMMENT L'UTILISER :
 *   1. Dans votre Google Sheet, ouvrez Extensions > Apps Script
 *   2. Collez tout ce code dans Code.gs et enregistrez (Ctrl+S)
 *   3. Sélectionnez la fonction "remplirSheetOctopus" en haut et cliquez sur "Exécuter"
 *      -> Crée et remplit immédiatement :
 *         - "📊 Synthèse" (Comparatif & bilan mensuel des 2 logements)
 *         - "🏡 St Merd De Lapleau (19320)" (457 jours - Option Base)
 *         - "🏢 Bordeaux (33300)" (875 jours - Option HP / HC)
 *   4. (Optionnel) Déployez en Application Web (doPost) pour les futures mises à jour.
 * ============================================================================
 */

const SPREADSHEET_ID = '1xATSqg21M2ILGiKw2aj2Z4YGLd-NuB0GQhYrpR33ROQ';
const SHEET_SYNTHESE = '📊 Synthèse';
const SHEET_LAPLEAU = '🏡 St Merd De Lapleau';
const SHEET_BORDEAUX = '🏢 Bordeaux';

const OCTO_PURPLE = '#180048';
const OCTO_PINK = '#f050f8';
const OCTO_BG_LIGHT = '#f5f3ff';

/**
 * Fonction principale à exécuter directement depuis l'éditeur Apps Script (bouton "Exécuter")
 */
function remplirSheetOctopus() {
  const ss = getTargetSpreadsheet_();
  const data = getInitialEmbeddedData_();
  syncAllSheets_(ss, data.lapleau, data.bordeaux);
}

/**
 * Point d'entrée GET (vérification Web App ou lecture live des données ?action=data)
 */
function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'data') {
    const ss = getTargetSpreadsheet_();
    const sLap = ss.getSheetByName(SHEET_LAPLEAU);
    const sBdx = ss.getSheetByName(SHEET_BORDEAUX);
    const lapleau = [];
    const bordeaux = [];

    if (sLap && sLap.getLastRow() >= 3) {
      const vals = sLap.getRange(3, 1, sLap.getLastRow() - 2, 5).getValues();
      for (let i = 0; i < vals.length; i++) {
        const iso = normalizeToIsoDate_(vals[i][0]);
        if (iso) {
          lapleau.push([iso, Number(vals[i][2]) || 0, Number(vals[i][3]) || 0, Number(vals[i][4]) || 0]);
        }
      }
    }
    if (sBdx && sBdx.getLastRow() >= 3) {
      const vals = sBdx.getRange(3, 1, sBdx.getLastRow() - 2, 10).getValues();
      for (let i = 0; i < vals.length; i++) {
        const iso = normalizeToIsoDate_(vals[i][0]);
        if (iso) {
          bordeaux.push([
            iso,
            Number(vals[i][2]) || 0,
            Number(vals[i][3]) || 0,
            Number(vals[i][4]) || 0,
            Number(vals[i][6]) || 0,
            Number(vals[i][7]) || 0,
            Number(vals[i][9]) || 0
          ]);
        }
      }
    }
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'ok', lapleau, bordeaux })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(
    JSON.stringify({
      status: 'ok',
      message: 'Web App Octopus Energy opérationnelle !'
    })
  ).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Point d'entrée POST (synchronisation automatique depuis sync_octopus.py)
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getTargetSpreadsheet_();
    let lapleau = [];
    let bordeaux = [];
    if (e && e.postData && e.postData.contents) {
      const payload = JSON.parse(e.postData.contents);
      lapleau = payload.lapleau || [];
      bordeaux = payload.bordeaux || [];
    } else {
      const init = getInitialEmbeddedData_();
      lapleau = init.lapleau;
      bordeaux = init.bordeaux;
    }
    const res = syncAllSheets_(ss, lapleau, bordeaux);
    return ContentService.createTextOutput(
      JSON.stringify({
        status: 'ok',
        message: `Synchronisation réussie : St Merd De Lapleau (${res.lapleauCount} j), Bordeaux (${res.bordeauxCount} j).`,
        spreadsheetUrl: ss.getUrl()
      })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'error', message: err.message })
    ).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function getTargetSpreadsheet_() {
  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (e) {}
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function syncAllSheets_(ss, incomingLapleau, incomingBordeaux) {
  const locale = ss.getSpreadsheetLocale() || 'fr_FR';
  const sep = /^(en|ja|zh|ko|he|ar)/i.test(locale) ? ',' : ';';

  // 1. Feuille St Merd De Lapleau (Option Base)
  const lapleauMerged = writeBasePropertySheet_(
    ss,
    SHEET_LAPLEAU,
    '🏡 ST MERD DE LAPLEAU (19320) — 4 Route De Lapleau | PDL 17566859598256 (Option Base)',
    incomingLapleau,
    sep
  );

  // 2. Feuille Bordeaux (Option HP/HC)
  const bordeauxMerged = writeHpHcPropertySheet_(
    ss,
    SHEET_BORDEAUX,
    '🏢 BORDEAUX (33300) — 38 Rue Commandant Hautreux | PDL 16185528047969 (Heures Pleines / Creuses)',
    incomingBordeaux,
    sep
  );

  // 3. Feuille Synthèse
  writeSyntheseSheet_(ss, lapleauMerged, bordeauxMerged);

  // 4. Nettoyage feuille vide par défaut ("Feuille 1" / "Sheet1")
  cleanupDefaultEmptySheet_(ss);

  return {
    lapleauCount: lapleauMerged.length,
    bordeauxCount: bordeauxMerged.length
  };
}

/**
 * Écrit l'onglet d'un logement en Option Base (St Merd De Lapleau)
 * Format d'entrée : [isoDate, kwhTotal, baseEur, aboEur]
 */
function writeBasePropertySheet_(ss, sheetName, title, incomingRows, sep) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  // Fusionner avec les lignes déjà présentes (sans doublons sur isoDate)
  const map = new Map();
  const lastRow = sheet.getLastRow();
  if (lastRow >= 3) {
    const existing = sheet.getRange(3, 1, lastRow - 2, 5).getValues();
    for (let i = 0; i < existing.length; i++) {
      const iso = normalizeToIsoDate_(existing[i][0]);
      if (!iso) continue;
      map.set(iso, [
        iso,
        Number(existing[i][2]) || 0,
        Number(existing[i][3]) || 0,
        Number(existing[i][4]) || 0
      ]);
    }
  }

  (incomingRows || []).forEach((r) => {
    if (r && r[0]) map.set(String(r[0]), r);
  });

  // Trier du plus récent au plus ancien
  const sorted = Array.from(map.values()).sort((a, b) => String(b[0]).localeCompare(String(a[0])));

  const existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();
  sheet.clearContents();

  const lastDataRow = Math.max(3, sorted.length + 2);

  const summaryRow = [
    title,
    `=SUBTOTAL(3${sep} A3:A${lastDataRow}) & " jours"`,
    `=SUBTOTAL(9${sep} C3:C${lastDataRow})`,
    `=SUBTOTAL(9${sep} D3:D${lastDataRow})`,
    `=SUBTOTAL(9${sep} E3:E${lastDataRow})`,
    `=SUBTOTAL(9${sep} F3:F${lastDataRow})`,
    `=IFERROR(D1/C1${sep} 0)`
  ];

  const headers = [
    'Date',
    'Mois',
    'Conso Base (kWh)',
    'Coût Conso TTC (€)',
    'Abonnement TTC (€)',
    'Total TTC (€)',
    'Prix Moyen Conso (€/kWh)'
  ];

  const rows = [summaryRow, headers];

  sorted.forEach((r, idx) => {
    const rowNum = idx + 3;
    const iso = String(r[0]);
    const ym = iso.substring(0, 7);
    const kwh = Number(r[1]) || 0;
    const baseEur = Number(r[2]) || 0;
    const aboEur = Number(r[3]) || 0;
    rows.push([
      isoToFrDate_(iso),
      ym,
      kwh,
      baseEur,
      aboEur,
      `=D${rowNum}+E${rowNum}`,
      `=IFERROR(D${rowNum}/C${rowNum}${sep} 0)`
    ]);
  });

  if (sorted.length > 0) {
    sheet.getRange(3, 1, sorted.length, 2).setNumberFormat('@');
  }

  sheet.getRange(1, 1, rows.length, 7).setValues(rows);

  // Mise en forme Ligne 1 (Sous-totaux)
  sheet.getRange(1, 1, 1, 7)
    .setBackground(OCTO_BG_LIGHT)
    .setFontColor(OCTO_PURPLE)
    .setFontWeight('bold')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 34);
  sheet.getRange(1, 3).setNumberFormat('#,##0.000 "kWh"');
  sheet.getRange(1, 4, 1, 3).setNumberFormat('#,##0.00 [$€-fr-FR]');
  sheet.getRange(1, 7).setNumberFormat('0.0000 "€/kWh"');

  // Mise en forme Ligne 2 (En-têtes)
  sheet.getRange(2, 1, 1, 7)
    .setBackground(OCTO_PURPLE)
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setVerticalAlignment('middle')
    .setHorizontalAlignment('center');
  sheet.setRowHeight(2, 30);
  sheet.setFrozenRows(2);

  if (sorted.length > 0) {
    sheet.getRange(3, 1, sorted.length, 7).setVerticalAlignment('middle').setFontSize(10);
    sheet.getRange(3, 1, sorted.length, 2).setHorizontalAlignment('center');
    sheet.getRange(3, 3, sorted.length, 1).setNumberFormat('#,##0.000');
    sheet.getRange(3, 4, sorted.length, 3).setNumberFormat('#,##0.00 [$€-fr-FR]');
    sheet.getRange(3, 6, sorted.length, 1).setFontWeight('bold');
    sheet.getRange(3, 7, sorted.length, 1).setNumberFormat('0.0000');
    sheet.getRange(2, 1, sorted.length + 1, 7).createFilter();
  }

  const widths = [120, 95, 145, 150, 150, 140, 175];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  return sorted;
}

/**
 * Écrit l'onglet d'un logement en Option Heures Pleines / Heures Creuses (Bordeaux)
 * Format d'entrée : [isoDate, kwhTotal, hpKwh, hcKwh, hpEur, hcEur, aboEur]
 */
function writeHpHcPropertySheet_(ss, sheetName, title, incomingRows, sep) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  const map = new Map();
  const lastRow = sheet.getLastRow();
  if (lastRow >= 3) {
    const existing = sheet.getRange(3, 1, lastRow - 2, 10).getValues();
    for (let i = 0; i < existing.length; i++) {
      const iso = normalizeToIsoDate_(existing[i][0]);
      if (!iso) continue;
      map.set(iso, [
        iso,
        Number(existing[i][2]) || 0,
        Number(existing[i][3]) || 0,
        Number(existing[i][4]) || 0,
        Number(existing[i][6]) || 0,
        Number(existing[i][7]) || 0,
        Number(existing[i][9]) || 0
      ]);
    }
  }

  (incomingRows || []).forEach((r) => {
    if (r && r[0]) map.set(String(r[0]), r);
  });

  const sorted = Array.from(map.values()).sort((a, b) => String(b[0]).localeCompare(String(a[0])));

  const existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();
  sheet.clearContents();

  const lastDataRow = Math.max(3, sorted.length + 2);

  const summaryRow = [
    title,
    `=SUBTOTAL(3${sep} A3:A${lastDataRow}) & " jours"`,
    `=SUBTOTAL(9${sep} C3:C${lastDataRow})`,
    `=SUBTOTAL(9${sep} D3:D${lastDataRow})`,
    `=SUBTOTAL(9${sep} E3:E${lastDataRow})`,
    `=IFERROR(E1/C1${sep} 0)`,
    `=SUBTOTAL(9${sep} G3:G${lastDataRow})`,
    `=SUBTOTAL(9${sep} H3:H${lastDataRow})`,
    `=SUBTOTAL(9${sep} I3:I${lastDataRow})`,
    `=SUBTOTAL(9${sep} J3:J${lastDataRow})`,
    `=SUBTOTAL(9${sep} K3:K${lastDataRow})`
  ];

  const headers = [
    'Date',
    'Mois',
    'Conso Totale (kWh)',
    'Heures Pleines (kWh)',
    'Heures Creuses (kWh)',
    'Part HC (%)',
    'Coût HP TTC (€)',
    'Coût HC TTC (€)',
    'Coût Conso TTC (€)',
    'Abonnement TTC (€)',
    'Total TTC (€)'
  ];

  const rows = [summaryRow, headers];

  sorted.forEach((r, idx) => {
    const rowNum = idx + 3;
    const iso = String(r[0]);
    const ym = iso.substring(0, 7);
    const kwhTotal = Number(r[1]) || 0;
    const hpKwh = Number(r[2]) || 0;
    const hcKwh = Number(r[3]) || 0;
    const hpEur = Number(r[4]) || 0;
    const hcEur = Number(r[5]) || 0;
    const aboEur = Number(r[6]) || 0;
    rows.push([
      isoToFrDate_(iso),
      ym,
      kwhTotal,
      hpKwh,
      hcKwh,
      `=IFERROR(E${rowNum}/C${rowNum}${sep} 0)`,
      hpEur,
      hcEur,
      `=G${rowNum}+H${rowNum}`,
      aboEur,
      `=I${rowNum}+J${rowNum}`
    ]);
  });

  if (sorted.length > 0) {
    sheet.getRange(3, 1, sorted.length, 2).setNumberFormat('@');
  }

  sheet.getRange(1, 1, rows.length, 11).setValues(rows);

  // Mise en forme Ligne 1
  sheet.getRange(1, 1, 1, 11)
    .setBackground(OCTO_BG_LIGHT)
    .setFontColor(OCTO_PURPLE)
    .setFontWeight('bold')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 34);
  sheet.getRange(1, 3, 1, 3).setNumberFormat('#,##0.000 "kWh"');
  sheet.getRange(1, 6).setNumberFormat('0.0%');
  sheet.getRange(1, 7, 1, 5).setNumberFormat('#,##0.00 [$€-fr-FR]');

  // Mise en forme Ligne 2
  sheet.getRange(2, 1, 1, 11)
    .setBackground(OCTO_PURPLE)
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setVerticalAlignment('middle')
    .setHorizontalAlignment('center');
  sheet.setRowHeight(2, 30);
  sheet.setFrozenRows(2);

  if (sorted.length > 0) {
    sheet.getRange(3, 1, sorted.length, 11).setVerticalAlignment('middle').setFontSize(10);
    sheet.getRange(3, 1, sorted.length, 2).setHorizontalAlignment('center');
    sheet.getRange(3, 3, sorted.length, 3).setNumberFormat('#,##0.000');
    sheet.getRange(3, 3, sorted.length, 1).setFontWeight('bold');
    sheet.getRange(3, 6, sorted.length, 1).setNumberFormat('0.0%');
    sheet.getRange(3, 7, sorted.length, 5).setNumberFormat('#,##0.00 [$€-fr-FR]');
    sheet.getRange(3, 11, sorted.length, 1).setFontWeight('bold');
    sheet.getRange(2, 1, sorted.length + 1, 11).createFilter();
  }

  const widths = [115, 90, 145, 145, 145, 100, 130, 130, 145, 145, 135];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  return sorted;
}

/**
 * Écrit l'onglet "📊 Synthèse" avec le résumé global et l'historique mensuel comparé des 2 logements
 */
function writeSyntheseSheet_(ss, lapleauRows, bordeauxRows) {
  let sheet = ss.getSheetByName(SHEET_SYNTHESE);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_SYNTHESE, 0);
  } else {
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(1);
  }

  const existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();
  sheet.clear();

  // Calcul des totaux par logement et par mois
  const monthsMap = new Map();

  let lapTotKwh = 0, lapTotConsoEur = 0, lapTotAboEur = 0;
  lapleauRows.forEach((r) => {
    const ym = String(r[0]).substring(0, 7);
    const kwh = Number(r[1]) || 0;
    const consoEur = Number(r[2]) || 0;
    const aboEur = Number(r[3]) || 0;
    lapTotKwh += kwh;
    lapTotConsoEur += consoEur;
    lapTotAboEur += aboEur;

    if (!monthsMap.has(ym)) {
      monthsMap.set(ym, { lapKwh: 0, lapEur: 0, bdxKwh: 0, bdxEur: 0 });
    }
    const m = monthsMap.get(ym);
    m.lapKwh += kwh;
    m.lapEur += (consoEur + aboEur);
  });

  let bdxTotKwh = 0, bdxTotConsoEur = 0, bdxTotAboEur = 0;
  bordeauxRows.forEach((r) => {
    const ym = String(r[0]).substring(0, 7);
    const kwh = Number(r[1]) || 0;
    const consoEur = (Number(r[4]) || 0) + (Number(r[5]) || 0);
    const aboEur = Number(r[6]) || 0;
    bdxTotKwh += kwh;
    bdxTotConsoEur += consoEur;
    bdxTotAboEur += aboEur;

    if (!monthsMap.has(ym)) {
      monthsMap.set(ym, { lapKwh: 0, lapEur: 0, bdxKwh: 0, bdxEur: 0 });
    }
    const m = monthsMap.get(ym);
    m.bdxKwh += kwh;
    m.bdxEur += (consoEur + aboEur);
  });

  const lapFirst = lapleauRows.length ? isoToFrDate_(lapleauRows[lapleauRows.length - 1][0]) : '-';
  const lapLast = lapleauRows.length ? isoToFrDate_(lapleauRows[0][0]) : '-';
  const bdxFirst = bordeauxRows.length ? isoToFrDate_(bordeauxRows[bordeauxRows.length - 1][0]) : '-';
  const bdxLast = bordeauxRows.length ? isoToFrDate_(bordeauxRows[0][0]) : '-';

  const topRows = [
    ['🐙 OCTOPUS ENERGY — SYNTHÈSE DES 2 LOGEMENTS (COMPTE A-3E0B5AD1)', '', '', '', '', '', '', ''],
    ['Logement', 'Adresse', 'PDL / Option', 'Période disponible', 'Jours relevés', 'Conso Totale (kWh)', 'Coût Conso TTC (€)', 'Coût Total Abonnement + Conso (€)'],
    [
      '🏡 St Merd De Lapleau (19320)',
      '4 Route De Lapleau, 19320 St Merd De Lapleau',
      '17566859598256 (Base)',
      `Du ${lapFirst} au ${lapLast}`,
      lapleauRows.length,
      lapTotKwh,
      lapTotConsoEur,
      lapTotConsoEur + lapTotAboEur
    ],
    [
      '🏢 Bordeaux (33300)',
      '38 Rue Commandant Hautreux, 33300 Bordeaux',
      '16185528047969 (HP / HC)',
      `Du ${bdxFirst} au ${bdxLast}`,
      bordeauxRows.length,
      bdxTotKwh,
      bdxTotConsoEur,
      bdxTotConsoEur + bdxTotAboEur
    ],
    [
      'TOTAL CUMULÉ (2 LOGEMENTS)',
      '',
      '',
      '',
      lapleauRows.length + bordeauxRows.length,
      lapTotKwh + bdxTotKwh,
      lapTotConsoEur + bdxTotConsoEur,
      lapTotConsoEur + lapTotAboEur + bdxTotConsoEur + bdxTotAboEur
    ],
    ['', '', '', '', '', '', '', ''],
    ['📅 HISTORIQUE MENSUEL COMPARÉ', '', '', '', '', '', '', ''],
    [
      'Mois',
      '🏡 St Merd — Conso (kWh)',
      '🏡 St Merd — Total TTC (€)',
      '🏢 Bordeaux — Conso (kWh)',
      '🏢 Bordeaux — Total TTC (€)',
      '⚡ Total 2 Logements (kWh)',
      '💶 Total 2 Logements TTC (€)',
      ''
    ]
  ];

  const sortedMonths = Array.from(monthsMap.keys()).sort((a, b) => b.localeCompare(a));
  sortedMonths.forEach((ym) => {
    const m = monthsMap.get(ym);
    topRows.push([
      ym,
      m.lapKwh,
      m.lapEur,
      m.bdxKwh,
      m.bdxEur,
      m.lapKwh + m.bdxKwh,
      m.lapEur + m.bdxEur,
      ''
    ]);
  });

  sheet.getRange(1, 1, topRows.length, 8).setValues(topRows);

  // Styles Titre principal
  sheet.getRange(1, 1, 1, 8)
    .setBackground(OCTO_PURPLE)
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(12)
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 36);

  // En-tête tableau logements
  sheet.getRange(2, 1, 1, 8)
    .setBackground('#3b0764')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(2, 28);

  sheet.getRange(3, 1, 3, 8).setVerticalAlignment('middle');
  sheet.getRange(5, 1, 1, 8).setBackground(OCTO_BG_LIGHT).setFontWeight('bold');
  sheet.getRange(3, 6, 3, 1).setNumberFormat('#,##0.00 "kWh"');
  sheet.getRange(3, 7, 3, 2).setNumberFormat('#,##0.00 [$€-fr-FR]');

  // En-tête historique mensuel
  sheet.getRange(7, 1, 1, 7)
    .setBackground(OCTO_BG_LIGHT)
    .setFontColor(OCTO_PURPLE)
    .setFontWeight('bold')
    .setFontSize(11)
    .setVerticalAlignment('middle');
  sheet.setRowHeight(7, 30);

  sheet.getRange(8, 1, 1, 7)
    .setBackground(OCTO_PURPLE)
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(8, 28);

  if (sortedMonths.length > 0) {
    sheet.getRange(9, 1, sortedMonths.length, 1).setNumberFormat('@').setHorizontalAlignment('center');
    sheet.getRange(9, 2, sortedMonths.length, 1).setNumberFormat('#,##0.00 "kWh"');
    sheet.getRange(9, 3, sortedMonths.length, 1).setNumberFormat('#,##0.00 [$€-fr-FR]');
    sheet.getRange(9, 4, sortedMonths.length, 1).setNumberFormat('#,##0.00 "kWh"');
    sheet.getRange(9, 5, sortedMonths.length, 1).setNumberFormat('#,##0.00 [$€-fr-FR]');
    sheet.getRange(9, 6, sortedMonths.length, 1).setNumberFormat('#,##0.00 "kWh"').setFontWeight('bold');
    sheet.getRange(9, 7, sortedMonths.length, 1).setNumberFormat('#,##0.00 [$€-fr-FR]').setFontWeight('bold');
  }

  const widths = [210, 260, 195, 220, 185, 185, 190, 220];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
}

function cleanupDefaultEmptySheet_(ss) {
  const defaults = ['Feuille 1', 'Sheet1'];
  defaults.forEach((name) => {
    const s = ss.getSheetByName(name);
    if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) {
      ss.deleteSheet(s);
    }
  });
}

function isoToFrDate_(iso) {
  const p = String(iso || '').split('-');
  if (p.length !== 3) return iso;
  return `${p[2]}/${p[1]}/${p[0]}`;
}

function normalizeToIsoDate_(val) {
  if (!val) return '';
  if (Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val)) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(val).trim();
  const mFr = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (mFr) return `${mFr[3]}-${mFr[2]}-${mFr[1]}`;
  const mIso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (mIso) return `${mIso[1]}-${mIso[2]}-${mIso[3]}`;
  return '';
}

/**
 * Données historiques embarquées (St Merd De Lapleau : 457 j | Bordeaux : 875 j)
 */
function getInitialEmbeddedData_() {
  return {
    lapleau: [["2025-07-24",8.851,0.0,0.2186],["2025-07-25",5.245,0.787,0.6815],["2025-07-26",5.292,0.8011,0.6815],["2025-07-27",6.029,0.9135,0.6815],["2025-07-28",5.734,0.8714,0.6815],["2025-07-29",4.882,0.7308,0.6815],["2025-07-30",4.218,0.6324,0.6815],["2025-07-31",1.013,0.1546,0.6815],["2025-08-01",1.649,0.266,0.6551],["2025-08-02",1.672,0.266,0.6551],["2025-08-03",1.678,0.266,0.6551],["2025-08-04",1.678,0.266,0.6455],["2025-08-05",2.929,0.4581,0.6455],["2025-08-06",5.515,0.8719,0.6455],["2025-08-07",5.4,0.8571,0.6455],["2025-08-08",6.548,1.0344,0.6455],["2025-08-09",5.508,0.8719,0.6455],["2025-08-10",4.902,0.7684,0.6455],["2025-08-11",4.592,0.7241,0.6455],["2025-08-12",5.303,0.8423,0.6455],["2025-08-13",4.02,0.6354,0.6455],["2025-08-14",5.089,0.798,0.6455],["2025-08-15",3.65,0.5763,0.6455],["2025-08-16",4.85,0.7684,0.6455],["2025-08-17",3.277,0.5172,0.6455],["2025-08-18",3.186,0.5024,0.6455],["2025-08-19",4.326,0.6798,0.6455],["2025-08-20",4.822,0.7536,0.6455],["2025-08-21",4.936,0.7832,0.6455],["2025-08-22",4.932,0.7832,0.6455],["2025-08-23",7.482,1.1822,0.6455],["2025-08-24",4.847,0.7684,0.6455],["2025-08-25",6.217,0.9753,0.6455],["2025-08-26",5.652,0.8866,0.6455],["2025-08-27",8.393,1.33,0.6455],["2025-08-28",3.614,0.5763,0.6455],["2025-08-29",2.208,0.3547,0.6455],["2025-08-30",2.334,0.3694,0.6455],["2025-08-31",2.336,0.3694,0.6455],["2025-09-01",2.36,0.3716,0.6495],["2025-09-02",4.073,0.6391,0.6495],["2025-09-03",8.148,1.293,0.6495],["2025-09-04",4.605,0.7282,0.6495],["2025-09-05",5.757,0.9066,0.6495],["2025-09-06",4.733,0.758,0.6495],["2025-09-07",6.584,1.0404,0.6495],["2025-09-08",8.329,1.3227,0.6495],["2025-09-09",7.389,1.1741,0.6495],["2025-09-10",7.669,1.2187,0.6495],["2025-09-11",12.56,1.9915,0.6495],["2025-09-12",8.01,1.2633,0.6495],["2025-09-13",6.915,1.0998,0.6495],["2025-09-14",4.471,0.7134,0.6495],["2025-09-15",2.344,0.3716,0.6495],["2025-09-16",2.336,0.3716,0.6495],["2025-09-17",2.335,0.3716,0.6495],["2025-09-18",2.268,0.3567,0.6495],["2025-09-19",1.729,0.2675,0.6495],["2025-09-20",2.345,0.3716,0.6495],["2025-09-21",2.377,0.3716,0.6495],["2025-09-22",3.248,0.5202,0.6495],["2025-09-23",6.595,1.0404,0.6495],["2025-09-24",6.829,1.0849,0.6495],["2025-09-25",10.255,1.62,0.6495],["2025-09-26",6.04,0.9512,0.6495],["2025-09-27",10.163,1.6051,0.6495],["2025-09-28",7.67,1.2187,0.6495],["2025-09-29",7.892,1.2484,0.6495],["2025-09-30",7.194,1.1444,0.6495],["2025-10-01",7.001,1.1073,0.644],["2025-10-02",2.444,0.3839,0.644],["2025-10-03",2.141,0.3396,0.644],["2025-10-04",2.051,0.3248,0.644],["2025-10-05",2.043,0.3248,0.644],["2025-10-06",2.917,0.4577,0.644],["2025-10-07",8.784,1.3878,0.644],["2025-10-08",11.953,1.8898,0.644],["2025-10-09",11.604,1.8308,0.644],["2025-10-10",8.262,1.2992,0.644],["2025-10-11",10.464,1.6536,0.644],["2025-10-12",7.228,1.1368,0.644],["2025-10-13",7.454,1.1811,0.644],["2025-10-14",10.902,1.7126,0.644],["2025-10-15",5.157,0.812,0.644],["2025-10-16",1.969,0.31,0.644],["2025-10-17",2.034,0.3248,0.644],["2025-10-18",2.703,0.4282,0.644],["2025-10-19",2.032,0.3248,0.644],["2025-10-20",2.048,0.3248,0.644],["2025-10-21",2.064,0.3248,0.644],["2025-10-22",2.092,0.3248,0.644],["2025-10-23",2.09,0.3248,0.644],["2025-10-24",2.62,0.4134,0.644],["2025-10-25",2.175,0.3396,0.644],["2025-10-26",2.086,0.3248,0.6708],["2025-10-27",2.038,0.3248,0.644],["2025-10-28",2.027,0.3248,0.644],["2025-10-29",2.673,0.4282,0.644],["2025-10-30",2.013,0.31,0.644],["2025-10-31",2.027,0.3248,0.644],["2025-11-01",2.034,0.3732,0.6867],["2025-11-02",2.051,0.3732,0.6867],["2025-11-03",3.35,0.612,0.6867],["2025-11-04",7.543,1.3733,0.6867],["2025-11-05",9.699,1.7764,0.6867],["2025-11-06",11.326,1.7017,0.6867],["2025-11-07",9.714,1.4629,0.6867],["2025-11-08",7.398,1.1046,0.6867],["2025-11-09",9.281,1.3883,0.6867],["2025-11-10",8.836,1.3285,0.6867],["2025-11-11",9.224,1.3883,0.6867],["2025-11-12",8.294,1.2539,0.6867],["2025-11-13",7.241,1.0897,0.6867],["2025-11-14",8.005,1.2091,0.6867],["2025-11-15",7.913,1.1942,0.6867],["2025-11-16",11.364,1.7017,0.6867],["2025-11-17",7.578,1.1345,0.6867],["2025-11-18",6.729,1.0151,0.6867],["2025-11-19",7.642,1.1494,0.6867],["2025-11-20",8.877,1.3285,0.6867],["2025-11-21",11.008,1.6569,0.6867],["2025-11-22",9.164,1.3733,0.6867],["2025-11-23",9.602,1.448,0.6867],["2025-11-24",7.522,1.1345,0.6867],["2025-11-25",10.988,1.6569,0.6867],["2025-11-26",1.984,0.2985,0.6867],["2025-11-27",2.613,0.3881,0.6867],["2025-11-28",1.952,0.2985,0.6867],["2025-11-29",2.598,0.3881,0.6867],["2025-11-30",1.947,0.2985,0.6867],["2025-12-01",3.21,0.4785,0.6878],["2025-12-02",13.31,2.0035,0.6878],["2025-12-03",9.948,1.4952,0.6878],["2025-12-04",13.535,2.0334,0.6878],["2025-12-05",10.339,1.555,0.6878],["2025-12-06",12.359,1.854,0.6878],["2025-12-07",8.096,1.226,0.6878],["2025-12-08",10.535,1.5849,0.6878],["2025-12-09",9.729,1.4653,0.6878],["2025-12-10",4.655,0.7027,0.6878],["2025-12-11",2.081,0.314,0.6878],["2025-12-12",2.006,0.299,0.6878],["2025-12-13",1.985,0.299,0.6878],["2025-12-14",2.628,0.3887,0.6878],["2025-12-15",1.954,0.299,0.6878],["2025-12-16",2.58,0.3887,0.6878],["2025-12-17",1.953,0.299,0.6878],["2025-12-18",1.957,0.299,0.6878],["2025-12-19",2.55,0.3887,0.6878],["2025-12-20",1.972,0.299,0.6878],["2025-12-21",2.583,0.3887,0.6878],["2025-12-22",1.934,0.2841,0.6878],["2025-12-23",2.494,0.3738,0.6878],["2025-12-24",1.861,0.2841,0.6878],["2025-12-25",2.494,0.3738,0.6878],["2025-12-26",1.869,0.2841,0.6878],["2025-12-27",2.471,0.3738,0.6878],["2025-12-28",1.869,0.2841,0.6878],["2025-12-29",3.799,0.5682,0.6878],["2025-12-30",33.059,4.9789,0.6878],["2025-12-31",35.73,5.3826,0.6878],["2026-01-01",30.619,4.6944,0.7011],["2026-01-02",31.305,4.8011,0.7011],["2026-01-03",25.019,3.8409,0.7011],["2026-01-04",31.691,4.8621,0.7011],["2026-01-05",29.599,4.542,0.7011],["2026-01-06",33.218,5.1059,0.7011],["2026-01-07",19.541,3.0026,0.7011],["2026-01-08",2.217,0.3353,0.7011],["2026-01-09",1.641,0.2591,0.7011],["2026-01-10",2.259,0.3506,0.7011],["2026-01-11",1.556,0.2439,0.7011],["2026-01-12",5.099,0.7773,0.7011],["2026-01-13",31.546,4.8468,0.7011],["2026-01-14",30.432,4.6639,0.7011],["2026-01-15",19.997,3.0636,0.7011],["2026-01-16",22.607,3.4751,0.7011],["2026-01-17",21.441,3.2922,0.7011],["2026-01-18",20.167,3.0941,0.7011],["2026-01-19",16.342,2.5149,0.7011],["2026-01-20",10.836,1.6613,0.7011],["2026-01-21",1.517,0.2286,0.7011],["2026-01-22",1.775,0.2743,0.7011],["2026-01-23",1.872,0.2896,0.7011],["2026-01-24",1.463,0.2286,0.7011],["2026-01-25",2.111,0.3201,0.7011],["2026-01-26",5.654,0.8688,0.7011],["2026-01-27",28.445,4.3591,0.7011],["2026-01-28",22.754,3.4903,0.7011],["2026-01-29",23.284,3.5665,0.7011],["2026-01-30",22.07,3.3836,0.7011],["2026-01-31",15.923,2.4387,0.7011],["2026-02-01",16.258,2.3579,0.711],["2026-02-02",18.428,2.6673,0.711],["2026-02-03",4.579,0.6632,0.711],["2026-02-04",1.504,0.2211,0.711],["2026-02-05",2.18,0.3095,0.711],["2026-02-06",1.52,0.2211,0.711],["2026-02-07",1.508,0.2211,0.711],["2026-02-08",2.131,0.3095,0.711],["2026-02-09",1.469,0.2063,0.711],["2026-02-10",1.521,0.2211,0.711],["2026-02-11",2.2,0.3242,0.711],["2026-02-12",1.562,0.2211,0.711],["2026-02-13",2.164,0.3095,0.711],["2026-02-14",1.468,0.2063,0.711],["2026-02-15",1.474,0.2211,0.711],["2026-02-16",2.187,0.3242,0.711],["2026-02-17",1.442,0.2063,0.711],["2026-02-18",1.478,0.2211,0.711],["2026-02-19",2.205,0.3242,0.711],["2026-02-20",1.44,0.2063,0.711],["2026-02-21",2.14,0.3095,0.711],["2026-02-22",1.479,0.2211,0.711],["2026-02-23",10.957,1.5916,0.711],["2026-02-24",25.566,3.7136,0.711],["2026-02-25",18.369,2.6673,0.711],["2026-02-26",16.398,2.3726,0.711],["2026-02-27",25.131,3.64,0.711],["2026-02-28",14.242,2.0631,0.711],["2026-03-01",21.118,3.1612,0.7344],["2026-03-02",14.026,2.0974,0.7344],["2026-03-03",15.343,2.2949,0.7344],["2026-03-04",13.169,1.9758,0.7344],["2026-03-05",23.337,3.4956,0.7344],["2026-03-06",28.981,4.3315,0.7344],["2026-03-07",21.475,3.2068,0.7344],["2026-03-08",23.229,3.4804,0.7344],["2026-03-09",23.556,3.526,0.7344],["2026-03-10",22.304,3.3284,0.7344],["2026-03-11",12.986,1.9454,0.7344],["2026-03-12",30.848,4.6203,0.7344],["2026-03-13",27.007,4.0427,0.7344],["2026-03-14",25.859,3.8604,0.7344],["2026-03-15",20.556,3.0701,0.7344],["2026-03-16",25.348,3.7844,0.7344],["2026-03-17",2.564,0.38,0.7344],["2026-03-18",4.9,0.7295,0.7344],["2026-03-19",5.581,0.8359,0.7344],["2026-03-20",8.219,1.2311,0.7344],["2026-03-21",17.226,2.5837,0.7344],["2026-03-22",20.176,3.0245,0.7344],["2026-03-23",20.95,3.1308,0.7344],["2026-03-24",38.053,5.6842,0.7344],["2026-03-25",22.542,3.374,0.7344],["2026-03-26",11.458,1.7174,0.7344],["2026-03-27",2.114,0.3192,0.7344],["2026-03-28",1.534,0.4559,0.7344],["2026-03-29",1.501,0.0,0.7038],["2026-03-30",1.503,0.228,0.7344],["2026-03-31",1.537,0.228,0.7344],["2026-04-01",2.145,0.3138,0.7211],["2026-04-02",1.507,0.2241,0.7211],["2026-04-03",34.156,5.02,0.7211],["2026-04-04",17.05,2.51,0.7211],["2026-04-05",24.539,3.6007,0.7211],["2026-04-06",10.677,1.5688,0.7211],["2026-04-07",20.143,2.9582,0.7211],["2026-04-08",12.217,1.7929,0.7211],["2026-04-09",10.535,1.5538,0.7211],["2026-04-10",4.512,0.6574,0.7211],["2026-04-11",3.377,0.493,0.7211],["2026-04-12",3.378,0.493,0.7211],["2026-04-13",3.339,0.493,0.7211],["2026-04-14",3.325,0.493,0.7211],["2026-04-15",3.996,0.5827,0.7211],["2026-04-16",3.337,0.493,0.7211],["2026-04-17",3.348,0.493,0.7211],["2026-04-18",3.375,0.493,0.7211],["2026-04-19",13.527,1.9871,0.7211],["2026-04-20",9.632,1.4194,0.7211],["2026-04-21",13.076,1.9273,0.7211],["2026-04-22",11.087,1.6285,0.7211],["2026-04-23",3.967,0.5827,0.7211],["2026-04-24",15.625,2.3008,0.7211],["2026-04-25",12.556,1.8526,0.7211],["2026-04-26",9.683,1.4194,0.7211],["2026-04-27",6.431,0.9413,0.7211],["2026-04-28",13.303,1.9572,0.7211],["2026-04-29",6.468,0.9562,0.7211],["2026-04-30",8.689,1.2699,0.7211],["2026-05-01",8.453,1.2346,0.717],["2026-05-02",8.13,1.19,0.717],["2026-05-03",3.331,0.4909,0.717],["2026-05-04",8.121,1.19,0.717],["2026-05-05",14.855,2.1718,0.717],["2026-05-06",15.918,2.3354,0.714],["2026-05-07",10.641,1.5619,0.7182],["2026-05-08",14.4,2.1123,0.7182],["2026-05-09",10.367,1.5173,0.7182],["2026-05-10",16.437,2.4098,0.7182],["2026-05-11",5.704,0.833,0.7182],["2026-05-12",16.515,2.4247,0.7182],["2026-05-13",10.735,1.5768,0.7182],["2026-05-14",4.767,0.6991,0.7182],["2026-05-15",1.848,0.2678,0.7182],["2026-05-16",1.929,0.2826,0.7182],["2026-05-17",1.909,0.2826,0.7182],["2026-05-18",1.92,0.2826,0.7182],["2026-05-19",15.174,2.2164,0.7182],["2026-05-20",8.947,1.309,0.7182],["2026-05-21",11.495,1.6809,0.7182],["2026-05-22",10.769,1.5768,0.7182],["2026-05-23",17.967,2.6329,0.7182],["2026-05-24",19.541,2.856,0.7182],["2026-05-25",5.401,0.7884,0.7182],["2026-05-26",5.032,0.7438,0.7182],["2026-05-27",5.553,0.8181,0.7182],["2026-05-28",1.841,0.2678,0.7182],["2026-05-29",1.824,0.2678,0.7182],["2026-05-30",1.848,0.2678,0.7182],["2026-05-31",1.628,0.238,0.7182],["2026-06-01",11.277,1.6395,0.7129],["2026-06-02",17.23,2.511,0.7129],["2026-06-03",3.978,0.576,0.7129],["2026-06-04",8.324,1.2112,0.7129],["2026-06-05",17.6,2.5553,0.7129],["2026-06-06",9.225,1.3441,0.7129],["2026-06-07",13.345,1.9349,0.7129],["2026-06-08",5.598,0.8124,0.7129],["2026-06-09",12.833,1.8611,0.7129],["2026-06-10",1.614,0.2363,0.7129],["2026-06-11",1.713,0.2511,0.7129],["2026-06-12",1.711,0.2511,0.7129],["2026-06-13",1.754,0.2511,0.7129],["2026-06-14",1.768,0.2511,0.7129],["2026-06-15",6.146,0.8862,0.7129],["2026-06-16",13.273,1.9349,0.7129],["2026-06-17",10.036,1.4623,0.7129],["2026-06-18",8.439,1.2259,0.7129],["2026-06-19",5.235,0.7681,0.7129],["2026-06-20",2.106,0.3102,0.7129],["2026-06-21",3.091,0.4431,0.7129],["2026-06-22",15.729,2.2894,0.7129],["2026-06-23",10.746,1.5657,0.7129],["2026-06-24",3.461,0.5022,0.7129],["2026-06-25",1.929,0.2806,0.7129],["2026-06-26",1.989,0.2954,0.7129],["2026-06-27",1.329,0.192,0.7129],["2026-06-28",2.02,0.2954,0.7129],["2026-06-29",6.136,0.8862,0.7129],["2026-06-30",16.179,2.3485,0.7129],["2026-07-01",12.945,1.8631,0.7079],["2026-07-02",8.493,1.2323,0.7079],["2026-07-03",8.989,1.2909,0.7079],["2026-07-04",12.066,1.7457,0.7079],["2026-07-05",13.933,2.0098,0.7079],["2026-07-06",12.318,1.7751,0.7079],["2026-07-07",7.133,1.0269,0.7079],["2026-07-08",8.826,1.2763,0.7079],["2026-07-09",1.259,0.176,0.7079],["2026-07-10",2.014,0.2934,0.7079],["2026-07-11",1.991,0.2934,0.7079],["2026-07-12",1.977,0.2787,0.7079],["2026-07-13",6.278,0.9095,0.7079],["2026-07-14",12.622,1.8191,0.7079],["2026-07-15",6.197,0.8949,0.7079],["2026-07-16",3.927,0.5721,0.7079],["2026-07-17",4.262,0.6161,0.7079],["2026-07-18",4.138,0.6015,0.7079],["2026-07-19",4.31,0.6161,0.7079],["2026-07-20",6.493,0.9389,0.7079],["2026-07-21",4.812,0.6895,0.7079],["2026-07-22",3.055,0.4401,0.7079],["2026-07-23",7.68,1.1149,0.7079],["2026-07-24",4.223,0.6161,0.7079],["2026-07-25",3.803,0.5428,0.7079],["2026-07-26",3.1,0.4548,0.7079],["2026-07-27",3.086,0.4401,0.7079],["2026-07-28",3.222,0.4694,0.7079],["2026-07-29",5.437,0.7922,0.7079],["2026-07-30",3.829,0.5575,0.7079],["2026-07-31",5.582,0.8068,0.7079],["2026-08-01",4.524,0.6555,0.7029],["2026-08-02",11.067,1.5877,0.7029],["2026-08-03",4.888,0.6992,0.7029],["2026-08-04",3.841,0.5535,0.7029],["2026-08-05",2.053,0.2913,0.7029],["2026-08-06",1.346,0.1894,0.7029],["2026-08-07",2.022,0.2913,0.7029],["2026-08-08",2.041,0.2913,0.7029],["2026-08-09",1.358,0.1894,0.7029],["2026-08-10",2.044,0.2913,0.7029],["2026-08-11",2.192,0.3205,0.7029],["2026-08-12",3.732,0.5389,0.7029],["2026-08-13",5.732,0.8157,0.7029],["2026-08-14",4.314,0.6118,0.7029],["2026-08-15",6.444,0.9177,0.7029],["2026-08-16",7.562,1.0779,0.7029],["2026-08-17",5.089,0.7283,0.7029],["2026-08-18",5.84,0.8303,0.7029],["2026-08-19",4.44,0.6409,0.7029],["2026-08-20",6.38,0.9177,0.7029],["2026-08-21",10.422,1.5003,0.7029],["2026-08-22",4.442,0.6409,0.7029],["2026-08-23",4.787,0.6846,0.7029],["2026-08-24",9.788,1.3984,0.7029],["2026-08-25",5.689,0.8157,0.7029],["2026-08-26",4.272,0.6118,0.7029],["2026-08-27",5.936,0.8448,0.7029],["2026-08-28",7.321,1.0488,0.7029],["2026-08-29",5.248,0.7574,0.7029],["2026-08-30",8.791,1.2673,0.7029],["2026-08-31",2.395,0.3496,0.7029],["2026-09-01",6.047,0.8813,0.7089],["2026-09-02",2.521,0.3672,0.7089],["2026-09-03",2.607,0.3819,0.7089],["2026-09-04",5.647,0.8225,0.7089],["2026-09-05",6.96,0.9988,0.7089],["2026-09-06",22.189,3.2019,0.7089],["2026-09-07",6.652,0.9547,0.7089],["2026-09-08",8.608,1.2484,0.7089],["2026-09-09",6.1,0.8813,0.7089],["2026-09-10",5.554,0.8078,0.7089],["2026-09-11",5.146,0.7491,0.7089],["2026-09-12",3.551,0.5141,0.7089],["2026-09-13",5.827,0.8372,0.7089],["2026-09-14",5.792,0.8372,0.7089],["2026-09-15",10.525,1.5275,0.7089],["2026-09-16",7.11,1.0281,0.7089],["2026-09-17",5.241,0.7638,0.7089],["2026-09-18",4.923,0.705,0.7089],["2026-09-19",5.07,0.7344,0.7089],["2026-09-20",14.113,2.0416,0.7089],["2026-09-21",7.541,1.0869,0.7089],["2026-09-22",2.62,0.3819,0.7089],["2026-09-23",1.684,0.2497,0.7089],["2026-09-24",1.677,0.2497,0.7089],["2026-09-25",1.676,0.235,0.7089],["2026-09-26",1.677,0.2497,0.7089],["2026-09-27",0.989,0.1469,0.7089],["2026-09-28",8.437,1.2191,0.7089],["2026-09-29",13.75,1.9828,0.7089],["2026-09-30",5.766,0.8372,0.7089],["2026-10-01",5.433,0.7439,0.6774],["2026-10-02",4.077,0.5614,0.6774],["2026-10-03",10.324,1.4316,0.6774],["2026-10-04",6.055,0.8421,0.6774],["2026-10-05",3.868,0.5333,0.6774],["2026-10-06",16.366,2.2597,0.6774],["2026-10-07",8.751,1.2071,0.6774],["2026-10-08",13.063,1.8106,0.6774],["2026-10-09",10.762,1.4878,0.6774],["2026-10-10",12.67,1.7544,0.6774],["2026-10-11",9.375,1.2913,0.6774],["2026-10-12",7.451,1.0246,0.6774],["2026-10-13",6.998,0.9685,0.6774],["2026-10-14",3.801,0.5193,0.6774],["2026-10-15",1.548,0.2105,0.6774],["2026-10-16",1.615,0.2246,0.6774],["2026-10-17",1.625,0.2246,0.6774],["2026-10-18",1.612,0.2246,0.6774],["2026-10-19",1.597,0.2246,0.6774],["2026-10-20",1.586,0.2246,0.6774],["2026-10-21",1.566,0.2105,0.6774],["2026-10-22",1.573,0.2105,0.6774],["2026-10-23",1.56,0.2105,0.6774]],
    bordeaux: [["2023-10-24",7.472,0.0,0.0,0.0,0.0,0.4173],["2023-10-25",7.175,2.25,4.925,0.4849,0.788,0.4176],["2023-10-26",6.798,1.896,4.902,0.4122,0.788,0.4176],["2023-10-27",7.565,2.359,5.206,0.5092,0.8365,0.4176],["2023-10-28",7.761,2.482,5.279,0.5455,0.8486,0.4176],["2023-10-29",11.275,3.778,7.497,0.8244,1.2123,0.435],["2023-10-30",7.363,2.365,4.998,0.5092,0.8001,0.4176],["2023-10-31",7.057,2.41,4.647,0.5213,0.7516,0.4176],["2023-11-01",7.08,2.078,5.002,0.4487,0.8003,0.4208],["2023-11-02",5.697,2.323,3.374,0.5093,0.5457,0.4208],["2023-11-03",9.039,4.041,4.998,0.8731,0.8003,0.4208],["2023-11-04",10.048,3.034,7.014,0.6548,1.1277,0.4208],["2023-11-05",8.591,2.12,6.471,0.4608,1.0428,0.4208],["2023-11-06",9.79,5.717,4.073,1.249,0.6548,0.4208],["2023-11-07",8.301,2.851,5.45,0.6184,0.8731,0.4208],["2023-11-08",7.875,2.973,4.902,0.6427,0.7882,0.4208],["2023-11-09",7.205,1.699,5.506,0.3638,0.8852,0.4208],["2023-11-10",7.359,2.526,4.833,0.5457,0.7761,0.4208],["2023-11-11",9.287,2.678,6.609,0.582,1.0671,0.4208],["2023-11-12",7.06,2.771,4.289,0.6063,0.6912,0.4208],["2023-11-13",7.701,2.908,4.793,0.6305,0.7761,0.4208],["2023-11-14",6.194,1.854,4.34,0.4002,0.7033,0.4208],["2023-11-15",7.424,2.537,4.887,0.5457,0.7882,0.4208],["2023-11-16",6.581,2.1,4.481,0.4608,0.7276,0.4208],["2023-11-17",7.995,3.058,4.937,0.6669,0.8003,0.4208],["2023-11-18",9.198,2.527,6.671,0.5457,1.0792,0.4208],["2023-11-19",10.228,3.229,6.999,0.7033,1.1277,0.4208],["2023-11-20",7.777,1.569,6.208,0.3395,1.0065,0.4208],["2023-11-21",7.747,2.844,4.903,0.6184,0.7882,0.4208],["2023-11-22",8.127,2.312,5.815,0.4972,0.9337,0.4208],["2023-11-23",8.249,3.153,5.096,0.6912,0.8246,0.4208],["2023-11-24",12.615,5.78,6.835,1.2611,1.1035,0.4208],["2023-11-25",12.664,4.697,7.967,1.0186,1.2853,0.4208],["2023-11-26",11.001,4.906,6.095,1.0671,0.9822,0.4208],["2023-11-27",14.801,6.94,7.861,1.5036,1.2611,0.4208],["2023-11-28",17.571,9.335,8.236,2.025,1.3217,0.4208],["2023-11-29",13.882,6.632,7.25,1.443,1.1641,0.4208],["2023-11-30",14.115,6.112,8.003,1.3339,1.2853,0.4208],["2023-12-01",13.05,6.165,6.885,1.3467,1.1162,0.4207],["2023-12-02",16.602,7.507,9.095,1.6379,1.4681,0.4207],["2023-12-03",18.784,7.766,11.018,1.6864,1.7714,0.4207],["2023-12-04",14.899,5.635,9.264,1.2254,1.4923,0.4207],["2023-12-05",13.452,6.246,7.206,1.3589,1.1647,0.4207],["2023-12-06",15.077,7.483,7.594,1.6258,1.2254,0.4207],["2023-12-07",13.502,6.076,7.426,1.3225,1.2011,0.4207],["2023-12-08",13.098,6.598,6.5,1.4317,1.0434,0.4207],["2023-12-09",12.851,6.154,6.697,1.3346,1.0798,0.4207],["2023-12-10",15.013,7.235,7.778,1.5772,1.2497,0.4207],["2023-12-11",11.889,5.503,6.386,1.2011,1.0313,0.4207],["2023-12-12",12.859,5.099,7.76,1.1041,1.2497,0.4207],["2023-12-13",12.865,6.036,6.829,1.3103,1.1041,0.4207],["2023-12-14",13.806,6.192,7.614,1.3467,1.2254,0.4207],["2023-12-15",13.198,6.719,6.479,1.4559,1.0434,0.4207],["2023-12-16",8.402,4.823,3.579,1.0434,0.5824,0.4207],["2023-12-17",11.371,4.967,6.404,1.0798,1.0313,0.4207],["2023-12-18",21.551,11.519,10.032,2.5115,1.6136,0.4207],["2023-12-19",17.955,8.343,9.612,1.8199,1.553,0.4207],["2023-12-20",14.545,6.763,7.782,1.4681,1.2497,0.4207],["2023-12-21",14.558,6.581,7.977,1.4317,1.2861,0.4207],["2023-12-22",12.255,6.358,5.897,1.3831,0.9463,0.4207],["2023-12-23",9.771,3.425,6.346,0.7401,1.0191,0.4207],["2023-12-24",6.551,3.254,3.297,0.7037,0.5338,0.4207],["2023-12-25",12.13,6.395,5.735,1.3953,0.9221,0.4207],["2023-12-26",19.811,5.836,13.975,1.2739,2.2567,0.4207],["2023-12-27",14.672,7.329,7.343,1.5894,1.189,0.4207],["2023-12-28",12.926,5.998,6.928,1.3103,1.1162,0.4207],["2023-12-29",13.377,6.604,6.773,1.4317,1.0919,0.4207],["2023-12-30",13.55,5.601,7.949,1.2133,1.2861,0.4207],["2023-12-31",15.886,9.363,6.523,2.0383,1.0555,0.4207],["2024-01-01",16.622,6.528,10.094,1.4176,1.6236,0.419],["2024-01-02",14.469,6.575,7.894,1.4297,1.2722,0.419],["2024-01-03",15.236,5.668,9.568,1.2359,1.5388,0.419],["2024-01-04",12.062,5.767,6.295,1.248,1.0178,0.419],["2024-01-05",14.544,5.836,8.708,1.2722,1.4055,0.419],["2024-01-06",11.547,5.554,5.993,1.2116,0.9693,0.419],["2024-01-07",12.892,6.249,6.643,1.357,1.0662,0.419],["2024-01-08",13.935,6.735,7.2,1.4661,1.1632,0.419],["2024-01-09",16.151,8.345,7.806,1.8175,1.2601,0.419],["2024-01-10",16.052,7.521,8.531,1.6357,1.3691,0.419],["2024-01-11",22.087,14.382,7.705,3.126,1.2359,0.419],["2024-01-12",28.493,17.579,10.914,3.8167,1.7569,0.419],["2024-01-13",27.5,15.792,11.708,3.4289,1.8902,0.419],["2024-01-14",34.438,16.319,18.119,3.5501,2.92,0.419],["2024-01-15",20.19,10.672,9.518,2.3142,1.5267,0.419],["2024-01-16",19.653,11.524,8.129,2.5081,1.3086,0.419],["2024-01-17",17.111,9.67,7.441,2.0961,1.1995,0.419],["2024-01-18",18.282,9.184,9.098,1.9992,1.4661,0.419],["2024-01-19",25.333,12.515,12.818,2.7141,2.0598,0.419],["2024-01-20",24.006,13.375,10.631,2.9079,1.7084,0.419],["2024-01-21",30.647,16.228,14.419,3.5259,2.3263,0.419],["2024-01-22",24.465,11.094,13.371,2.4112,2.1567,0.419],["2024-01-23",17.793,9.283,8.51,2.0113,1.3691,0.419],["2024-01-24",12.28,5.572,6.708,1.2116,1.0784,0.419],["2024-01-25",9.556,4.107,5.449,0.8966,0.8724,0.419],["2024-01-26",14.93,7.435,7.495,1.6115,1.2116,0.419],["2024-01-27",12.87,6.313,6.557,1.3691,1.0541,0.419],["2024-01-28",18.032,7.281,10.751,1.5872,1.7326,0.419],["2024-01-29",13.455,6.167,7.288,1.3449,1.1753,0.419],["2024-01-30",11.75,5.149,6.601,1.1147,1.0662,0.419],["2024-01-31",9.767,4.898,4.869,1.0662,0.7876,0.419],["2024-02-01",11.408,5.693,5.715,1.2938,0.9434,0.4661],["2024-02-08",8.187,8.187,0.0,1.8734,0.0,0.4661],["2024-02-09",5.512,5.512,0.0,1.2534,0.0,0.4661],["2024-02-10",12.717,5.898,6.819,1.3477,1.1321,0.4661],["2024-02-11",15.704,5.772,9.932,1.3208,1.6442,0.4661],["2024-02-12",11.797,6.131,5.666,1.4016,0.9434,0.4661],["2024-02-13",13.696,6.652,7.044,1.5229,1.1725,0.4661],["2024-02-14",10.954,4.296,6.658,0.9838,1.1051,0.4661],["2024-02-15",9.811,5.262,4.549,1.1995,0.7547,0.4661],["2024-02-16",12.244,6.259,5.985,1.4286,0.9973,0.4661],["2024-02-17",12.978,6.363,6.615,1.4556,1.0917,0.4661],["2024-02-18",14.741,6.759,7.982,1.5364,1.3208,0.4661],["2024-02-19",12.751,6.14,6.611,1.4016,1.0917,0.4661],["2024-02-20",12.447,5.591,6.856,1.2804,1.1321,0.4661],["2024-02-21",12.306,5.379,6.927,1.2264,1.1456,0.4661],["2024-02-22",10.589,5.563,5.026,1.2669,0.8356,0.4661],["2024-02-23",13.979,7.366,6.613,1.6847,1.0917,0.4661],["2024-02-24",18.63,7.093,11.537,1.6173,1.9138,0.4661],["2024-02-25",13.333,6.603,6.73,1.5095,1.1186,0.4661],["2024-02-26",23.567,6.989,16.578,1.5903,2.7494,0.4661],["2024-02-27",14.379,7.315,7.064,1.6712,1.1725,0.4661],["2024-02-28",14.483,7.304,7.179,1.6712,1.186,0.4661],["2024-02-29",14.042,6.823,7.219,1.5634,1.1995,0.4661],["2024-10-02",5.245,1.886,3.359,0.4,0.5333,0.4667],["2024-10-03",5.122,1.676,3.446,0.3133,0.4767,0.477],["2024-10-04",7.279,2.801,4.478,0.5312,0.6266,0.477],["2024-10-05",6.666,2.325,4.341,0.4359,0.613,0.477],["2024-10-06",6.781,2.569,4.212,0.4904,0.5857,0.477],["2024-10-07",5.973,1.796,4.177,0.3405,0.5857,0.477],["2024-10-08",6.368,2.329,4.039,0.4359,0.5721,0.477],["2024-10-09",6.399,2.778,3.621,0.5312,0.504,0.477],["2024-10-10",5.047,1.729,3.318,0.3269,0.4631,0.477],["2024-10-11",5.242,1.869,3.373,0.3542,0.4767,0.477],["2024-10-12",7.323,2.847,4.476,0.5312,0.6266,0.477],["2024-10-13",10.177,2.767,7.41,0.5176,1.0352,0.477],["2024-10-14",7.544,3.056,4.488,0.5721,0.6266,0.477],["2024-10-15",6.612,2.948,3.664,0.5585,0.5176,0.477],["2024-10-16",8.448,3.098,5.35,0.5857,0.7492,0.477],["2024-10-17",6.04,2.783,3.257,0.5312,0.4631,0.477],["2024-10-18",5.989,2.33,3.659,0.4359,0.5176,0.477],["2024-10-19",7.29,3.312,3.978,0.6266,0.5585,0.477],["2024-10-20",7.967,2.848,5.119,0.5449,0.7219,0.477],["2024-10-21",7.66,2.207,5.453,0.4223,0.7628,0.477],["2024-10-22",6.234,2.584,3.65,0.4904,0.5176,0.477],["2024-10-23",7.429,2.772,4.657,0.5176,0.6538,0.477],["2024-10-24",6.176,2.233,3.943,0.4223,0.5585,0.477],["2024-10-25",6.589,1.882,4.707,0.3542,0.6538,0.477],["2024-10-26",9.746,2.969,6.777,0.5585,0.9535,0.477],["2024-10-27",7.388,2.57,4.818,0.4904,0.6811,0.4969],["2024-10-28",11.296,4.007,7.289,0.7628,1.0216,0.477],["2024-10-29",8.683,3.249,5.434,0.613,0.7628,0.477],["2024-10-30",9.443,4.918,4.525,0.9263,0.6402,0.477],["2024-10-31",6.164,2.346,3.818,0.4495,0.5312,0.477],["2024-11-01",6.933,2.294,4.639,0.4406,0.6608,0.5007],["2024-11-02",7.725,2.78,4.945,0.5369,0.7159,0.5007],["2024-11-03",9.718,2.737,6.981,0.5369,1.005,0.5007],["2024-11-04",9.584,3.433,6.151,0.6608,0.8811,0.5007],["2024-11-05",7.465,3.484,3.981,0.6746,0.5782,0.5007],["2024-11-06",7.297,3.346,3.951,0.6471,0.5645,0.5007],["2024-11-07",7.272,2.789,4.483,0.5369,0.6471,0.5007],["2024-11-08",7.079,2.057,5.022,0.3993,0.7159,0.5007],["2024-11-09",7.976,3.036,4.94,0.592,0.7159,0.5007],["2024-11-10",7.662,2.391,5.271,0.4681,0.7572,0.5007],["2024-11-11",11.874,5.579,6.295,1.0739,0.9086,0.5007],["2024-11-12",18.764,10.823,7.941,2.0926,1.1427,0.5007],["2024-11-13",18.666,10.173,8.493,1.9687,1.2253,0.5007],["2024-11-14",18.497,10.702,7.795,2.0789,1.1152,0.5007],["2024-11-15",25.508,14.465,11.043,2.8085,1.5832,0.5007],["2024-11-16",20.758,10.643,10.115,2.0651,1.4456,0.5007],["2024-11-17",25.419,14.949,10.47,2.8911,1.5006,0.5007],["2024-11-18",17.374,9.341,8.033,1.8035,1.1565,0.5007],["2024-11-19",17.784,10.597,7.187,2.0513,1.0325,0.5007],["2024-11-20",17.238,9.925,7.313,1.9274,1.0463,0.5007],["2024-11-21",17.443,9.105,8.338,1.7622,1.1978,0.5007],["2024-11-22",28.096,17.5,10.596,3.3868,1.5282,0.5007],["2024-11-23",24.452,16.063,8.389,3.1114,1.1978,0.5007],["2024-11-24",18.536,11.356,7.18,2.2028,1.0325,0.5007],["2024-11-25",13.963,6.75,7.213,1.3079,1.0325,0.5007],["2024-11-26",17.231,9.101,8.13,1.7622,1.1702,0.5007],["2024-11-27",20.624,10.232,10.392,1.9825,1.4869,0.5007],["2024-11-28",16.649,7.727,8.922,1.5006,1.2804,0.5007],["2024-11-29",16.903,8.785,8.118,1.7071,1.1702,0.5007],["2024-11-30",22.278,12.652,9.626,2.4506,1.3767,0.5007],["2024-12-01",20.366,11.16,9.206,2.1708,1.3274,0.5027],["2024-12-02",18.561,9.252,9.309,1.7975,1.3412,0.5027],["2024-12-03",20.595,11.597,8.998,2.2538,1.2997,0.5027],["2024-12-04",19.184,10.071,9.113,1.9634,1.3136,0.5027],["2024-12-05",21.512,12.316,9.196,2.3921,1.3274,0.5027],["2024-12-06",15.565,8.59,6.975,1.6731,1.0094,0.5027],["2024-12-07",21.4,13.207,8.193,2.5718,1.1753,0.5027],["2024-12-08",24.863,13.458,11.405,2.6133,1.6454,0.5027],["2024-12-09",28.679,18.072,10.607,3.5121,1.5348,0.5027],["2024-12-10",33.862,20.923,12.939,4.0651,1.8666,0.5027],["2024-12-11",32.51,20.427,12.083,3.9683,1.7422,0.5027],["2024-12-12",28.795,18.547,10.248,3.6088,1.4795,0.5027],["2024-12-13",27.2,18.249,8.951,3.5535,1.2859,0.5027],["2024-12-14",27.933,17.462,10.471,3.4014,1.5071,0.5027],["2024-12-15",27.752,17.914,9.838,3.4844,1.4242,0.5027],["2024-12-16",24.522,15.251,9.271,2.9728,1.3412,0.5027],["2024-12-17",31.592,20.691,10.901,4.0237,1.5763,0.5027],["2024-12-18",23.108,14.284,8.824,2.7792,1.2721,0.5027],["2024-12-19",18.384,9.474,8.91,1.839,1.2859,0.5027],["2024-12-20",30.462,16.734,13.728,3.2493,1.9773,0.5027],["2024-12-21",22.704,13.683,9.021,2.6686,1.2997,0.5027],["2024-12-22",20.851,12.307,8.544,2.3921,1.2306,0.5027],["2024-12-23",23.116,13.278,9.838,2.5856,1.4242,0.5027],["2024-12-24",25.417,15.349,10.068,2.9866,1.4518,0.5027],["2024-12-25",18.174,9.313,8.861,1.8113,1.2721,0.5027],["2024-12-26",23.29,14.277,9.013,2.7792,1.2997,0.5027],["2024-12-27",28.921,19.874,9.047,3.8716,1.2997,0.5027],["2024-12-28",31.05,21.611,9.439,4.2034,1.355,0.5027],["2024-12-29",33.444,23.302,10.142,4.5353,1.4657,0.5027],["2024-12-30",35.235,23.732,11.503,4.6182,1.6592,0.5027],["2024-12-31",42.935,27.838,15.097,5.4202,2.1708,0.5027],["2025-01-01",38.202,22.879,15.323,4.4598,2.2161,0.5049],["2025-01-02",29.699,17.624,12.075,3.4349,1.7452,0.5049],["2025-01-03",31.53,16.794,14.736,3.2687,2.133,0.5049],["2025-01-04",29.323,13.87,15.453,2.7008,2.2299,0.5049],["2025-01-05",21.601,11.583,10.018,2.2576,1.4404,0.5049],["2025-01-06",21.557,12.247,9.31,2.3823,1.3435,0.5049],["2025-01-07",23.169,13.507,9.662,2.6316,1.3989,0.5049],["2025-01-08",22.635,12.388,10.247,2.41,1.482,0.5049],["2025-01-09",18.123,10.642,7.481,2.0776,1.0803,0.5049],["2025-01-10",17.051,9.367,7.684,1.8283,1.108,0.5049],["2025-01-11",20.151,12.835,7.316,2.5069,1.0526,0.5049],["2025-01-12",33.561,19.592,13.969,3.8227,2.0222,0.5049],["2025-01-13",38.33,23.831,14.499,4.6399,2.0914,0.5049],["2025-01-14",40.019,24.638,15.381,4.8061,2.2161,0.5049],["2025-01-15",40.412,26.097,14.315,5.0831,2.0637,0.5049],["2025-01-16",36.759,21.802,14.957,4.2521,2.1607,0.5049],["2025-01-17",35.825,21.055,14.77,4.0997,2.133,0.5049],["2025-01-18",35.231,22.113,13.118,4.3075,1.8975,0.5049],["2025-01-19",39.845,25.35,14.495,4.9446,2.0914,0.5049],["2025-01-20",38.778,24.215,14.563,4.723,2.1053,0.5049],["2025-01-21",28.647,16.746,11.901,3.2687,1.7175,0.5049],["2025-01-22",29.47,14.638,14.832,2.8532,2.1468,0.5049],["2025-01-23",24.173,14.702,9.471,2.867,1.3712,0.5049],["2025-01-24",23.276,13.327,9.949,2.6039,1.4404,0.5049],["2025-01-25",24.87,14.491,10.379,2.8255,1.4958,0.5049],["2025-01-26",24.037,14.699,9.338,2.867,1.3435,0.5049],["2025-01-27",21.99,12.362,9.628,2.41,1.385,0.5049],["2025-01-28",23.338,14.297,9.041,2.7839,1.3019,0.5049],["2025-01-29",23.269,13.647,9.622,2.6593,1.385,0.5049],["2025-01-30",24.965,14.875,10.09,2.8947,1.4543,0.5049],["2025-01-31",26.29,16.321,9.969,3.1856,1.4404,0.5049],["2025-02-01",26.618,15.972,10.646,3.3631,1.6591,0.5641],["2025-02-02",29.335,16.532,12.803,3.4827,2.0029,0.5641],["2025-02-03",33.162,17.979,15.183,3.7816,2.3766,0.5641],["2025-02-04",30.522,17.437,13.085,3.662,2.0477,0.5641],["2025-02-05",31.013,18.177,12.836,3.8264,2.0029,0.5641],["2025-02-06",27.831,17.398,10.433,3.662,1.6292,0.5641],["2025-02-07",27.899,16.882,11.017,3.5574,1.7189,0.5641],["2025-02-08",33.544,18.558,14.986,3.9012,2.3317,0.5641],["2025-02-09",30.043,17.68,12.363,3.7218,1.9282,0.5641],["2025-02-10",27.776,15.978,11.798,3.3631,1.8385,0.5641],["2025-02-11",21.855,12.051,9.804,2.541,1.5246,0.5641],["2025-02-12",22.424,11.724,10.7,2.4663,1.6741,0.5641],["2025-02-13",23.867,12.45,11.417,2.6157,1.7787,0.5641],["2025-02-14",19.739,12.377,7.362,2.6008,1.1509,0.5641],["2025-02-15",21.289,12.315,8.974,2.5858,1.405,0.5641],["2025-02-16",18.484,9.225,9.259,1.9431,1.4499,0.5641],["2025-02-17",19.73,11.195,8.535,2.3616,1.3303,0.5641],["2025-02-18",20.614,11.695,8.919,2.4663,1.3901,0.5641],["2025-02-19",15.831,7.004,8.827,1.4798,1.3751,0.5641],["2025-02-20",10.712,5.414,5.298,1.1061,0.8071,0.5647],["2025-02-21",14.521,8.405,6.116,1.7189,0.9267,0.5647],["2025-02-22",19.553,10.07,9.483,2.0477,1.4349,0.5647],["2025-02-23",23.287,9.903,13.384,2.0179,2.0179,0.5647],["2025-02-24",18.546,9.056,9.49,1.8534,1.4349,0.5647],["2025-02-25",23.245,14.894,8.351,3.0343,1.2556,0.5647],["2025-02-26",23.95,13.989,9.961,2.8549,1.5097,0.5647],["2025-02-27",23.698,12.107,11.591,2.4663,1.7488,0.5647],["2025-02-28",23.663,14.149,9.514,2.8848,1.4349,0.5647],["2025-03-01",28.608,15.678,12.93,3.2003,1.9591,0.5652],["2025-03-02",25.324,15.127,10.197,3.0807,1.5403,0.5652],["2025-03-03",23.514,12.975,10.539,2.647,1.6002,0.5652],["2025-03-04",19.915,10.143,9.772,2.0638,1.4805,0.5652],["2025-03-05",17.879,8.569,9.31,1.7497,1.4058,0.5652],["2025-03-06",16.915,8.467,8.448,1.7198,1.2712,0.5652],["2025-03-07",14.927,6.165,8.762,1.2562,1.331,0.5652],["2025-03-08",11.664,5.382,6.282,1.0917,0.9571,0.5652],["2025-03-09",12.795,6.587,6.208,1.3459,0.9422,0.5652],["2025-03-10",16.98,7.901,9.079,1.6151,1.3758,0.5652],["2025-03-11",14.1,6.61,7.49,1.3459,1.1366,0.5652],["2025-03-12",16.3,8.88,7.42,1.8095,1.1216,0.5652],["2025-03-13",21.863,13.132,8.731,2.6769,1.316,0.5652],["2025-03-14",28.899,17.678,11.221,3.6041,1.6899,0.5652],["2025-03-15",32.271,17.02,15.251,3.4695,2.303,0.5652],["2025-03-16",27.19,16.038,11.152,3.2751,1.6899,0.5652],["2025-03-17",28.683,16.982,11.701,3.4695,1.7647,0.5652],["2025-03-18",21.864,12.224,9.64,2.4975,1.4506,0.5652],["2025-03-19",16.676,7.26,9.416,1.4805,1.4207,0.5652],["2025-03-20",10.212,4.684,5.528,0.9571,0.8375,0.5652],["2025-03-21",12.145,6.971,5.174,1.4207,0.7777,0.5652],["2025-03-22",17.58,6.681,10.899,1.3609,1.645,0.5652],["2025-03-23",15.043,6.519,8.524,1.331,1.2861,0.5652],["2025-03-24",18.986,8.349,10.637,1.7049,1.6151,0.5652],["2025-03-25",13.596,6.539,7.057,1.331,1.0618,0.5652],["2025-03-26",19.173,9.185,9.988,1.8694,1.5104,0.5652],["2025-03-27",12.146,6.648,5.498,1.3609,0.8375,0.5652],["2025-03-28",13.976,8.194,5.782,1.6749,0.8674,0.5652],["2025-03-29",19.523,18.166,16.593,3.7088,2.5124,0.5652],["2025-03-30",15.236,0.0,0.0,0.0,0.0,0.5416],["2025-03-31",14.644,7.288,7.356,1.4805,1.1067,0.5652],["2025-04-01",15.048,6.902,8.146,1.3821,1.2056,0.5548],["2025-04-02",13.291,7.309,5.982,1.4703,0.8822,0.5548],["2025-04-03",15.095,6.848,8.247,1.3674,1.2203,0.5548],["2025-04-04",7.998,2.715,5.283,0.544,0.7793,0.5548],["2025-04-05",4.991,2.121,2.87,0.4264,0.4264,0.5548],["2025-04-06",4.278,1.646,2.632,0.3235,0.397,0.5548],["2025-04-07",6.009,2.909,3.1,0.5881,0.4558,0.5548],["2025-04-08",9.969,5.279,4.69,1.0586,0.691,0.5548],["2025-04-09",9.238,3.922,5.316,0.7793,0.794,0.5548],["2025-04-10",5.962,2.787,3.175,0.5587,0.4705,0.5548],["2025-04-11",8.347,4.693,3.654,0.941,0.544,0.5548],["2025-04-12",8.302,3.779,4.523,0.7646,0.6763,0.5548],["2025-04-13",9.15,3.227,5.923,0.6469,0.8822,0.5548],["2025-04-14",6.821,3.029,3.792,0.6028,0.5587,0.5548],["2025-04-15",7.122,3.347,3.775,0.6763,0.5587,0.5548],["2025-04-16",7.061,2.49,4.571,0.4999,0.6763,0.5548],["2025-04-17",9.908,4.672,5.236,0.941,0.7793,0.5548],["2025-04-18",9.145,3.984,5.161,0.794,0.7646,0.5548],["2025-04-19",11.106,6.226,4.88,1.2497,0.7204,0.5548],["2025-04-20",14.039,7.303,6.736,1.4703,0.9998,0.5548],["2025-04-21",14.726,7.982,6.744,1.6026,0.9998,0.5548],["2025-04-22",15.501,7.784,7.717,1.5585,1.1468,0.5548],["2025-04-23",13.54,7.805,5.735,1.5585,0.8528,0.5548],["2025-04-24",14.965,7.643,7.322,1.5291,1.088,0.5548],["2025-04-25",13.483,7.427,6.056,1.485,0.8969,0.5548],["2025-04-26",12.641,7.327,5.314,1.4703,0.794,0.5548],["2025-04-27",9.334,2.972,6.362,0.6028,0.941,0.5548],["2025-04-28",8.776,4.206,4.57,0.8381,0.6763,0.5548],["2025-04-29",9.542,4.796,4.746,0.9557,0.7057,0.5548],["2025-04-30",9.585,3.639,5.946,0.7351,0.8822,0.5548],["2025-05-01",5.895,1.891,4.004,0.3774,0.5806,0.5479],["2025-05-02",3.612,1.447,2.165,0.2903,0.3194,0.5479],["2025-05-03",3.677,1.326,2.351,0.2613,0.3484,0.5479],["2025-05-04",3.747,1.425,2.322,0.2758,0.3339,0.5479],["2025-05-05",4.458,1.768,2.69,0.3484,0.3919,0.5479],["2025-05-06",7.234,3.281,3.953,0.6532,0.5806,0.5479],["2025-05-07",5.726,2.48,3.246,0.4936,0.479,0.5479],["2025-05-08",8.46,3.573,4.887,0.7113,0.7113,0.5479],["2025-05-09",10.02,3.456,6.564,0.6823,0.9581,0.5479],["2025-05-10",8.557,4.023,4.534,0.7984,0.6677,0.5479],["2025-05-11",7.208,2.493,4.715,0.4936,0.6968,0.5479],["2025-05-12",7.853,3.554,4.299,0.6968,0.6242,0.5479],["2025-05-13",7.036,3.452,3.584,0.6823,0.5226,0.5479],["2025-05-14",7.086,2.884,4.202,0.5661,0.6097,0.5479],["2025-05-15",7.21,2.661,4.549,0.5226,0.6677,0.5479],["2025-05-16",7.499,3.804,3.695,0.7548,0.5371,0.5479],["2025-05-17",7.851,3.711,4.14,0.7403,0.6097,0.5479],["2025-05-18",7.383,3.263,4.12,0.6532,0.6097,0.5479],["2025-05-19",7.588,2.996,4.592,0.5952,0.6677,0.5479],["2025-05-20",9.569,3.863,5.706,0.7694,0.8419,0.5479],["2025-05-21",8.684,5.162,3.522,1.0161,0.5226,0.5479],["2025-05-22",6.506,2.962,3.544,0.5806,0.5226,0.5479],["2025-05-23",6.636,2.942,3.694,0.5806,0.5371,0.5479],["2025-05-24",8.377,3.681,4.696,0.7258,0.6823,0.5479],["2025-05-25",9.274,2.265,7.009,0.45,1.0307,0.5479],["2025-05-26",7.394,2.977,4.417,0.5952,0.6532,0.5479],["2025-05-27",8.795,4.388,4.407,0.871,0.6532,0.5479],["2025-05-28",6.096,2.825,3.271,0.5661,0.479,0.5479],["2025-05-29",7.541,3.267,4.274,0.6532,0.6242,0.5479],["2025-05-30",8.432,4.291,4.141,0.8565,0.6097,0.5479],["2025-05-31",7.43,3.87,3.56,0.7694,0.5226,0.5479],["2025-06-01",6.709,3.315,3.394,0.6573,0.4966,0.5511],["2025-06-02",8.0,4.159,3.841,0.8325,0.5696,0.5511],["2025-06-03",8.936,4.143,4.793,0.8325,0.7011,0.5511],["2025-06-04",10.566,5.437,5.129,1.0808,0.7595,0.5511],["2025-06-05",8.167,2.668,5.499,0.5258,0.8179,0.5511],["2025-06-06",8.366,3.696,4.67,0.7303,0.6865,0.5511],["2025-06-07",9.399,3.878,5.521,0.7741,0.8179,0.5511],["2025-06-08",6.628,2.629,3.999,0.5258,0.5842,0.5511],["2025-06-09",7.295,3.556,3.739,0.7157,0.555,0.5511],["2025-06-10",7.715,4.464,3.251,0.891,0.482,0.5511],["2025-06-11",6.815,3.01,3.805,0.5988,0.555,0.5511],["2025-06-12",9.031,5.023,4.008,1.0078,0.5988,0.5511],["2025-06-13",8.196,4.671,3.525,0.9348,0.5258,0.5511],["2025-06-14",7.119,3.871,3.248,0.7741,0.482,0.5511],["2025-06-15",7.29,3.823,3.467,0.7595,0.5112,0.5511],["2025-06-16",8.543,4.045,4.498,0.8033,0.6573,0.5511],["2025-06-17",8.163,4.043,4.12,0.8033,0.6134,0.5511],["2025-06-18",10.086,5.768,4.318,1.1539,0.6427,0.5511],["2025-06-19",9.32,6.131,3.189,1.2269,0.4674,0.5511],["2025-06-20",9.786,6.589,3.197,1.3145,0.4674,0.5511],["2025-06-21",10.185,6.178,4.007,1.2269,0.5988,0.5511],["2025-06-22",7.79,4.16,3.63,0.8325,0.5404,0.5511],["2025-06-23",9.847,5.671,4.176,1.1247,0.6134,0.5511],["2025-06-24",11.281,7.232,4.049,1.446,0.5988,0.5511],["2025-06-25",11.306,7.014,4.292,1.4022,0.6281,0.5511],["2025-06-26",10.397,5.161,5.236,1.0224,0.7741,0.5511],["2025-06-27",9.146,4.389,4.757,0.8764,0.7011,0.5511],["2025-06-28",9.901,6.312,3.589,1.2561,0.5258,0.5511],["2025-06-29",10.104,6.086,4.018,1.2123,0.5988,0.5511],["2025-06-30",14.609,9.871,4.738,1.9718,0.7011,0.5511],["2025-07-01",17.439,12.841,4.598,2.5836,0.6791,0.5568],["2025-07-02",11.981,7.907,4.074,1.5945,0.6053,0.5568],["2025-07-03",15.652,10.427,5.225,2.0964,0.7825,0.5568],["2025-07-04",13.542,7.778,5.764,1.5649,0.8563,0.5568],["2025-07-05",13.384,7.102,6.282,1.4321,0.9449,0.5568],["2025-07-06",7.042,2.357,4.685,0.4724,0.6939,0.5568],["2025-07-07",8.885,4.78,4.105,0.9596,0.6201,0.5568],["2025-07-08",7.114,3.654,3.46,0.7086,0.502,0.5573],["2025-07-09",7.35,3.931,3.419,0.7677,0.4872,0.5573],["2025-07-10",8.086,3.31,4.776,0.6496,0.6939,0.5573],["2025-07-11",13.357,6.606,6.751,1.2844,0.9744,0.5573],["2025-07-12",13.413,8.08,5.333,1.5797,0.7677,0.5573],["2025-07-13",11.518,5.826,5.692,1.1368,0.8268,0.5573],["2025-07-14",11.67,4.744,6.926,0.9301,1.0039,0.5573],["2025-07-15",12.29,4.61,7.68,0.9006,1.1073,0.5573],["2025-07-16",11.242,6.303,4.939,1.2254,0.7086,0.5573],["2025-07-17",13.53,7.427,6.103,1.4468,0.8858,0.5573],["2025-07-18",10.954,5.707,5.247,1.1073,0.7529,0.5573],["2025-07-19",10.69,3.552,7.138,0.6939,1.0334,0.5573],["2025-07-20",7.567,2.81,4.757,0.5462,0.6939,0.5573],["2025-07-21",9.414,4.622,4.792,0.9006,0.6939,0.5573],["2025-07-22",9.836,4.274,5.562,0.8268,0.7972,0.5573],["2025-07-23",11.029,4.895,6.134,0.9596,0.8858,0.5573],["2025-07-24",10.621,6.191,4.43,1.2106,0.6348,0.5573],["2025-07-25",9.978,4.996,4.982,0.9744,0.7234,0.5573],["2025-07-26",6.745,1.938,4.807,0.3838,0.6939,0.5573],["2025-07-27",7.775,4.004,3.771,0.7825,0.5462,0.5573],["2025-07-28",7.725,2.871,4.854,0.561,0.7086,0.5573],["2025-07-29",7.787,2.244,5.543,0.4429,0.7972,0.5573],["2025-07-30",8.873,3.856,5.017,0.7529,0.7234,0.5573],["2025-07-31",10.949,3.553,7.396,0.6939,1.063,0.5573],["2025-08-01",9.366,4.11,5.256,0.7986,0.7542,0.5581],["2025-08-02",8.593,3.655,4.938,0.7099,0.7099,0.5581],["2025-08-03",10.626,4.277,6.349,0.8282,0.9169,0.5581],["2025-08-04",7.449,4.074,3.375,0.7986,0.488,0.5581],["2025-08-05",4.972,1.704,3.268,0.3253,0.4732,0.5581],["2025-08-06",3.745,1.45,2.295,0.281,0.3253,0.5581],["2025-08-07",3.907,1.458,2.449,0.281,0.3549,0.5581],["2025-08-08",3.822,1.464,2.358,0.281,0.3401,0.5581],["2025-08-09",17.859,13.109,4.75,2.5584,0.6951,0.5581],["2025-08-10",17.574,12.454,5.12,2.4253,0.7394,0.5581],["2025-08-11",27.308,20.774,6.534,4.0521,0.9465,0.5581],["2025-08-12",25.989,21.595,4.394,4.2147,0.6359,0.5581],["2025-08-13",9.55,4.382,5.168,0.8577,0.7542,0.5581],["2025-08-14",6.804,3.479,3.325,0.6803,0.488,0.5581],["2025-08-15",8.766,5.498,3.268,1.0796,0.4732,0.5581],["2025-08-16",10.219,7.009,3.21,1.3753,0.4584,0.5581],["2025-08-17",6.157,3.032,3.125,0.5915,0.4584,0.5581],["2025-08-18",5.562,2.641,2.921,0.5176,0.4289,0.5581],["2025-08-19",4.515,1.76,2.755,0.3401,0.3993,0.5581],["2025-08-20",3.779,1.47,2.309,0.281,0.3401,0.5581],["2025-08-21",3.901,1.456,2.445,0.281,0.3549,0.5581],["2025-08-22",3.903,1.429,2.474,0.281,0.3549,0.5581],["2025-08-23",3.972,1.417,2.555,0.281,0.3697,0.5581],["2025-08-24",3.797,1.413,2.384,0.281,0.3401,0.5581],["2025-08-25",4.001,1.43,2.571,0.281,0.3697,0.5581],["2025-08-26",3.851,1.463,2.388,0.281,0.3401,0.5581],["2025-08-27",4.006,1.484,2.522,0.2958,0.3697,0.5581],["2025-08-28",4.547,1.927,2.62,0.3697,0.3845,0.5581],["2025-08-29",5.965,2.848,3.117,0.562,0.4584,0.5581],["2025-08-30",6.441,3.241,3.2,0.6359,0.4584,0.5581],["2025-08-31",8.37,3.724,4.646,0.7246,0.6655,0.5581],["2025-09-01",8.196,2.906,5.29,0.5616,0.7685,0.5577],["2025-09-02",5.58,1.448,4.132,0.2808,0.5912,0.5577],["2025-09-03",3.774,1.339,2.435,0.266,0.3547,0.5577],["2025-09-04",3.729,1.335,2.394,0.266,0.3399,0.5577],["2025-09-05",3.807,1.336,2.471,0.266,0.3547,0.5577],["2025-09-06",3.705,1.328,2.377,0.266,0.3399,0.5577],["2025-09-07",3.85,1.366,2.484,0.266,0.3547,0.5577],["2025-09-08",3.713,1.36,2.353,0.266,0.3399,0.5577],["2025-09-09",3.935,1.376,2.559,0.266,0.3695,0.5577],["2025-09-10",3.722,1.34,2.382,0.266,0.3399,0.5577],["2025-09-11",3.796,1.352,2.444,0.266,0.3547,0.5577],["2025-09-12",3.72,1.319,2.401,0.2512,0.3547,0.5577],["2025-09-13",3.828,1.333,2.495,0.266,0.3547,0.5577],["2025-09-14",4.783,2.186,2.597,0.4286,0.3695,0.5577],["2025-09-15",6.388,2.732,3.656,0.5321,0.5321,0.5577],["2025-09-16",5.681,1.61,4.071,0.3104,0.5912,0.5577],["2025-09-17",4.597,1.848,2.749,0.3547,0.399,0.5577],["2025-09-18",6.924,3.18,3.744,0.6207,0.5468,0.5577],["2025-09-19",7.199,2.521,4.678,0.4877,0.6798,0.5577],["2025-09-20",7.713,3.414,4.299,0.6651,0.6207,0.5577],["2025-09-21",7.24,2.974,4.266,0.5764,0.6207,0.5577],["2025-09-22",6.832,2.19,4.642,0.4286,0.6651,0.5577],["2025-09-23",4.828,1.307,3.521,0.2512,0.5025,0.5577],["2025-09-24",3.792,1.373,2.419,0.266,0.3547,0.5577],["2025-09-25",3.722,1.269,2.453,0.2512,0.3547,0.5577],["2025-09-26",3.831,1.357,2.474,0.266,0.3547,0.5577],["2025-09-27",3.668,1.241,2.427,0.2365,0.3547,0.5577],["2025-09-28",3.78,1.349,2.431,0.266,0.3547,0.5577],["2025-09-29",3.703,1.258,2.445,0.2512,0.3547,0.5577],["2025-09-30",3.834,1.395,2.439,0.266,0.3547,0.5577],["2025-10-01",3.701,1.263,2.438,0.2527,0.3568,0.5603],["2025-10-02",8.688,4.171,4.517,0.8176,0.6541,0.5603],["2025-10-03",10.108,3.038,7.07,0.5946,1.0257,0.5603],["2025-10-04",9.243,3.822,5.421,0.7433,0.7879,0.5603],["2025-10-05",6.616,2.753,3.863,0.5352,0.5649,0.5603],["2025-10-06",7.496,2.185,5.311,0.4311,0.773,0.5603],["2025-10-07",6.929,1.447,5.482,0.2824,0.8027,0.5603],["2025-10-08",4.821,1.633,3.188,0.327,0.4608,0.5603],["2025-10-09",4.887,1.452,3.435,0.2824,0.5054,0.5603],["2025-10-10",3.584,1.278,2.306,0.2527,0.3419,0.5603],["2025-10-11",3.758,1.391,2.367,0.2676,0.3419,0.5603],["2025-10-12",3.693,1.289,2.404,0.2527,0.3568,0.5603],["2025-10-13",3.767,1.401,2.366,0.2676,0.3419,0.5603],["2025-10-14",3.705,1.298,2.407,0.2527,0.3568,0.5603],["2025-10-15",4.468,1.533,2.935,0.2973,0.4311,0.5603],["2025-10-16",8.249,4.064,4.185,0.8027,0.6095,0.5603],["2025-10-17",6.971,3.343,3.628,0.6541,0.5352,0.5603],["2025-10-18",7.528,2.985,4.543,0.5798,0.6541,0.5603],["2025-10-19",10.444,3.598,6.846,0.6987,0.996,0.5603],["2025-10-20",7.103,3.561,3.542,0.6987,0.5203,0.5603],["2025-10-21",7.237,3.379,3.858,0.669,0.5649,0.5603],["2025-10-22",6.98,3.329,3.651,0.6541,0.5352,0.5603],["2025-10-23",8.021,3.474,4.547,0.6838,0.669,0.5603],["2025-10-24",9.54,3.317,6.223,0.6541,0.9068,0.5603],["2025-10-25",8.918,4.26,4.658,0.8325,0.6838,0.5603],["2025-10-26",9.597,3.627,5.97,0.7135,0.8622,0.5837],["2025-10-27",9.142,5.028,4.114,0.9811,0.5946,0.5603],["2025-10-28",6.32,2.884,3.436,0.5649,0.5054,0.5603],["2025-10-29",7.589,4.075,3.514,0.8027,0.5054,0.5603],["2025-10-30",6.951,3.167,3.784,0.6244,0.55,0.5603],["2025-10-31",8.601,3.805,4.796,0.7433,0.6987,0.5603],["2025-11-01",9.595,3.853,5.742,0.7729,0.8487,0.5721],["2025-11-02",6.37,3.147,3.223,0.6365,0.4849,0.5721],["2025-11-03",7.567,2.468,5.099,0.5001,0.7577,0.5721],["2025-11-04",5.973,1.227,4.746,0.2425,0.6971,0.5721],["2025-11-05",3.645,1.221,2.424,0.2425,0.3637,0.5759],["2025-11-06",3.837,1.252,2.585,0.2122,0.3182,0.5759],["2025-11-07",3.666,1.231,2.435,0.197,0.3031,0.5721],["2025-11-08",3.817,1.403,2.414,0.2273,0.2879,0.5721],["2025-11-09",3.65,1.207,2.443,0.197,0.3031,0.5721],["2025-11-10",3.79,1.242,2.548,0.2122,0.3182,0.5721],["2025-11-11",3.617,1.19,2.427,0.197,0.3031,0.5721],["2025-11-12",4.417,1.205,3.212,0.197,0.394,0.5721],["2025-11-13",4.962,1.518,3.444,0.2576,0.4243,0.5721],["2025-11-14",5.806,2.141,3.665,0.3486,0.4546,0.5721],["2025-11-15",7.614,3.46,4.154,0.5759,0.5153,0.5721],["2025-11-16",6.185,2.601,3.584,0.4243,0.4395,0.5721],["2025-11-17",6.036,2.581,3.455,0.4243,0.4243,0.5721],["2025-11-18",4.681,1.194,3.487,0.197,0.4243,0.5721],["2025-11-19",3.756,1.174,2.582,0.197,0.3182,0.5721],["2025-11-20",3.557,1.127,2.43,0.1819,0.3031,0.5721],["2025-11-21",3.79,1.266,2.524,0.2122,0.3031,0.5721],["2025-11-22",3.565,1.101,2.464,0.1819,0.3031,0.5721],["2025-11-23",3.603,1.096,2.507,0.1819,0.3031,0.5721],["2025-11-24",3.745,1.282,2.463,0.2122,0.3031,0.5721],["2025-11-25",8.486,3.703,4.783,0.6062,0.591,0.5721],["2025-11-26",31.295,19.353,11.942,3.1976,1.4548,0.5721],["2025-11-27",10.903,4.527,6.376,0.7426,0.7729,0.5721],["2025-11-28",10.201,4.112,6.089,0.682,0.7426,0.5721],["2025-11-29",14.233,7.141,7.092,1.1821,0.8638,0.5721],["2025-11-30",16.939,8.642,8.297,1.4245,1.0154,0.5721],["2025-12-01",10.062,3.054,7.008,0.5091,0.8794,0.5823],["2025-12-02",7.434,1.118,6.316,0.1851,0.7868,0.5823],["2025-12-03",3.539,1.097,2.442,0.1851,0.3086,0.5823],["2025-12-04",3.711,1.295,2.416,0.216,0.2931,0.5823],["2025-12-05",3.576,1.103,2.473,0.1851,0.3086,0.5823],["2025-12-06",3.556,1.105,2.451,0.1851,0.3086,0.5823],["2025-12-07",3.743,1.309,2.434,0.216,0.3086,0.5823],["2025-12-08",3.59,1.142,2.448,0.1851,0.3086,0.5823],["2025-12-09",3.768,1.328,2.44,0.216,0.3086,0.5823],["2025-12-10",6.0,3.123,2.877,0.5246,0.3548,0.5823],["2025-12-11",13.134,6.307,6.827,1.0645,0.8485,0.5823],["2025-12-12",13.337,6.481,6.856,1.0954,0.8485,0.5823],["2025-12-13",12.838,6.913,5.925,1.1571,0.7405,0.5823],["2025-12-14",11.407,6.119,5.288,1.0337,0.6634,0.5823],["2025-12-15",13.774,6.594,7.18,1.1108,0.8948,0.5823],["2025-12-16",14.11,5.465,8.645,0.9103,1.08,0.5823],["2025-12-17",13.305,7.27,6.035,1.2188,0.756,0.5823],["2025-12-18",15.917,7.138,8.779,1.2034,1.0954,0.5823],["2025-12-19",14.568,7.507,7.061,1.2651,0.8794,0.5823],["2025-12-20",17.375,8.842,8.533,1.4811,1.0645,0.5823],["2025-12-21",23.085,11.375,11.71,1.9131,1.4502,0.5823],["2025-12-22",21.773,10.795,10.978,1.8051,1.3731,0.5823],["2025-12-23",21.05,9.941,11.109,1.6662,1.3885,0.5823],["2025-12-24",28.924,15.601,13.323,2.6228,1.6662,0.5823],["2025-12-25",29.663,14.266,15.397,2.3913,1.9131,0.5823],["2025-12-26",23.404,13.665,9.739,2.2988,1.2188,0.5823],["2025-12-27",17.627,9.783,7.844,1.6354,0.972,0.5823],["2025-12-28",20.923,10.118,10.805,1.6971,1.3422,0.5823],["2025-12-29",21.318,8.018,13.3,1.3422,1.6508,0.5823],["2025-12-30",9.496,1.128,8.368,0.1851,1.0491,0.5823],["2025-12-31",3.564,1.102,2.462,0.1851,0.3086,0.5823],["2026-01-01",3.698,1.247,2.451,0.2143,0.3062,0.5777],["2026-01-02",3.537,1.051,2.486,0.1684,0.3062,0.5777],["2026-01-03",3.56,1.038,2.522,0.1684,0.3062,0.5777],["2026-01-04",3.709,1.211,2.498,0.199,0.3062,0.5777],["2026-01-05",3.524,1.022,2.502,0.1684,0.3062,0.5777],["2026-01-06",3.487,1.03,2.457,0.1684,0.3062,0.5777],["2026-01-07",10.268,5.031,5.237,0.8419,0.6429,0.5777],["2026-01-08",26.981,13.051,13.93,2.1737,1.7145,0.5777],["2026-01-09",19.597,10.828,8.769,1.8063,1.0868,0.5777],["2026-01-10",19.323,9.783,9.54,1.6226,1.1787,0.5777],["2026-01-11",23.764,14.764,9.0,2.4645,1.1175,0.5777],["2026-01-12",16.965,8.812,8.153,1.4695,1.0103,0.5777],["2026-01-13",4.774,0.756,4.018,0.1225,0.4898,0.5777],["2026-01-14",4.605,1.564,3.041,0.2602,0.3827,0.5777],["2026-01-15",3.729,1.318,2.411,0.2143,0.2908,0.5777],["2026-01-16",3.569,1.152,2.417,0.199,0.3062,0.5777],["2026-01-17",3.577,1.14,2.437,0.1837,0.3062,0.5777],["2026-01-18",3.765,1.173,2.592,0.199,0.3215,0.5777],["2026-01-19",3.546,1.128,2.418,0.1837,0.3062,0.5777],["2026-01-20",7.276,3.427,3.849,0.5664,0.4745,0.5777],["2026-01-21",24.563,16.075,8.488,2.6788,1.0409,0.5777],["2026-01-22",18.468,10.767,7.701,1.791,0.9491,0.5777],["2026-01-23",16.092,9.319,6.773,1.5461,0.8419,0.5777],["2026-01-24",20.412,12.46,7.952,2.0818,0.9797,0.5777],["2026-01-25",21.87,11.5,10.37,1.9135,1.2858,0.5777],["2026-01-26",14.753,6.337,8.416,1.0562,1.0409,0.5777],["2026-01-27",5.674,1.18,4.494,0.199,0.5511,0.5777],["2026-01-28",3.57,1.147,2.423,0.1837,0.3062,0.5777],["2026-01-29",3.732,1.306,2.426,0.2143,0.3062,0.5777],["2026-01-30",3.562,1.147,2.415,0.1837,0.2908,0.5777],["2026-01-31",3.6,1.141,2.459,0.1837,0.3062,0.5777],["2026-02-01",3.745,1.307,2.438,0.2149,0.2916,0.5953],["2026-02-02",3.575,1.154,2.421,0.1842,0.2763,0.5953],["2026-02-03",3.741,1.224,2.517,0.1995,0.2916,0.5953],["2026-02-04",10.561,6.538,4.023,1.0745,0.4758,0.5953],["2026-02-05",18.345,10.599,7.746,1.7498,0.9056,0.5953],["2026-02-06",16.306,7.751,8.555,1.274,0.9977,0.5953],["2026-02-07",15.773,7.574,8.199,1.2433,0.967,0.5953],["2026-02-08",14.343,7.643,6.7,1.2586,0.7828,0.5953],["2026-02-09",12.415,6.025,6.39,0.9977,0.7521,0.5953],["2026-02-10",16.301,9.437,6.864,1.5503,0.7982,0.5953],["2026-02-11",13.011,4.891,8.12,0.7982,0.9517,0.5953],["2026-02-12",14.748,8.33,6.418,1.3661,0.7521,0.5953],["2026-02-13",11.773,5.246,6.527,0.8596,0.7675,0.5953],["2026-02-14",16.734,9.744,6.99,1.5963,0.8135,0.5953],["2026-02-15",21.34,10.478,10.862,1.7191,1.274,0.5953],["2026-02-16",12.726,6.651,6.075,1.0898,0.7061,0.5953],["2026-02-17",14.42,7.801,6.619,1.2893,0.7828,0.5953],["2026-02-18",12.684,6.458,6.226,1.0591,0.7368,0.5953],["2026-02-19",16.893,10.393,6.5,1.7038,0.7675,0.5953],["2026-02-20",15.701,7.713,7.988,1.274,0.9363,0.5953],["2026-02-21",13.524,6.586,6.938,1.0898,0.8135,0.5953],["2026-02-22",14.937,8.089,6.848,1.3354,0.7982,0.5953],["2026-02-23",13.465,7.09,6.375,1.1666,0.7521,0.5953],["2026-02-24",6.604,1.145,5.459,0.1842,0.6447,0.5953],["2026-02-25",3.083,0.88,2.203,0.1381,0.2609,0.5953],["2026-02-26",3.117,0.866,2.251,0.1381,0.2609,0.5953],["2026-02-27",3.315,1.03,2.285,0.1688,0.2609,0.5953],["2026-02-28",3.153,0.866,2.287,0.1381,0.2609,0.5953],["2026-03-01",3.287,1.009,2.278,0.1682,0.2599,0.5941],["2026-03-02",3.124,0.851,2.273,0.1376,0.2599,0.5941],["2026-03-03",3.123,0.854,2.269,0.1376,0.2599,0.5941],["2026-03-04",7.765,3.273,4.492,0.5351,0.5198,0.5941],["2026-03-05",14.997,7.611,7.386,1.2536,0.8561,0.5941],["2026-03-06",9.613,3.808,5.805,0.6268,0.6727,0.5941],["2026-03-07",11.527,6.773,4.754,1.116,0.5504,0.5941],["2026-03-08",12.053,6.704,5.349,1.1008,0.6268,0.5941],["2026-03-09",10.275,5.923,4.352,0.9632,0.5045,0.5941],["2026-03-10",10.397,5.989,4.408,0.9785,0.5198,0.5941],["2026-03-11",16.864,12.076,4.788,1.9722,0.5657,0.5941],["2026-03-12",17.027,12.588,4.439,2.0639,0.5198,0.5941],["2026-03-13",10.252,5.751,4.501,0.9479,0.5198,0.5941],["2026-03-14",18.102,10.435,7.667,1.7123,0.902,0.5941],["2026-03-15",19.627,12.017,7.61,1.9722,0.8867,0.5941],["2026-03-16",20.475,14.576,5.899,2.385,0.688,0.5941],["2026-03-17",12.676,5.485,7.191,0.902,0.8409,0.5941],["2026-03-18",11.383,5.564,5.819,0.9173,0.6727,0.5941],["2026-03-19",13.656,7.881,5.775,1.2842,0.6727,0.5941],["2026-03-20",4.748,1.369,3.379,0.2293,0.3975,0.5941],["2026-03-21",3.617,1.22,2.397,0.1987,0.2752,0.5941],["2026-03-22",3.774,1.34,2.434,0.214,0.2905,0.5941],["2026-03-23",3.636,1.201,2.435,0.1987,0.2905,0.5941],["2026-03-24",3.65,1.245,2.405,0.1987,0.2752,0.5941],["2026-03-25",3.901,1.261,2.64,0.214,0.3058,0.5941],["2026-03-26",8.0,4.211,3.789,0.688,0.4434,0.5941],["2026-03-27",22.802,13.233,9.569,2.1709,1.116,0.5941],["2026-03-28",18.946,21.007,16.096,3.4399,1.8805,0.5941],["2026-03-29",18.157,0.0,0.0,0.0,0.0,0.5693],["2026-03-30",15.135,7.565,7.57,1.2384,0.8867,0.5941],["2026-03-31",18.086,9.761,8.325,1.6053,0.9785,0.5941],["2026-04-01",17.169,10.878,6.291,1.7786,0.7297,0.5898],["2026-04-02",13.351,5.858,7.493,0.9577,0.8665,0.5898],["2026-04-03",3.659,0.92,2.739,0.152,0.3192,0.5898],["2026-04-04",3.321,0.95,2.371,0.152,0.2736,0.5898],["2026-04-05",3.189,0.903,2.286,0.152,0.2584,0.5898],["2026-04-06",3.311,1.07,2.241,0.1672,0.2584,0.5898],["2026-04-07",3.198,0.954,2.244,0.152,0.2584,0.5898],["2026-04-08",3.266,1.055,2.211,0.1672,0.2584,0.5898],["2026-04-09",4.428,1.962,2.466,0.3192,0.2888,0.5898],["2026-04-10",7.418,3.159,4.259,0.5169,0.5017,0.5898],["2026-04-11",8.864,4.142,4.722,0.6689,0.5473,0.5898],["2026-04-12",9.707,3.966,5.741,0.6537,0.6689,0.5898],["2026-04-13",6.011,2.733,3.278,0.4409,0.38,0.5898],["2026-04-14",8.309,4.059,4.25,0.6689,0.4865,0.5898],["2026-04-15",8.595,3.938,4.657,0.6385,0.5473,0.5898],["2026-04-16",14.841,3.84,11.001,0.6233,1.2769,0.5898],["2026-04-17",9.199,3.644,5.555,0.5929,0.6385,0.5898],["2026-04-18",13.003,5.388,7.615,0.8817,0.8817,0.5898],["2026-04-19",13.632,4.095,9.537,0.6689,1.1097,0.5898],["2026-04-20",10.303,3.545,6.758,0.5777,0.7905,0.5898],["2026-04-21",9.998,4.105,5.893,0.6689,0.6841,0.5898],["2026-04-22",8.344,3.255,5.089,0.5321,0.5929,0.5898],["2026-04-23",11.165,5.687,5.478,0.9273,0.6385,0.5898],["2026-04-24",10.861,3.394,7.467,0.5473,0.8665,0.5898],["2026-04-25",9.165,4.278,4.887,0.6993,0.5625,0.5898],["2026-04-26",9.908,4.796,5.112,0.7753,0.5929,0.5898],["2026-04-27",11.586,4.229,7.357,0.6841,0.8513,0.5898],["2026-04-28",8.496,2.849,5.647,0.4713,0.6537,0.5898],["2026-04-29",7.246,2.938,4.308,0.4713,0.5017,0.5898],["2026-04-30",5.165,1.832,3.333,0.304,0.38,0.5898],["2026-05-01",8.214,4.451,3.763,0.7177,0.4336,0.5801],["2026-05-02",6.42,2.887,3.533,0.4635,0.4037,0.5801],["2026-05-03",7.029,2.722,4.307,0.4336,0.4934,0.5801],["2026-05-04",5.415,2.093,3.322,0.3289,0.3738,0.5801],["2026-05-05",4.341,0.999,3.342,0.1645,0.3887,0.5801],["2026-05-06",3.309,0.942,2.367,0.1495,0.2691,0.5831],["2026-05-07",3.17,0.927,2.243,0.1495,0.2542,0.5801],["2026-05-08",3.295,0.942,2.353,0.1495,0.2691,0.5801],["2026-05-09",3.211,0.956,2.255,0.1495,0.2542,0.5801],["2026-05-10",3.331,0.97,2.361,0.1495,0.2691,0.5801],["2026-05-11",3.198,0.972,2.226,0.1495,0.2542,0.5801],["2026-05-12",3.425,0.983,2.442,0.1645,0.2841,0.5801],["2026-05-13",1.826,0.284,1.542,0.0449,0.1794,0.5801],["2026-05-14",5.914,2.096,3.818,0.3289,0.4336,0.5801],["2026-05-15",8.934,3.337,5.597,0.5383,0.6429,0.5801],["2026-05-16",10.13,5.005,5.125,0.8074,0.5831,0.5801],["2026-05-17",9.518,3.043,6.475,0.4934,0.7326,0.5801],["2026-05-18",12.044,5.626,6.418,0.8971,0.7326,0.5801],["2026-05-19",13.409,4.768,8.641,0.7625,0.9868,0.5801],["2026-05-20",10.406,3.127,7.279,0.5083,0.8373,0.5801],["2026-05-21",7.606,1.462,6.144,0.2392,0.7027,0.5801],["2026-05-22",3.277,1.074,2.203,0.1794,0.2542,0.5801],["2026-05-23",3.433,1.24,2.193,0.1944,0.2542,0.5801],["2026-05-24",3.358,1.144,2.214,0.1794,0.2542,0.5801],["2026-05-25",3.435,1.286,2.149,0.2093,0.2392,0.5801],["2026-05-26",3.429,1.208,2.221,0.1944,0.2542,0.5801],["2026-05-27",3.492,1.354,2.138,0.2243,0.2392,0.5801],["2026-05-28",10.35,6.964,3.386,1.1214,0.3887,0.5801],["2026-05-29",8.225,4.352,3.873,0.7027,0.4485,0.5801],["2026-05-30",7.103,3.412,3.691,0.5532,0.4186,0.5801],["2026-05-31",8.603,4.772,3.831,0.7625,0.4336,0.5801],["2026-06-01",7.345,2.415,4.93,0.3907,0.571,0.583],["2026-06-02",3.522,1.125,2.397,0.1803,0.2705,0.583],["2026-06-03",3.336,1.206,2.13,0.1953,0.2404,0.583],["2026-06-04",3.254,1.083,2.171,0.1803,0.2554,0.583],["2026-06-05",3.371,1.159,2.212,0.1803,0.2554,0.583],["2026-06-06",3.233,1.029,2.204,0.1653,0.2554,0.583],["2026-06-07",3.371,1.132,2.239,0.1803,0.2554,0.583],["2026-06-08",3.215,1.039,2.176,0.1653,0.2554,0.583],["2026-06-09",3.666,1.306,2.36,0.2104,0.2705,0.583],["2026-06-10",7.638,4.008,3.63,0.6461,0.4207,0.583],["2026-06-11",8.918,4.739,4.179,0.7663,0.4808,0.583],["2026-06-12",7.877,3.421,4.456,0.556,0.5109,0.583],["2026-06-13",5.588,2.068,3.52,0.3306,0.4057,0.583],["2026-06-14",10.569,5.513,5.056,0.8865,0.586,0.583],["2026-06-15",5.985,2.567,3.418,0.4207,0.3907,0.583],["2026-06-16",13.336,8.48,4.856,1.3673,0.556,0.583],["2026-06-17",18.982,14.577,4.405,2.344,0.5109,0.583],["2026-06-18",20.246,14.972,5.274,2.4041,0.601,0.583],["2026-06-19",7.004,2.333,4.671,0.3756,0.5409,0.583],["2026-06-20",3.295,1.222,2.073,0.1953,0.2404,0.583],["2026-06-21",3.523,1.265,2.258,0.2104,0.2554,0.583],["2026-06-22",3.558,1.418,2.14,0.2254,0.2404,0.583],["2026-06-23",3.463,1.316,2.147,0.2104,0.2404,0.583],["2026-06-24",9.812,5.779,4.033,0.9316,0.4658,0.583],["2026-06-25",17.91,10.218,7.692,1.6528,0.8865,0.583],["2026-06-26",4.351,2.197,2.154,0.3606,0.2404,0.583],["2026-06-27",16.682,12.048,4.634,1.9383,0.5259,0.583],["2026-06-28",16.106,9.539,6.567,1.5326,0.7513,0.583],["2026-06-29",7.871,3.274,4.597,0.5259,0.5259,0.583],["2026-06-30",3.36,1.203,2.157,0.1953,0.2404,0.583],["2026-07-01",3.467,1.283,2.184,0.2135,0.2592,0.5918],["2026-07-02",3.395,1.234,2.161,0.1982,0.2592,0.5918],["2026-07-03",3.355,1.143,2.212,0.183,0.2592,0.5918],["2026-07-04",8.385,4.576,3.809,0.7472,0.4422,0.5918],["2026-07-05",18.119,13.287,4.832,2.1655,0.5642,0.5918],["2026-07-06",18.232,13.177,5.055,2.1502,0.5947,0.5918],["2026-07-07",17.461,12.35,5.111,2.013,0.5947,0.5918],["2026-07-08",18.397,13.31,5.087,2.1807,0.5947,0.5918],["2026-07-09",20.547,13.044,7.503,2.135,0.8692,0.5918],["2026-07-10",21.077,13.449,7.628,2.196,0.8845,0.5918],["2026-07-11",18.935,11.446,7.489,1.8757,0.8692,0.5918],["2026-07-12",22.149,13.591,8.558,2.2265,0.9912,0.5918],["2026-07-13",20.428,12.189,8.239,1.9977,0.9607,0.5918],["2026-07-14",24.916,14.726,10.19,2.4095,1.1895,0.5918],["2026-07-15",21.812,12.83,8.982,2.1045,1.0522,0.5918],["2026-07-16",21.402,13.457,7.945,2.196,0.9302,0.5918],["2026-07-17",6.383,2.057,4.326,0.3355,0.5032,0.5918],["2026-07-18",4.046,1.694,2.352,0.2745,0.2745,0.5918],["2026-07-19",3.97,1.597,2.373,0.2592,0.2745,0.5918],["2026-07-20",4.142,1.714,2.428,0.2745,0.2897,0.5918],["2026-07-21",3.96,1.586,2.374,0.2592,0.2745,0.5918],["2026-07-22",4.339,1.831,2.508,0.305,0.2897,0.5918],["2026-07-23",8.753,5.2,3.553,0.854,0.4117,0.5918],["2026-07-24",6.271,2.742,3.529,0.4422,0.4117,0.5918],["2026-07-25",8.009,3.154,4.855,0.5185,0.5642,0.5918],["2026-07-26",10.095,4.845,5.25,0.793,0.61,0.5918],["2026-07-27",8.159,3.472,4.687,0.5642,0.549,0.5918],["2026-07-28",11.669,6.345,5.324,1.037,0.6252,0.5918],["2026-07-29",14.355,8.085,6.27,1.3267,0.732,0.5918],["2026-07-30",12.101,6.603,5.498,1.0827,0.6405,0.5918],["2026-07-31",12.797,7.256,5.541,1.1895,0.6405,0.5918],["2026-08-01",13.061,6.742,6.319,1.1082,0.7388,0.5973],["2026-08-02",12.085,6.209,5.876,1.0312,0.6926,0.5973],["2026-08-03",12.745,6.305,6.44,1.0466,0.7542,0.5973],["2026-08-04",13.606,7.508,6.098,1.2313,0.7234,0.5973],["2026-08-05",12.202,6.519,5.683,1.0774,0.6618,0.5973],["2026-08-06",8.889,4.033,4.856,0.6618,0.5695,0.5973],["2026-08-07",12.925,8.474,4.451,1.4006,0.5233,0.5973],["2026-08-08",14.815,9.385,5.43,1.5546,0.6311,0.5973],["2026-08-09",18.273,9.659,8.614,1.6007,1.0158,0.5973],["2026-08-10",17.408,11.92,5.488,1.9701,0.6464,0.5973],["2026-08-11",22.316,13.879,8.437,2.2934,0.9851,0.5973],["2026-08-12",31.142,18.461,12.681,3.0475,1.493,0.5973],["2026-08-13",20.354,10.712,9.642,1.77,1.139,0.5973],["2026-08-14",25.978,16.807,9.171,2.7705,1.0774,0.5973],["2026-08-15",25.565,15.815,9.75,2.6166,1.139,0.5973],["2026-08-16",26.989,17.962,9.027,2.9706,1.062,0.5973],["2026-08-17",22.68,14.383,8.297,2.3703,0.9697,0.5973],["2026-08-18",13.71,6.655,7.055,1.0928,0.8311,0.5973],["2026-08-19",15.878,7.37,8.508,1.2159,1.0005,0.5973],["2026-08-20",13.208,5.383,7.825,0.8927,0.9235,0.5973],["2026-08-21",11.663,4.337,7.326,0.708,0.8619,0.5973],["2026-08-22",13.155,5.378,7.777,0.8927,0.9081,0.5973],["2026-08-23",22.047,15.147,6.9,2.4934,0.8158,0.5973],["2026-08-24",13.351,7.281,6.07,1.2005,0.708,0.5973],["2026-08-25",18.105,10.551,7.554,1.7393,0.8927,0.5973],["2026-08-26",15.821,7.609,8.212,1.2621,0.9697,0.5973],["2026-08-27",19.863,10.685,9.178,1.77,1.0774,0.5973],["2026-08-28",13.021,3.169,9.852,0.5233,1.1544,0.5973],["2026-08-29",6.6,2.314,4.286,0.3848,0.5079,0.5973],["2026-08-30",5.603,1.856,3.747,0.3078,0.4464,0.5973],["2026-08-31",9.574,4.352,5.222,0.7234,0.6157,0.5973],["2026-09-01",6.53,2.592,3.938,0.4156,0.4452,0.5758],["2026-09-02",7.246,4.034,3.212,0.6382,0.371,0.5758],["2026-09-03",6.664,3.005,3.659,0.4749,0.4156,0.5758],["2026-09-04",5.562,2.396,3.166,0.3859,0.3562,0.5758],["2026-09-05",7.008,3.779,3.229,0.6085,0.371,0.5758],["2026-09-06",8.571,5.351,3.22,0.846,0.371,0.5758],["2026-09-07",5.431,2.206,3.225,0.3562,0.371,0.5758],["2026-09-08",4.894,1.855,3.039,0.2968,0.3413,0.5758],["2026-09-09",3.476,1.101,2.375,0.1781,0.2671,0.5758],["2026-09-10",3.409,1.074,2.335,0.1781,0.2671,0.5758],["2026-09-11",3.3,1.073,2.227,0.1781,0.2523,0.5758],["2026-09-12",3.391,1.078,2.313,0.1781,0.2671,0.5758],["2026-09-13",1.707,0.402,1.305,0.0594,0.1484,0.5758],["2026-09-14",4.973,1.789,3.184,0.282,0.3562,0.5758],["2026-09-15",3.332,1.101,2.231,0.1781,0.2523,0.5758],["2026-09-16",3.483,1.164,2.319,0.1781,0.2671,0.5758],["2026-09-17",3.306,1.094,2.212,0.1781,0.2523,0.5758],["2026-09-18",3.436,1.169,2.267,0.1929,0.2523,0.5758],["2026-09-19",3.262,1.047,2.215,0.1633,0.2523,0.5758],["2026-09-20",3.724,1.294,2.43,0.2078,0.282,0.5758],["2026-09-21",7.682,4.259,3.423,0.6827,0.3859,0.5758],["2026-09-22",6.047,2.803,3.244,0.4452,0.371,0.5758],["2026-09-23",7.738,2.859,4.879,0.4601,0.5491,0.5758],["2026-09-24",6.755,3.365,3.39,0.5343,0.3859,0.5758],["2026-09-25",7.32,3.921,3.399,0.6233,0.3859,0.5758],["2026-09-26",7.464,3.875,3.589,0.6233,0.4007,0.5758],["2026-09-27",9.57,4.832,4.738,0.7717,0.5343,0.5758],["2026-09-28",6.898,2.846,4.052,0.4601,0.4601,0.5758],["2026-09-29",5.992,2.317,3.675,0.371,0.4156,0.5758],["2026-09-30",6.068,2.64,3.428,0.4156,0.3859,0.5758],["2026-10-01",7.294,3.426,3.868,0.544,0.4411,0.5702],["2026-10-02",6.542,3.304,3.238,0.5146,0.3675,0.5702],["2026-10-03",6.797,3.447,3.35,0.544,0.3822,0.5702],["2026-10-04",7.926,4.25,3.676,0.6763,0.4117,0.5702],["2026-10-05",5.904,2.51,3.394,0.3969,0.3822,0.5702],["2026-10-06",4.234,1.295,2.939,0.2058,0.3234,0.5702],["2026-10-07",3.271,1.082,2.189,0.1764,0.2499,0.5702],["2026-10-08",3.417,1.156,2.261,0.1764,0.2499,0.5702],["2026-10-09",3.248,1.027,2.221,0.1617,0.2499,0.5702],["2026-10-10",3.386,1.093,2.293,0.1764,0.2646,0.5702],["2026-10-11",3.206,0.943,2.263,0.147,0.2499,0.5702],["2026-10-12",3.345,1.07,2.275,0.1617,0.2499,0.5702],["2026-10-13",1.38,0.022,1.358,0.0,0.147,0.5702],["2026-10-14",6.017,2.534,3.483,0.3969,0.3969,0.5702],["2026-10-15",6.315,2.637,3.678,0.4117,0.4117,0.5702],["2026-10-16",7.379,3.794,3.585,0.6028,0.3969,0.5702],["2026-10-17",8.825,4.749,4.076,0.7498,0.4558,0.5702],["2026-10-18",7.726,3.172,4.554,0.4999,0.5146,0.5702],["2026-10-19",9.763,3.942,5.821,0.6175,0.6469,0.5702],["2026-10-20",9.15,4.215,4.935,0.6616,0.5587,0.5702],["2026-10-21",7.606,2.933,4.673,0.4558,0.5293,0.5702],["2026-10-22",8.67,3.686,4.984,0.5881,0.5587,0.5702],["2026-10-23",10.002,5.757,4.245,0.9115,0.4705,0.5702]]
  };
}
