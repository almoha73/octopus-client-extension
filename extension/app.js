(function () {
  const WEBAPP_URL =
    'https://script.google.com/macros/s/AKfycbyXUPxpUlzVcXnb_c2nfffleF-yaRulmOPCkysjVOuol8JmBOaFdA4HZdYEuXgso9IH/exec';

  const MONTHS_FR = [
    'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
    'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'
  ];
  const MONTHS_SHORT_FR = [
    'Janv.', 'Févr.', 'Mars', 'Avr.', 'Mai', 'Juin',
    'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.'
  ];
  const DAYS_SHORT_FR = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  const DAYS_FULL_FR = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

  // Seuil standard Octopus France où l'option HP/HC devient plus avantageuse que Base (~33% d'HC)
  const HPHC_BREAKEVEN_RATIO = 0.33;

  const state = {
    prop: 'lapleau', // 'lapleau' | 'bordeaux' | 'both'
    mode: 'day',     // 'day' | 'week' | 'month'
    unit: 'eur',     // 'eur' | 'kwh'
    selectedPeriod: null,
    raw: {
      lapleau: [],
      bordeaux: []
    }
  };

  let dayRecords = [];
  let bordeauxAllRecords = [];

  function fmtEur(n, decimals = 2) {
    return Number(n || 0).toLocaleString('fr-FR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }) + ' €';
  }

  function fmtKwh(n, decimals = 2) {
    return Number(n || 0).toLocaleString('fr-FR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }) + ' kWh';
  }

  function fmtPct(n, decimals = 1) {
    return Number(n || 0).toLocaleString('fr-FR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }) + ' %';
  }

  function isoToFr(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }

  function isoToShortFr(iso) {
    if (!iso) return '';
    const [, m, d] = iso.split('-');
    return `${d}/${m}`;
  }

  function formatYearMonthFr(ym) {
    const [y, m] = ym.split('-');
    return `${MONTHS_FR[Number(m) - 1]} ${y}`;
  }

  function formatYearMonthShortFr(ym) {
    const [y, m] = ym.split('-');
    return `${MONTHS_SHORT_FR[Number(m) - 1]} ${y.slice(2)}`;
  }

  function getMondayBasedWeekday(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const jsDay = dt.getUTCDay();
    return (jsDay + 6) % 7;
  }

  function getWeekMondayIso(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dayIdx = (dt.getUTCDay() + 6) % 7;
    dt.setUTCDate(dt.getUTCDate() - dayIdx);
    return dt.toISOString().slice(0, 10);
  }

  function addDaysIso(isoDate, days) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  function buildActiveRecords() {
    const lapMap = new Map();
    for (const r of state.raw.lapleau || []) {
      const iso = r[0];
      const kwh = Number(r[1]) || 0;
      const baseEur = Number(r[2]) || 0;
      const aboEur = Number(r[3]) || 0;
      lapMap.set(iso, {
        iso,
        kwh,
        baseKwh: kwh,
        hpKwh: 0,
        hcKwh: 0,
        baseEur,
        hpEur: 0,
        hcEur: 0,
        consoEur: baseEur,
        aboEur,
        totalEur: baseEur + aboEur,
        lapEur: baseEur + aboEur,
        bdxEur: 0,
        lapKwh: kwh,
        bdxKwh: 0
      });
    }

    const bdxMap = new Map();
    for (const r of state.raw.bordeaux || []) {
      const iso = r[0];
      const kwh = Number(r[1]) || 0;
      const hpKwh = Number(r[2]) || 0;
      const hcKwh = Number(r[3]) || 0;
      const hpEur = Number(r[4]) || 0;
      const hcEur = Number(r[5]) || 0;
      const aboEur = Number(r[6]) || 0;
      const consoEur = hpEur + hcEur;
      bdxMap.set(iso, {
        iso,
        kwh,
        baseKwh: 0,
        hpKwh,
        hcKwh,
        baseEur: 0,
        hpEur,
        hcEur,
        consoEur,
        aboEur,
        totalEur: consoEur + aboEur,
        lapEur: 0,
        bdxEur: consoEur + aboEur,
        lapKwh: 0,
        bdxKwh: kwh
      });
    }

    bordeauxAllRecords = Array.from(bdxMap.values()).sort((a, b) => a.iso.localeCompare(b.iso));

    if (state.prop === 'lapleau') {
      dayRecords = Array.from(lapMap.values()).sort((a, b) => a.iso.localeCompare(b.iso));
    } else if (state.prop === 'bordeaux') {
      dayRecords = bordeauxAllRecords;
    } else {
      const allDates = new Set([...lapMap.keys(), ...bdxMap.keys()]);
      const merged = [];
      for (const iso of allDates) {
        const l = lapMap.get(iso);
        const b = bdxMap.get(iso);
        const kwh = (l ? l.kwh : 0) + (b ? b.kwh : 0);
        const consoEur = (l ? l.consoEur : 0) + (b ? b.consoEur : 0);
        const aboEur = (l ? l.aboEur : 0) + (b ? b.aboEur : 0);
        merged.push({
          iso,
          kwh,
          baseKwh: l ? l.baseKwh : 0,
          hpKwh: b ? b.hpKwh : 0,
          hcKwh: b ? b.hcKwh : 0,
          baseEur: l ? l.baseEur : 0,
          hpEur: b ? b.hpEur : 0,
          hcEur: b ? b.hcEur : 0,
          consoEur,
          aboEur,
          totalEur: consoEur + aboEur,
          lapEur: l ? l.totalEur : 0,
          bdxEur: b ? b.totalEur : 0,
          lapKwh: l ? l.kwh : 0,
          bdxKwh: b ? b.kwh : 0
        });
      }
      dayRecords = merged.sort((a, b) => a.iso.localeCompare(b.iso));
    }
  }

  function getAvailablePeriods() {
    if (state.mode === 'day') {
      const months = Array.from(new Set(dayRecords.map((r) => r.iso.slice(0, 7)))).sort();
      return months.map((ym) => ({
        value: ym,
        label: `📅 ${formatYearMonthFr(ym)}`
      }));
    } else if (state.mode === 'week') {
      const mondays = Array.from(new Set(dayRecords.map((r) => getWeekMondayIso(r.iso)))).sort();
      return mondays.map((monIso) => {
        const sunIso = addDaysIso(monIso, 6);
        return {
          value: monIso,
          label: `📆 Lun ${isoToShortFr(monIso)} → Dim ${isoToFr(sunIso)}`
        };
      });
    } else {
      const years = Array.from(new Set(dayRecords.map((r) => r.iso.slice(0, 4)))).sort();
      const opts = [{ value: 'LAST_12', label: '📊 12 derniers mois' }];
      for (const y of years) {
        opts.push({ value: y, label: `📊 Année ${y}` });
      }
      opts.push({ value: 'ALL', label: '📊 Tout l’historique mensuel' });
      return opts;
    }
  }

  function populatePeriodSelect() {
    const select = document.getElementById('period-select');
    const prevBtn = document.getElementById('nav-prev');
    const nextBtn = document.getElementById('nav-next');

    const periods = getAvailablePeriods();
    select.innerHTML = '';

    for (const p of periods) {
      const opt = document.createElement('option');
      opt.value = p.value;
      opt.textContent = p.label;
      select.appendChild(opt);
    }

    const exists = periods.some((p) => p.value === state.selectedPeriod);
    if (!exists && periods.length > 0) {
      if (state.mode === 'month') {
        state.selectedPeriod = 'LAST_12';
      } else {
        state.selectedPeriod = periods[periods.length - 1].value;
      }
    }
    select.value = state.selectedPeriod;

    const idx = periods.findIndex((p) => p.value === state.selectedPeriod);
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx < 0 || idx >= periods.length - 1;
  }

  function sumRecords(recs) {
    const res = {
      daysCount: recs.length,
      kwh: 0,
      baseKwh: 0,
      hpKwh: 0,
      hcKwh: 0,
      baseEur: 0,
      hpEur: 0,
      hcEur: 0,
      consoEur: 0,
      aboEur: 0,
      totalEur: 0,
      lapEur: 0,
      bdxEur: 0,
      lapKwh: 0,
      bdxKwh: 0,
      maxDay: null
    };
    for (const r of recs) {
      res.kwh += r.kwh;
      res.baseKwh += r.baseKwh;
      res.hpKwh += r.hpKwh;
      res.hcKwh += r.hcKwh;
      res.baseEur += r.baseEur;
      res.hpEur += r.hpEur;
      res.hcEur += r.hcEur;
      res.consoEur += r.consoEur;
      res.aboEur += r.aboEur;
      res.totalEur += r.totalEur;
      res.lapEur += r.lapEur;
      res.bdxEur += r.bdxEur;
      res.lapKwh += r.lapKwh;
      res.bdxKwh += r.bdxKwh;
      if (!res.maxDay || r.totalEur > res.maxDay.totalEur) {
        res.maxDay = r;
      }
    }
    const hphcTotal = res.hpKwh + res.hcKwh;
    res.hpPct = hphcTotal > 0 ? (res.hpKwh / hphcTotal) * 100 : 0;
    res.hcPct = hphcTotal > 0 ? (res.hcKwh / hphcTotal) * 100 : 0;
    return res;
  }

  /**
   * Calcule la simulation de rentabilité HP/HC vs Option Base sur un ensemble de relevés Bordeaux
   */
  function computeHpHcProfitability(stats) {
    const hphcKwh = stats.hpKwh + stats.hcKwh;
    if (hphcKwh <= 0) return null;

    const hpRate = stats.hpKwh > 0 ? stats.hpEur / stats.hpKwh : 0.16;
    const hcRate = stats.hcKwh > 0 ? stats.hcEur / stats.hcKwh : 0.113;

    // Tarif Base équivalent Octopus : situé au point d'équilibre de 33% d'Heures Creuses
    const eqBaseRate = hpRate * (1 - HPHC_BREAKEVEN_RATIO) + hcRate * HPHC_BREAKEVEN_RATIO;

    // Coût qu'aurait représenté la même consommation totale au tarif Base
    const simulatedBaseConsoEur = hphcKwh * eqBaseRate;
    const actualHpHcConsoEur = stats.hpEur + stats.hcEur;

    // Économie sur la consommation (positive = HP/HC moins cher que Base)
    const savingsEur = simulatedBaseConsoEur - actualHpHcConsoEur;
    const savingsPct = simulatedBaseConsoEur > 0 ? (savingsEur / simulatedBaseConsoEur) * 100 : 0;

    return {
      hphcKwh,
      hpPct: stats.hpPct,
      hcPct: stats.hcPct,
      hpRate,
      hcRate,
      eqBaseRate,
      actualHpHcConsoEur,
      simulatedBaseConsoEur,
      savingsEur,
      savingsPct,
      isProfitable: savingsEur >= 0
    };
  }

  function renderHpHcProfitabilitySection(periodStats, periodTitle) {
    const section = document.getElementById('hphc-profitability-section');
    if (state.prop === 'lapleau') {
      section.classList.add('hidden');
      return;
    }

    const prof = computeHpHcProfitability(periodStats);
    const globalStats = sumRecords(bordeauxAllRecords);
    const globalProf = computeHpHcProfitability(globalStats);

    if (!prof || !globalProf) {
      section.classList.add('hidden');
      return;
    }

    section.classList.remove('hidden');

    const sign = prof.savingsEur >= 0 ? '+' : '';
    const verdictClass = prof.isProfitable ? 'verdict-ok' : 'verdict-warn';
    const verdictText = prof.isProfitable
      ? `✅ Option HP/HC Rentable (${sign}${fmtEur(prof.savingsEur)} d'économie sur la période)`
      : `⚠️ Option Base plus avantageuse (${fmtEur(prof.savingsEur)} sur la période)`;

    const globalSign = globalProf.savingsEur >= 0 ? '+' : '';

    section.innerHTML = `
      <div class="hphc-header">
        <div>
          <h2>⚖️ Répartition Heures Pleines / Heures Creuses & Rentabilité (🏢 Bordeaux)</h2>
          <p class="card-subtitle">Analyse sur <strong>${periodTitle}</strong> et bilan global sur les ${globalStats.daysCount} jours d'historique</p>
        </div>
        <div class="verdict-badge ${verdictClass}">${verdictText}</div>
      </div>

      <div class="hphc-split-bar-wrap">
        <div class="hphc-split-labels">
          <span class="lbl-hp">🔴 Heures Pleines : ${fmtPct(prof.hpPct)} (${fmtKwh(periodStats.hpKwh, 1)} • ${fmtEur(periodStats.hpEur)})</span>
          <span class="lbl-hc">🔵 Heures Creuses : ${fmtPct(prof.hcPct)} (${fmtKwh(periodStats.hcKwh, 1)} • ${fmtEur(periodStats.hcEur)})</span>
        </div>
        <div class="hphc-split-bar">
          <div class="split-fill-hp" style="width: ${prof.hpPct.toFixed(1)}%"></div>
          <div class="split-fill-hc" style="width: ${prof.hcPct.toFixed(1)}%"></div>
        </div>
        <div class="hphc-threshold-note">
          <span>🎯 Seuil de rentabilité HP/HC : <strong>≥ 33,0 % d'Heures Creuses</strong> (vous êtes à <strong>${fmtPct(prof.hcPct)}</strong> sur cette période)</span>
          <span>📊 Moyenne globale (875 j) : <strong>${fmtPct(globalProf.hpPct)} HP / ${fmtPct(globalProf.hcPct)} HC</strong></span>
        </div>
      </div>

      <div class="hphc-boxes">
        <div class="hphc-box">
          <div class="hphc-box-title">🔵 Part Heures Creuses (${periodTitle})</div>
          <div class="hphc-box-val" style="color:#38bdf8">${fmtPct(prof.hcPct)} <span style="font-size:13px;color:#94a3b8">/ ${fmtPct(prof.hpPct)} HP</span></div>
          <div class="hphc-box-sub">${fmtKwh(periodStats.hcKwh)} en HC contre ${fmtKwh(periodStats.hpKwh)} en HP</div>
        </div>

        <div class="hphc-box">
          <div class="hphc-box-title">💶 Coût Conso HP/HC vs Option Base</div>
          <div class="hphc-box-val">${fmtEur(prof.actualHpHcConsoEur)} <span style="font-size:13px;color:#94a3b8">au lieu de ${fmtEur(prof.simulatedBaseConsoEur)}</span></div>
          <div class="hphc-box-sub">Tarif moyen : <strong>${prof.hcRate.toFixed(3)} €</strong> (HC) • <strong>${prof.hpRate.toFixed(3)} €</strong> (HP) • <strong>${prof.eqBaseRate.toFixed(3)} €</strong> (Base)</div>
        </div>

        <div class="hphc-box">
          <div class="hphc-box-title">💰 Gain sur la période (${periodTitle})</div>
          <div class="hphc-box-val" style="color:${prof.isProfitable ? '#34d399' : '#f87171'}">${sign}${fmtEur(prof.savingsEur)} <span style="font-size:13px">(${sign}${prof.savingsPct.toFixed(1)}%)</span></div>
          <div class="hphc-box-sub">${prof.isProfitable ? 'Économie réalisée grâce aux Heures Creuses' : 'Surcoût lié à une part HP élevée'}</div>
        </div>

        <div class="hphc-box">
          <div class="hphc-box-title">🏆 Bilan Cumulé (875 jours depuis 2023)</div>
          <div class="hphc-box-val" style="color:#34d399">${globalSign}${fmtEur(globalProf.savingsEur)} <span style="font-size:13px">(${fmtPct(globalProf.hcPct)} HC)</span></div>
          <div class="hphc-box-sub">Payé : <strong>${fmtEur(globalProf.actualHpHcConsoEur)}</strong> au lieu de <strong>${fmtEur(globalProf.simulatedBaseConsoEur)}</strong> en Base</div>
        </div>
      </div>
    `;
  }

  function renderDiffPill(currentVal, prevVal) {
    if (!prevVal || prevVal <= 0) return '';
    const diffPct = ((currentVal - prevVal) / prevVal) * 100;
    const sign = diffPct >= 0 ? '+' : '';
    const cls = diffPct > 0 ? 'pill-up' : 'pill-down';
    return `<span class="kpi-pill ${cls}">${sign}${diffPct.toFixed(1)}%</span>`;
  }

  function renderKpis(stats, prevStats, periodTitle) {
    const grid = document.getElementById('kpi-grid');
    const avgDayEur = stats.daysCount ? stats.totalEur / stats.daysCount : 0;
    const avgDayKwh = stats.daysCount ? stats.kwh / stats.daysCount : 0;
    const aboPerDay = stats.daysCount ? stats.aboEur / stats.daysCount : 0;

    let thirdCardSub = `Moyenne : <strong>${fmtKwh(avgDayKwh)} / jour</strong>`;
    if (state.prop === 'bordeaux' && stats.kwh > 0) {
      thirdCardSub = `🔴 HP : <strong>${fmtPct(stats.hpPct)}</strong> (${fmtKwh(stats.hpKwh, 1)}) • 🔵 HC : <strong>${fmtPct(stats.hcPct)}</strong> (${fmtKwh(stats.hcKwh, 1)})`;
    } else if (state.prop === 'both') {
      thirdCardSub = `🏡 ${fmtKwh(stats.lapKwh, 1)} • 🏢 ${fmtKwh(stats.bdxKwh, 1)} (${fmtPct(stats.hcPct)} HC)`;
    }

    let secondCardSub = `Conso : <strong>${fmtEur(stats.consoEur)}</strong> • Abo : <strong>${fmtEur(stats.aboEur)}</strong> (${fmtEur(aboPerDay)}/j)`;
    if (state.prop === 'both') {
      secondCardSub = `🏡 St Merd : <strong>${fmtEur(stats.lapEur)}</strong> • 🏢 Bordeaux : <strong>${fmtEur(stats.bdxEur)}</strong>`;
    }

    const diffEurHtml = prevStats ? renderDiffPill(stats.totalEur, prevStats.totalEur) : '';
    const diffKwhHtml = prevStats ? renderDiffPill(stats.kwh, prevStats.kwh) : '';

    const maxInfo = stats.maxDay
      ? `Pic le <strong>${isoToFr(stats.maxDay.iso)}</strong> (${fmtEur(stats.maxDay.totalEur)} • ${fmtKwh(stats.maxDay.kwh)})`
      : 'Aucune mesure';

    grid.innerHTML = `
      <div class="kpi-card highlight">
        <div class="kpi-label">💶 Coût Total TTC (${periodTitle})</div>
        <div class="kpi-value">${fmtEur(stats.totalEur)}</div>
        <div class="kpi-sub">${diffEurHtml} ${secondCardSub}</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-label">⚡ Consommation Électrique</div>
        <div class="kpi-value">${fmtKwh(stats.kwh)}</div>
        <div class="kpi-sub">${diffKwhHtml} ${thirdCardSub}</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-label">📌 Part Abonnement & Conso</div>
        <div class="kpi-value">${fmtEur(aboPerDay)} <span style="font-size:14px;font-weight:600;color:#c4b5fd">/ jour</span></div>
        <div class="kpi-sub">Total Abo : <strong>${fmtEur(stats.aboEur)}</strong> • Conso pure : <strong>${fmtEur(stats.consoEur)}</strong></div>
      </div>

      <div class="kpi-card">
        <div class="kpi-label">📈 Moyenne & Pic Journalier (${stats.daysCount} j)</div>
        <div class="kpi-value">${fmtEur(avgDayEur)} <span style="font-size:14px;font-weight:600;color:#c4b5fd">/ jour</span></div>
        <div class="kpi-sub">${maxInfo}</div>
      </div>
    `;

    renderHpHcProfitabilitySection(stats, periodTitle);
  }

  function renderLegend() {
    const legend = document.getElementById('chart-legend');
    if (state.prop === 'both') {
      legend.innerHTML = `
        <div class="legend-item"><span class="legend-dot seg-base"></span> 🏡 St Merd De Lapleau</div>
        <div class="legend-item"><span class="legend-dot seg-bdx"></span> 🏢 Bordeaux</div>
      `;
    } else if (state.prop === 'bordeaux') {
      if (state.unit === 'eur') {
        legend.innerHTML = `
          <div class="legend-item"><span class="legend-dot seg-hp"></span> Heures Pleines (€)</div>
          <div class="legend-item"><span class="legend-dot seg-hc"></span> Heures Creuses (€)</div>
          <div class="legend-item"><span class="legend-dot seg-abo"></span> Abonnement (€)</div>
        `;
      } else {
        legend.innerHTML = `
          <div class="legend-item"><span class="legend-dot seg-hp"></span> Heures Pleines (kWh)</div>
          <div class="legend-item"><span class="legend-dot seg-hc"></span> Heures Creuses (kWh)</div>
        `;
      }
    } else {
      if (state.unit === 'eur') {
        legend.innerHTML = `
          <div class="legend-item"><span class="legend-dot seg-base"></span> Consommation Base (€)</div>
          <div class="legend-item"><span class="legend-dot seg-abo"></span> Abonnement (€)</div>
        `;
      } else {
        legend.innerHTML = `
          <div class="legend-item"><span class="legend-dot seg-base"></span> Consommation Base (kWh)</div>
        `;
      }
    }
  }

  function buildSegmentsForItem(item) {
    if (state.unit === 'eur') {
      if (state.prop === 'both') {
        return [
          { val: item.lapEur, cls: 'seg-base' },
          { val: item.bdxEur, cls: 'seg-bdx' }
        ];
      } else if (state.prop === 'bordeaux') {
        return [
          { val: item.hpEur, cls: 'seg-hp' },
          { val: item.hcEur, cls: 'seg-hc' },
          { val: item.aboEur, cls: 'seg-abo' }
        ];
      } else {
        return [
          { val: item.consoEur, cls: 'seg-base' },
          { val: item.aboEur, cls: 'seg-abo' }
        ];
      }
    } else {
      if (state.prop === 'both') {
        return [
          { val: item.lapKwh, cls: 'seg-base' },
          { val: item.bdxKwh, cls: 'seg-bdx' }
        ];
      } else if (state.prop === 'bordeaux') {
        return [
          { val: item.hpKwh, cls: 'seg-hp' },
          { val: item.hcKwh, cls: 'seg-hc' }
        ];
      } else {
        return [{ val: item.kwh, cls: 'seg-base' }];
      }
    }
  }

  function attachTooltipEvents(colEl, tooltipHtml) {
    const tooltip = document.getElementById('chart-tooltip');
    colEl.addEventListener('mouseenter', () => {
      tooltip.innerHTML = tooltipHtml;
      tooltip.classList.remove('hidden');
    });
    colEl.addEventListener('mousemove', (e) => {
      const x = Math.min(window.innerWidth - 260, e.clientX + 14);
      const y = Math.max(12, e.clientY - 100);
      tooltip.style.left = `${x}px`;
      tooltip.style.top = `${y}px`;
    });
    colEl.addEventListener('mouseleave', () => {
      tooltip.classList.add('hidden');
    });
  }

  function buildTooltipHtml(title, r) {
    if (state.prop === 'both') {
      return `
        <div class="tt-title">${title}</div>
        <div class="tt-row"><span>🏡 St Merd :</span> <strong>${fmtEur(r.lapEur)} (${fmtKwh(r.lapKwh)})</strong></div>
        <div class="tt-row"><span>🏢 Bordeaux :</span> <strong>${fmtEur(r.bdxEur)} (${fmtKwh(r.bdxKwh)})</strong></div>
        <div class="tt-row"><span>Dont Abonnements :</span> <strong>${fmtEur(r.aboEur)}</strong></div>
        <div class="tt-row tt-total"><span>Total Cumulé :</span> <span>${fmtEur(r.totalEur)} • ${fmtKwh(r.kwh)}</span></div>
      `;
    } else if (state.prop === 'bordeaux') {
      const hphcTot = r.hpKwh + r.hcKwh;
      const hpPct = hphcTot > 0 ? ((r.hpKwh / hphcTot) * 100).toFixed(1) : '0.0';
      const hcPct = hphcTot > 0 ? ((r.hcKwh / hphcTot) * 100).toFixed(1) : '0.0';
      return `
        <div class="tt-title">${title}</div>
        <div class="tt-row"><span>🔴 Heures Pleines (${hpPct}%) :</span> <strong>${fmtEur(r.hpEur)} (${fmtKwh(r.hpKwh)})</strong></div>
        <div class="tt-row"><span>🔵 Heures Creuses (${hcPct}%) :</span> <strong>${fmtEur(r.hcEur)} (${fmtKwh(r.hcKwh)})</strong></div>
        <div class="tt-row"><span>📌 Abonnement :</span> <strong>${fmtEur(r.aboEur)}</strong></div>
        <div class="tt-row tt-total"><span>Total TTC :</span> <span>${fmtEur(r.totalEur)} • ${fmtKwh(r.kwh)}</span></div>
      `;
    } else {
      return `
        <div class="tt-title">${title}</div>
        <div class="tt-row"><span>⚡ Conso Base :</span> <strong>${fmtEur(r.consoEur)} (${fmtKwh(r.kwh)})</strong></div>
        <div class="tt-row"><span>📌 Abonnement :</span> <strong>${fmtEur(r.aboEur)}</strong></div>
        <div class="tt-row tt-total"><span>Total TTC :</span> <span>${fmtEur(r.totalEur)}</span></div>
      `;
    }
  }

  function renderBarsInto(containerEl, items, onClickItem = null) {
    containerEl.innerHTML = '';
    const stage = document.createElement('div');
    stage.className = 'bars-stage';

    const maxMetric = Math.max(
      0.01,
      ...items.map((it) => (state.unit === 'eur' ? it.stats.totalEur : it.stats.kwh))
    );

    const maxBarPx = 195;

    for (const item of items) {
      const col = document.createElement('div');
      col.className = 'bar-col' + (item.selected ? ' selected-bar' : '');

      const metricVal = state.unit === 'eur' ? item.stats.totalEur : item.stats.kwh;
      const primaryText =
        metricVal > 0
          ? state.unit === 'eur'
            ? fmtEur(item.stats.totalEur)
            : fmtKwh(item.stats.kwh, 1)
          : '-';
      const secondaryText =
        metricVal > 0
          ? state.unit === 'eur'
            ? fmtKwh(item.stats.kwh, 1)
            : fmtEur(item.stats.totalEur)
          : '';

      const topVal = document.createElement('div');
      topVal.className = 'bar-top-val';
      topVal.textContent = primaryText;

      const topSub = document.createElement('div');
      topSub.className = 'bar-top-sub';
      topSub.textContent = secondaryText;

      const stack = document.createElement('div');
      stack.className = 'bar-stack';

      const segs = buildSegmentsForItem(item.stats);
      for (const s of segs) {
        if (s.val <= 0) continue;
        const segEl = document.createElement('div');
        segEl.className = `bar-seg ${s.cls}`;
        const h = Math.max(2, Math.round((s.val / maxMetric) * maxBarPx));
        segEl.style.height = `${h}px`;
        stack.appendChild(segEl);
      }

      if (metricVal <= 0) {
        stack.style.height = '3px';
      }

      const lbl = document.createElement('div');
      lbl.className = 'bar-label';
      lbl.textContent = item.label;

      const subLbl = document.createElement('div');
      subLbl.className = 'bar-sublabel';
      subLbl.textContent = item.subLabel || '';

      col.appendChild(topVal);
      col.appendChild(topSub);
      col.appendChild(stack);
      col.appendChild(lbl);
      if (item.subLabel) col.appendChild(subLbl);

      attachTooltipEvents(col, buildTooltipHtml(item.tooltipTitle, item.stats));

      if (onClickItem) {
        col.addEventListener('click', () => onClickItem(item));
      }

      stage.appendChild(col);
    }

    containerEl.appendChild(stage);
  }

  function renderTableForDays(recs) {
    const thead = document.getElementById('table-head');
    const tbody = document.getElementById('table-body');
    const sortedDesc = [...recs].sort((a, b) => b.iso.localeCompare(a.iso));
    const tot = sumRecords(recs);

    if (state.prop === 'bordeaux') {
      thead.innerHTML = `
        <tr>
          <th>Date</th>
          <th>Jour</th>
          <th>Conso Totale (kWh)</th>
          <th>Heures Pleines (kWh)</th>
          <th>Heures Creuses (kWh)</th>
          <th>Part HP / HC (%)</th>
          <th>Coût Conso TTC (€)</th>
          <th>Abonnement TTC (€)</th>
          <th>Total TTC (€)</th>
        </tr>
      `;
      tbody.innerHTML =
        `<tr class="total-row">
          <td>TOTAL (${tot.daysCount} jours)</td>
          <td>-</td>
          <td>${fmtKwh(tot.kwh)}</td>
          <td>${fmtKwh(tot.hpKwh)}</td>
          <td>${fmtKwh(tot.hcKwh)}</td>
          <td><span style="color:#fda4af">${fmtPct(tot.hpPct)} HP</span> / <span style="color:#7dd3fc">${fmtPct(tot.hcPct)} HC</span></td>
          <td>${fmtEur(tot.consoEur)}</td>
          <td>${fmtEur(tot.aboEur)}</td>
          <td>${fmtEur(tot.totalEur)}</td>
        </tr>` +
        sortedDesc
          .map((r) => {
            const wd = DAYS_FULL_FR[getMondayBasedWeekday(r.iso)];
            const hphc = r.hpKwh + r.hcKwh;
            const hpP = hphc > 0 ? (r.hpKwh / hphc) * 100 : 0;
            const hcP = hphc > 0 ? (r.hcKwh / hphc) * 100 : 0;
            return `<tr>
              <td><strong>${isoToFr(r.iso)}</strong></td>
              <td style="text-align:left;color:#c4b5fd">${wd}</td>
              <td class="td-kwh">${fmtKwh(r.kwh, 3)}</td>
              <td>${fmtKwh(r.hpKwh, 3)}</td>
              <td>${fmtKwh(r.hcKwh, 3)}</td>
              <td><span style="color:#fda4af">${fmtPct(hpP)}</span> / <strong style="color:#7dd3fc">${fmtPct(hcP)} HC</strong></td>
              <td>${fmtEur(r.consoEur)}</td>
              <td>${fmtEur(r.aboEur)}</td>
              <td class="td-highlight">${fmtEur(r.totalEur)}</td>
            </tr>`;
          })
          .join('');
    } else if (state.prop === 'both') {
      thead.innerHTML = `
        <tr>
          <th>Date</th>
          <th>Jour</th>
          <th>🏡 St Merd (kWh)</th>
          <th>🏡 St Merd (€ TTC)</th>
          <th>🏢 Bordeaux (kWh)</th>
          <th>🏢 Bordeaux (€ TTC)</th>
          <th>⚡ Total (kWh)</th>
          <th>💶 Total TTC (€)</th>
        </tr>
      `;
      tbody.innerHTML =
        `<tr class="total-row">
          <td>TOTAL (${tot.daysCount} jours)</td>
          <td>-</td>
          <td>${fmtKwh(tot.lapKwh)}</td>
          <td>${fmtEur(tot.lapEur)}</td>
          <td>${fmtKwh(tot.bdxKwh)}</td>
          <td>${fmtEur(tot.bdxEur)}</td>
          <td>${fmtKwh(tot.kwh)}</td>
          <td>${fmtEur(tot.totalEur)}</td>
        </tr>` +
        sortedDesc
          .map((r) => {
            const wd = DAYS_FULL_FR[getMondayBasedWeekday(r.iso)];
            return `<tr>
              <td><strong>${isoToFr(r.iso)}</strong></td>
              <td style="text-align:left;color:#c4b5fd">${wd}</td>
              <td>${fmtKwh(r.lapKwh, 2)}</td>
              <td>${fmtEur(r.lapEur)}</td>
              <td>${fmtKwh(r.bdxKwh, 2)}</td>
              <td>${fmtEur(r.bdxEur)}</td>
              <td class="td-kwh">${fmtKwh(r.kwh, 2)}</td>
              <td class="td-highlight">${fmtEur(r.totalEur)}</td>
            </tr>`;
          })
          .join('');
    } else {
      thead.innerHTML = `
        <tr>
          <th>Date</th>
          <th>Jour</th>
          <th>Conso Base (kWh)</th>
          <th>Coût Conso TTC (€)</th>
          <th>Abonnement TTC (€)</th>
          <th>Total TTC (€)</th>
        </tr>
      `;
      tbody.innerHTML =
        `<tr class="total-row">
          <td>TOTAL (${tot.daysCount} jours)</td>
          <td>-</td>
          <td>${fmtKwh(tot.kwh)}</td>
          <td>${fmtEur(tot.consoEur)}</td>
          <td>${fmtEur(tot.aboEur)}</td>
          <td>${fmtEur(tot.totalEur)}</td>
        </tr>` +
        sortedDesc
          .map((r) => {
            const wd = DAYS_FULL_FR[getMondayBasedWeekday(r.iso)];
            return `<tr>
              <td><strong>${isoToFr(r.iso)}</strong></td>
              <td style="text-align:left;color:#c4b5fd">${wd}</td>
              <td class="td-kwh">${fmtKwh(r.kwh, 3)}</td>
              <td>${fmtEur(r.consoEur)}</td>
              <td>${fmtEur(r.aboEur)}</td>
              <td class="td-highlight">${fmtEur(r.totalEur)}</td>
            </tr>`;
          })
          .join('');
    }
  }

  function renderDayMode() {
    document.getElementById('secondary-section').classList.add('hidden');
    const ym = state.selectedPeriod;
    const monthRecs = dayRecords.filter((r) => r.iso.startsWith(ym));

    const allMonths = Array.from(new Set(dayRecords.map((r) => r.iso.slice(0, 7)))).sort();
    const mIdx = allMonths.indexOf(ym);
    const prevYm = mIdx > 0 ? allMonths[mIdx - 1] : null;
    const prevRecs = prevYm ? dayRecords.filter((r) => r.iso.startsWith(prevYm)) : null;

    const stats = sumRecords(monthRecs);
    const prevStats = prevRecs ? sumRecords(prevRecs) : null;

    renderKpis(stats, prevStats, formatYearMonthFr(ym));

    document.getElementById('chart-title').textContent = `📅 Consommation jour par jour — ${formatYearMonthFr(ym)}`;
    document.getElementById('chart-subtitle').textContent = `${stats.daysCount} jours relevés • Total : ${fmtEur(stats.totalEur)} TTC (${fmtKwh(stats.kwh)})`;

    const barItems = monthRecs.map((r) => {
      const wdShort = DAYS_SHORT_FR[getMondayBasedWeekday(r.iso)];
      const dayNum = r.iso.slice(8, 10);
      return {
        label: dayNum,
        subLabel: wdShort,
        tooltipTitle: `${DAYS_FULL_FR[getMondayBasedWeekday(r.iso)]} ${isoToFr(r.iso)}`,
        stats: r
      };
    });

    renderBarsInto(document.getElementById('main-chart'), barItems);

    document.getElementById('table-title').textContent = `Détail journalier — ${formatYearMonthFr(ym)}`;
    document.getElementById('table-subtitle').textContent = 'Trié du jour le plus récent au plus ancien';
    renderTableForDays(monthRecs);
  }

  function renderWeekMode() {
    const monIso = state.selectedPeriod;
    const sunIso = addDaysIso(monIso, 6);

    const byDate = new Map(dayRecords.map((r) => [r.iso, r]));
    const weekDays = [];
    const actualWeekRecs = [];

    for (let i = 0; i < 7; i++) {
      const dIso = addDaysIso(monIso, i);
      const rec = byDate.get(dIso) || {
        iso: dIso,
        kwh: 0,
        baseKwh: 0,
        hpKwh: 0,
        hcKwh: 0,
        baseEur: 0,
        hpEur: 0,
        hcEur: 0,
        consoEur: 0,
        aboEur: 0,
        totalEur: 0,
        lapEur: 0,
        bdxEur: 0,
        lapKwh: 0,
        bdxKwh: 0
      };
      if (byDate.has(dIso)) actualWeekRecs.push(rec);
      weekDays.push({
        label: DAYS_FULL_FR[i],
        subLabel: isoToShortFr(dIso),
        tooltipTitle: `${DAYS_FULL_FR[i]} ${isoToFr(dIso)}`,
        stats: rec
      });
    }

    const prevMonIso = addDaysIso(monIso, -7);
    const prevWeekRecs = [];
    for (let i = 0; i < 7; i++) {
      const dIso = addDaysIso(prevMonIso, i);
      if (byDate.has(dIso)) prevWeekRecs.push(byDate.get(dIso));
    }

    const stats = sumRecords(actualWeekRecs);
    const prevStats = prevWeekRecs.length ? sumRecords(prevWeekRecs) : null;

    renderKpis(stats, prevStats, `Lun ${isoToShortFr(monIso)} → Dim ${isoToShortFr(sunIso)}`);

    document.getElementById('chart-title').textContent = `📆 Semaine du Lundi ${isoToFr(monIso)} au Dimanche ${isoToFr(sunIso)}`;
    document.getElementById('chart-subtitle').textContent = `${stats.daysCount}/7 jours relevés • Total semaine : ${fmtEur(stats.totalEur)} TTC (${fmtKwh(stats.kwh)})`;

    renderBarsInto(document.getElementById('main-chart'), weekDays);

    const secSection = document.getElementById('secondary-section');
    secSection.classList.remove('hidden');

    const allMondays = Array.from(new Set(dayRecords.map((r) => getWeekMondayIso(r.iso)))).sort();
    const recentMondays = allMondays.slice(-12);

    const weekItems = recentMondays.map((wMon) => {
      const wSun = addDaysIso(wMon, 6);
      const recs = [];
      for (let i = 0; i < 7; i++) {
        const dIso = addDaysIso(wMon, i);
        if (byDate.has(dIso)) recs.push(byDate.get(dIso));
      }
      const wStats = sumRecords(recs);
      return {
        value: wMon,
        selected: wMon === monIso,
        label: `${isoToShortFr(wMon)}`,
        subLabel: `→ ${isoToShortFr(wSun)}`,
        tooltipTitle: `Semaine du Lun ${isoToFr(wMon)} au Dim ${isoToFr(wSun)} (${wStats.daysCount} j)`,
        stats: wStats
      };
    });

    renderBarsInto(document.getElementById('secondary-chart'), weekItems, (clicked) => {
      state.selectedPeriod = clicked.value;
      document.getElementById('period-select').value = clicked.value;
      renderAll();
    });

    document.getElementById('table-title').textContent = `Détail des 7 jours (Lundi ${isoToShortFr(monIso)} → Dimanche ${isoToShortFr(sunIso)})`;
    document.getElementById('table-subtitle').textContent = 'Mesures quotidiennes de la semaine sélectionnée';
    renderTableForDays(actualWeekRecs);
  }

  function renderMonthMode() {
    document.getElementById('secondary-section').classList.add('hidden');

    const monthsMap = new Map();
    for (const r of dayRecords) {
      const ym = r.iso.slice(0, 7);
      if (!monthsMap.has(ym)) monthsMap.set(ym, []);
      monthsMap.get(ym).push(r);
    }

    let sortedMonths = Array.from(monthsMap.keys()).sort();
    if (state.selectedPeriod === 'LAST_12') {
      sortedMonths = sortedMonths.slice(-12);
    } else if (/^\d{4}$/.test(state.selectedPeriod)) {
      sortedMonths = sortedMonths.filter((ym) => ym.startsWith(state.selectedPeriod));
    }

    const filteredRecs = sortedMonths.flatMap((ym) => monthsMap.get(ym) || []);
    const stats = sumRecords(filteredRecs);

    const periodLabel =
      state.selectedPeriod === 'LAST_12'
        ? '12 derniers mois'
        : state.selectedPeriod === 'ALL'
        ? 'Tout l’historique'
        : `Année ${state.selectedPeriod}`;

    renderKpis(stats, null, periodLabel);

    document.getElementById('chart-title').textContent = `📊 Évolution mensuelle (${periodLabel}) — Cliquez sur un mois pour voir le détail jour par jour`;
    document.getElementById('chart-subtitle').textContent = `${sortedMonths.length} mois affichés • Cumul : ${fmtEur(stats.totalEur)} TTC (${fmtKwh(stats.kwh)})`;

    const monthItems = sortedMonths.map((ym) => {
      const mStats = sumRecords(monthsMap.get(ym));
      return {
        ym,
        label: formatYearMonthShortFr(ym),
        subLabel: `${mStats.daysCount} j`,
        tooltipTitle: `${formatYearMonthFr(ym)} (${mStats.daysCount} jours)`,
        stats: mStats
      };
    });

    renderBarsInto(document.getElementById('main-chart'), monthItems, (clicked) => {
      state.mode = 'day';
      state.selectedPeriod = clicked.ym;
      updateControlButtons();
      populatePeriodSelect();
      renderAll();
    });

    const thead = document.getElementById('table-head');
    const tbody = document.getElementById('table-body');
    document.getElementById('table-title').textContent = `Récapitulatif mensuel (${periodLabel})`;
    document.getElementById('table-subtitle').textContent = 'Chiffres exacts correspondant à votre espace client Octopus Energy';

    const showHpHcCols = state.prop === 'bordeaux';
    const totProf = showHpHcCols ? computeHpHcProfitability(stats) : null;

    if (showHpHcCols) {
      thead.innerHTML = `
        <tr>
          <th>Mois</th>
          <th>Jours</th>
          <th>Conso (kWh)</th>
          <th>Part HP / HC (%)</th>
          <th>Gain HP/HC vs Base</th>
          <th>Part Conso (€)</th>
          <th>Abonnement (€)</th>
          <th>Total TTC (€)</th>
        </tr>
      `;

      const descMonths = [...monthItems].reverse();
      const totGainSign = totProf && totProf.savingsEur >= 0 ? '+' : '';
      tbody.innerHTML =
        `<tr class="total-row">
          <td>TOTAL (${descMonths.length} mois)</td>
          <td>${stats.daysCount} j</td>
          <td>${fmtKwh(stats.kwh)}</td>
          <td><span style="color:#fda4af">${fmtPct(stats.hpPct)} HP</span> / <span style="color:#7dd3fc">${fmtPct(stats.hcPct)} HC</span></td>
          <td style="color:#34d399">${totProf ? totGainSign + fmtEur(totProf.savingsEur) : '-'}</td>
          <td>${fmtEur(stats.consoEur)}</td>
          <td>${fmtEur(stats.aboEur)}</td>
          <td>${fmtEur(stats.totalEur)}</td>
        </tr>` +
        descMonths
          .map((m) => {
            const s = m.stats;
            const p = computeHpHcProfitability(s);
            const gSign = p && p.savingsEur >= 0 ? '+' : '';
            const gColor = p && p.isProfitable ? '#34d399' : '#f87171';
            return `<tr style="cursor:pointer" data-jump-ym="${m.ym}">
              <td><strong>${formatYearMonthFr(m.ym)}</strong></td>
              <td>${s.daysCount} j</td>
              <td class="td-kwh">${fmtKwh(s.kwh)}</td>
              <td><span style="color:#fda4af">${fmtPct(s.hpPct)}</span> / <strong style="color:#7dd3fc">${fmtPct(s.hcPct)} HC</strong></td>
              <td style="color:${gColor};font-weight:700">${p ? gSign + fmtEur(p.savingsEur) : '-'}</td>
              <td>${fmtEur(s.consoEur)}</td>
              <td>${fmtEur(s.aboEur)}</td>
              <td class="td-highlight">${fmtEur(s.totalEur)}</td>
            </tr>`;
          })
          .join('');
    } else {
      thead.innerHTML = `
        <tr>
          <th>Mois</th>
          <th>Jours relevés</th>
          <th>Consommation (kWh)</th>
          <th>Part Conso TTC (€)</th>
          <th>Part Abonnement TTC (€)</th>
          <th>Abonnement / jour</th>
          <th>Total TTC (€)</th>
        </tr>
      `;

      const descMonths = [...monthItems].reverse();
      tbody.innerHTML =
        `<tr class="total-row">
          <td>TOTAL (${descMonths.length} mois)</td>
          <td>${stats.daysCount} j</td>
          <td>${fmtKwh(stats.kwh)}</td>
          <td>${fmtEur(stats.consoEur)}</td>
          <td>${fmtEur(stats.aboEur)}</td>
          <td>${fmtEur(stats.daysCount ? stats.aboEur / stats.daysCount : 0)}/j</td>
          <td>${fmtEur(stats.totalEur)}</td>
        </tr>` +
        descMonths
          .map((m) => {
            const s = m.stats;
            const aboDay = s.daysCount ? s.aboEur / s.daysCount : 0;
            return `<tr style="cursor:pointer" data-jump-ym="${m.ym}">
              <td><strong>${formatYearMonthFr(m.ym)}</strong></td>
              <td>${s.daysCount} j</td>
              <td class="td-kwh">${fmtKwh(s.kwh)}</td>
              <td>${fmtEur(s.consoEur)}</td>
              <td>${fmtEur(s.aboEur)}</td>
              <td>${fmtEur(aboDay)}/j</td>
              <td class="td-highlight">${fmtEur(s.totalEur)}</td>
            </tr>`;
          })
          .join('');
    }

    tbody.querySelectorAll('tr[data-jump-ym]').forEach((tr) => {
      tr.addEventListener('click', () => {
        state.mode = 'day';
        state.selectedPeriod = tr.getAttribute('data-jump-ym');
        updateControlButtons();
        populatePeriodSelect();
        renderAll();
      });
    });
  }

  function updateControlButtons() {
    document.querySelectorAll('.prop-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.prop === state.prop);
    });
    document.querySelectorAll('.gran-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    });
    document.querySelectorAll('.unit-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.unit === state.unit);
    });
  }

  function renderAll() {
    renderLegend();
    const periods = getAvailablePeriods();
    const idx = periods.findIndex((p) => p.value === state.selectedPeriod);
    document.getElementById('nav-prev').disabled = idx <= 0;
    document.getElementById('nav-next').disabled = idx < 0 || idx >= periods.length - 1;

    if (state.mode === 'day') {
      renderDayMode();
    } else if (state.mode === 'week') {
      renderWeekMode();
    } else {
      renderMonthMode();
    }
  }

  function mergeIncomingData(incoming) {
    if (!incoming) return;
    if (Array.isArray(incoming.lapleau) && incoming.lapleau.length) {
      const m = new Map(state.raw.lapleau.map((r) => [r[0], r]));
      incoming.lapleau.forEach((r) => m.set(r[0], r));
      state.raw.lapleau = Array.from(m.values());
    }
    if (Array.isArray(incoming.bordeaux) && incoming.bordeaux.length) {
      const m = new Map(state.raw.bordeaux.map((r) => [r[0], r]));
      incoming.bordeaux.forEach((r) => m.set(r[0], r));
      state.raw.bordeaux = Array.from(m.values());
    }
  }

  async function refreshFromGoogleSheet() {
    const btn = document.getElementById('refresh-sheet-btn');
    const statusLbl = document.getElementById('sync-status-label');
    btn.disabled = true;
    btn.textContent = '⏳ Sync en cours...';
    try {
      // Si ouvert depuis l'extension Chrome, lance directement la synchro Octopus -> Sheet + Dashboard
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const res = await new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'OCTOPUS_SYNC_NOW', isAuto: false }, resolve)
        );
        if (res && res.ok) {
          const st = await chrome.storage.local.get(['syncedData']);
          if (st && st.syncedData) {
            mergeIncomingData(st.syncedData);
            buildActiveRecords();
            populatePeriodSelect();
            renderAll();
          }
          statusLbl.textContent = `Synchronisé avec Octopus & Google Sheets (${new Date().toLocaleTimeString('fr-FR')})`;
          return;
        }
      }

      // Fallback Web App GET
      const resp = await fetch(`${WEBAPP_URL}?action=data`);
      const json = await resp.json();
      if (json && (json.lapleau || json.bordeaux)) {
        mergeIncomingData(json);
        buildActiveRecords();
        populatePeriodSelect();
        renderAll();
        statusLbl.textContent = `Synchronisé en direct avec Google Sheets (${new Date().toLocaleTimeString('fr-FR')})`;
      }
    } catch (e) {
      statusLbl.textContent = 'Données locales chargées • Compte A-3E0B5AD1';
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 Sync Sheet';
    }
  }

  async function init() {
    if (window.OCTOPUS_INITIAL_DATA) {
      state.raw.lapleau = window.OCTOPUS_INITIAL_DATA.lapleau || [];
      state.raw.bordeaux = window.OCTOPUS_INITIAL_DATA.bordeaux || [];
    }

    // Lecture automatique des nouvelles mesures stockées par l'extension Chrome
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        const stored = await chrome.storage.local.get(['syncedData', 'lastSyncSummary']);
        if (stored && stored.syncedData) {
          mergeIncomingData(stored.syncedData);
        }
        if (stored && stored.lastSyncSummary && stored.lastSyncSummary.syncedAt) {
          document.getElementById('sync-status-label').textContent =
            `Synchronisé le ${stored.lastSyncSummary.syncedAt} • Compte A-3E0B5AD1`;
        }
      } catch (e) {}
    }

    buildActiveRecords();
    populatePeriodSelect();
    renderAll();

    document.querySelectorAll('.prop-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.prop = btn.dataset.prop;
        buildActiveRecords();
        populatePeriodSelect();
        updateControlButtons();
        renderAll();
      });
    });

    document.querySelectorAll('.gran-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.mode = btn.dataset.mode;
        state.selectedPeriod = null;
        populatePeriodSelect();
        updateControlButtons();
        renderAll();
      });
    });

    document.querySelectorAll('.unit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.unit = btn.dataset.unit;
        updateControlButtons();
        renderAll();
      });
    });

    const select = document.getElementById('period-select');
    select.addEventListener('change', () => {
      state.selectedPeriod = select.value;
      renderAll();
    });

    document.getElementById('nav-prev').addEventListener('click', () => {
      const periods = getAvailablePeriods();
      const idx = periods.findIndex((p) => p.value === state.selectedPeriod);
      if (idx > 0) {
        state.selectedPeriod = periods[idx - 1].value;
        select.value = state.selectedPeriod;
        renderAll();
      }
    });

    document.getElementById('nav-next').addEventListener('click', () => {
      const periods = getAvailablePeriods();
      const idx = periods.findIndex((p) => p.value === state.selectedPeriod);
      if (idx >= 0 && idx < periods.length - 1) {
        state.selectedPeriod = periods[idx + 1].value;
        select.value = state.selectedPeriod;
        renderAll();
      }
    });

    document.getElementById('nav-latest').addEventListener('click', () => {
      const periods = getAvailablePeriods();
      if (periods.length > 0) {
        state.selectedPeriod =
          state.mode === 'month' ? 'LAST_12' : periods[periods.length - 1].value;
        select.value = state.selectedPeriod;
        renderAll();
      }
    });

    document.getElementById('refresh-sheet-btn').addEventListener('click', refreshFromGoogleSheet);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
