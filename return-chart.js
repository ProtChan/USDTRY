// Bonus charts: triple-swap comparison and 1x total-return comparison.
// Every row represents one holding interval starting on that Hirose date. Therefore
// a Thursday triple-swap row also contains the Thursday->Friday FX move on the same x.

state.showMa7 = false;
state.returnChart = null;
state.tripleDayChart = null;

const RETURN_BENCHMARK_USD = 10000;
const ROUND_TRIP_COST_PER_10000_USD = 100;

const maButtonOnLoad = document.getElementById('toggleMa7');
if (maButtonOnLoad) {
  maButtonOnLoad.classList.remove('active');
  maButtonOnLoad.setAttribute('aria-pressed', 'false');
  maButtonOnLoad.textContent = 'MA7 OFF';
}
const maLegendOnLoad = document.getElementById('maLegend');
if (maLegendOnLoad) maLegendOnLoad.classList.add('series-muted');

function utcWeekday(iso) {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

function isThursdayTriple(row) {
  return utcWeekday(row.date) === 4 && Number(row.days || 0) >= 3;
}

function tripleDayRows() {
  if (!state.payload?.data?.length) return [];
  return state.payload.data.filter(row =>
    Number(row.days || 0) === 3 &&
    Number.isFinite(Number(row.sell_yen)) &&
    row.fx_cost_jpy_total != null &&
    Number.isFinite(Number(row.fx_cost_jpy_total))
  );
}

function buildTripleDayChart() {
  const canvas = document.getElementById('tripleDayChart');
  if (!canvas || !state.payload) return;

  const rows = tripleDayRows();
  if (!rows.length) return;

  const labels = rows.map(row => row.date);
  const swapTotals = rows.map(row => Number(row.sell_yen) * scale());
  const fxTotals = rows.map(row => Number(row.fx_cost_jpy_total) * scale());
  const all = [...swapTotals, ...fxTotals].filter(Number.isFinite);
  const rawMin = Math.min(...all, 0);
  const rawMax = Math.max(...all, 0);
  const span = Math.max(rawMax - rawMin, state.qty >= 10000 ? 500 : 50);
  const pad = span * 0.12;
  const step = niceStep((span + pad * 2) / 5);
  const axisMin = rawMin < 0 ? Math.floor((rawMin - pad) / step) * step : 0;
  const axisMax = Math.ceil((rawMax + pad) / step) * step;

  if (state.tripleDayChart) state.tripleDayChart.destroy();
  state.tripleDayChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: '3日スワップ実額',
          data: swapTotals,
          backgroundColor: 'rgba(92,225,167,.72)',
          borderColor: '#5ce1a7',
          borderWidth: 1,
          borderRadius: 5,
          borderSkipped: false,
          maxBarThickness: 28,
        },
        {
          label: '木→金 為替差損',
          data: fxTotals,
          backgroundColor: 'rgba(255,157,122,.70)',
          borderColor: '#ff9d7a',
          borderWidth: 1,
          borderRadius: 5,
          borderSkipped: false,
          maxBarThickness: 28,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          align: 'start',
          labels: {
            color: '#8ea0b6',
            boxWidth: 12,
            boxHeight: 8,
            padding: 14,
            font: { size: 10, weight: '700' },
          },
        },
        tooltip: {
          backgroundColor: '#0b1728',
          borderColor: 'rgba(154,181,211,.18)',
          borderWidth: 1,
          padding: 9,
          displayColors: false,
          filter(item) { return item.datasetIndex === 0; },
          callbacks: {
            title(items) {
              if (!items.length) return '';
              const row = rows[items[0].dataIndex];
              return row.usdtry_next_date
                ? `${jpDate(row.date)} → ${jpDate(row.usdtry_next_date)}`
                : jpDate(row.date);
            },
            label(context) {
              const i = context.dataIndex;
              const swap = swapTotals[i];
              const fx = fxTotals[i];
              const diff = swap - fx;
              const fxLabel = fx < 0 ? '為替差益' : '為替差損';
              return [
                `3日スワップ: ${yen.format(swap)}円`,
                `${fxLabel}: ${yen.format(Math.abs(fx))}円`,
                `差分: ${diff > 0 ? '+' : ''}${yen.format(diff)}円`,
              ];
            },
            beforeBody() { return []; },
            afterBody() { return []; },
            footer() { return ''; },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#71849b',
            maxRotation: 0,
            autoSkip: false,
            padding: 6,
            callback(value) { return shortDate(labels[value]); },
          },
          border: { color: 'rgba(154,181,211,.10)' },
        },
        y: {
          min: axisMin,
          max: axisMax,
          grid: {
            color(ctx) {
              return ctx.tick.value === 0 ? 'rgba(245,248,252,.20)' : 'rgba(154,181,211,.065)';
            },
          },
          ticks: {
            color: '#71849b',
            stepSize: step,
            maxTicksLimit: 6,
            padding: 7,
            callback(value) { return `${yen0.format(value)}円`; },
          },
          border: { display: false },
        },
      },
    },
  });

  const diffs = swapTotals.map((value, i) => value - fxTotals[i]).filter(Number.isFinite);
  const avgSwap = mean(swapTotals);
  const avgFx = mean(fxTotals);
  const avgDiff = mean(diffs);
  const summary = document.getElementById('tripleDaySummary');
  if (summary) {
    summary.textContent = `平均 スワップ ${yen.format(avgSwap)}円 · 為替差損 ${yen.format(avgFx)}円 · 差 ${avgDiff >= 0 ? '+' : ''}${yen.format(avgDiff)}円`;
  }
}

function totalReturnComparison() {
  if (!state.payload?.data?.length) return [];

  const rows = state.payload.data.filter(row =>
    Number.isFinite(Number(row.usdjpy_rep_rate)) &&
    Number.isFinite(Number(row.lot_size || state.payload.meta?.lot_size || 1000))
  );
  if (!rows.length) return [];

  let holdIndex = 100;
  let dodgeIndex = 100;
  const points = [{
    date: rows[0].date,
    holdIndex,
    dodgeIndex,
    holdNetPnlJpy: 0,
    dodgeNetPnlJpy: 0,
    avoidedFx: false,
    skippedTripleSwap: false,
    tradeCostJpy: 0,
    days: 0,
  }];

  rows.forEach(row => {
    const sourceLotUsd = Number(row.lot_size || state.payload.meta?.lot_size || 1000);
    const usdJpy = Number(row.usdjpy_rep_rate);
    const sourceSwapJpy = Number(row.sell_yen);
    const sourceFxCostJpy = row.fx_cost_jpy_total == null ? NaN : Number(row.fx_cost_jpy_total);
    if (!Number.isFinite(sourceLotUsd) || sourceLotUsd <= 0 || !Number.isFinite(usdJpy) || usdJpy <= 0) return;
    if (!Number.isFinite(sourceSwapJpy) || !Number.isFinite(sourceFxCostJpy)) return;

    // Normalize every cash flow to an explicit 10,000 USD benchmark. This leaves the
    // 1x index mathematically unchanged, but keeps the stated round-trip cost at 100 JPY.
    const benchmarkScale = RETURN_BENCHMARK_USD / sourceLotUsd;
    const swapJpy = sourceSwapJpy * benchmarkScale;
    const fxCostJpy = sourceFxCostJpy * benchmarkScale;
    const referenceCapitalJpy = RETURN_BENCHMARK_USD * usdJpy;
    const fxPnlJpy = -fxCostJpy;

    const holdNetPnlJpy = swapJpy + fxPnlJpy;
    holdIndex *= 1 + holdNetPnlJpy / referenceCapitalJpy;

    const skippedTripleSwap = isThursdayTriple(row);
    const avoidedFx = skippedTripleSwap;
    const tradeCostJpy = skippedTripleSwap ? ROUND_TRIP_COST_PER_10000_USD : 0;
    const dodgeSwapJpy = skippedTripleSwap ? 0 : swapJpy;
    const dodgeFxPnlJpy = avoidedFx ? 0 : fxPnlJpy;
    const dodgeNetPnlJpy = dodgeSwapJpy + dodgeFxPnlJpy - tradeCostJpy;
    dodgeIndex *= 1 + dodgeNetPnlJpy / referenceCapitalJpy;

    points.push({
      date: row.date,
      holdIndex,
      dodgeIndex,
      holdNetPnlJpy,
      dodgeNetPnlJpy,
      avoidedFx,
      skippedTripleSwap,
      tradeCostJpy,
      days: Number(row.days || 0),
      intervalEndDate: row.usdtry_next_date || null,
    });
  });

  return points;
}

function returnAxisBounds(values) {
  const xs = values.filter(Number.isFinite);
  if (!xs.length) return { min: 99, max: 101 };
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const span = Math.max(hi - lo, 0.4);
  const pad = span * 0.12;
  return { min: lo - pad, max: hi + pad };
}

function buildReturnChart() {
  const canvas = document.getElementById('returnChart');
  if (!canvas || !state.payload) return;

  const points = totalReturnComparison();
  if (points.length < 2) return;

  const labels = points.map(point => point.date);
  const holdValues = points.map(point => point.holdIndex);
  const dodgeValues = points.map(point => point.dodgeIndex);
  const axis = returnAxisBounds([...holdValues, ...dodgeValues]);

  if (state.returnChart) state.returnChart.destroy();
  state.returnChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '通常ホールド',
          data: holdValues,
          borderColor: '#5ce1a7',
          backgroundColor: 'transparent',
          borderWidth: 2.05,
          pointRadius(ctx) {
            return ctx.dataIndex === holdValues.length - 1 ? 3.4 : 0;
          },
          pointHoverRadius: 4.4,
          pointHitRadius: 12,
          fill: false,
          tension: .22,
          cubicInterpolationMode: 'monotone',
          spanGaps: true,
        },
        {
          label: '木曜決済 → 金曜売り直し',
          data: dodgeValues,
          borderColor: '#71a7ff',
          backgroundColor: 'transparent',
          borderWidth: 2.05,
          pointRadius(ctx) {
            return ctx.dataIndex === dodgeValues.length - 1 ? 3.4 : 0;
          },
          pointHoverRadius: 4.4,
          pointHitRadius: 12,
          fill: false,
          tension: .22,
          cubicInterpolationMode: 'monotone',
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          align: 'start',
          labels: {
            color: '#8ea0b6',
            boxWidth: 18,
            boxHeight: 2,
            padding: 14,
            font: { size: 10, weight: '700' },
          },
        },
        tooltip: {
          backgroundColor: '#0b1728',
          borderColor: 'rgba(154,181,211,.18)',
          borderWidth: 1,
          padding: 9,
          displayColors: false,
          callbacks: {
            title(items) {
              return items.length ? jpDate(labels[items[0].dataIndex]) : '';
            },
            label(context) {
              const value = Number(context.raw);
              const totalPct = value - 100;
              return `${context.dataset.label}: ${value.toFixed(3)} (${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(3)}%)`;
            },
            afterBody(items) {
              if (!items.length) return [];
              const point = points[items[0].dataIndex];
              if (point.skippedTripleSwap) {
                const interval = point.intervalEndDate ? `${jpDate(point.date)}→${jpDate(point.intervalEndDate)}` : '木→金';
                return [
                  `回避戦略: ${interval} FX + 3日分スワップを同時回避`,
                  `売買コスト ${point.tradeCostJpy.toFixed(0)}円 / 10,000 USD`,
                ];
              }
              return [];
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#71849b',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 7,
            padding: 5,
            callback(value) { return shortDate(labels[value]); },
          },
          border: { color: 'rgba(154,181,211,.10)' },
        },
        y: {
          min: axis.min,
          max: axis.max,
          grid: { color: 'rgba(154,181,211,.065)' },
          ticks: {
            color: '#71849b',
            maxTicksLimit: 6,
            padding: 7,
            callback(value) { return Number(value).toFixed(1); },
          },
          border: { display: false },
        },
      },
    },
  });

  const latest = points[points.length - 1];
  const holdPct = latest.holdIndex - 100;
  const dodgePct = latest.dodgeIndex - 100;
  const edgePct = latest.dodgeIndex - latest.holdIndex;
  const summary = document.getElementById('returnSummary');
  if (summary) {
    summary.textContent = `通常 ${holdPct >= 0 ? '+' : ''}${holdPct.toFixed(3)}% · 木→金回避 ${dodgePct >= 0 ? '+' : ''}${dodgePct.toFixed(3)}% · 差 ${edgePct >= 0 ? '+' : ''}${edgePct.toFixed(3)}pt`;
  }
  const baseline = document.getElementById('returnBaseline');
  if (baseline) baseline.textContent = `Index 100 = ${jpDate(points[0].date)} · 1x · 往復100円/1万USD`;
}

const baseRenderForReturn = render;
render = function renderWithBonusCharts() {
  baseRenderForReturn();
  buildTripleDayChart();
  buildReturnChart();
};

if (state.payload) {
  buildChart();
  buildTripleDayChart();
  buildReturnChart();
}
