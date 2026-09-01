// Bonus total-return comparison for a 1x USD/TRY short with Hirose sell swap included.
// Every row now represents one holding interval starting on that Hirose date. Therefore
// a Thursday triple-swap row also contains the Thursday->Friday FX move on the same x.

state.showMa7 = false;
state.returnChart = null;

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
    const lotUsd = Number(row.lot_size || state.payload.meta?.lot_size || 1000);
    const usdJpy = Number(row.usdjpy_rep_rate);
    const swapJpy = Number(row.sell_yen);
    const fxCostJpy = Number(row.fx_cost_jpy_total);
    if (!Number.isFinite(lotUsd) || lotUsd <= 0 || !Number.isFinite(usdJpy) || usdJpy <= 0) return;
    if (!Number.isFinite(swapJpy) || !Number.isFinite(fxCostJpy)) return;

    const referenceCapitalJpy = lotUsd * usdJpy;
    const fxPnlJpy = -fxCostJpy;

    // Normal 1x short: same Hirose row = credited swap + that row's forward FX move.
    const holdNetPnlJpy = swapJpy + fxPnlJpy;
    holdIndex *= 1 + holdNetPnlJpy / referenceCapitalJpy;

    // Thursday -> Friday dodge: on a Thursday carrying 3+ days of swap, close before
    // the rollover and re-enter after the Thu->Fri move. Because FX is now aligned to
    // the Thursday row, both the triple swap and Thu->Fri FX move are skipped HERE.
    const skippedTripleSwap = isThursdayTriple(row);
    const avoidedFx = skippedTripleSwap;
    const tradeCostJpy = skippedTripleSwap
      ? (lotUsd / 10000) * ROUND_TRIP_COST_PER_10000_USD
      : 0;
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
                return [`回避戦略: ${interval} FX + 3日分スワップを同時回避`, `売買コスト ${point.tradeCostJpy.toFixed(0)}円`];
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
render = function renderWithReturnChart() {
  baseRenderForReturn();
  buildReturnChart();
};

if (state.payload) {
  buildChart();
  buildReturnChart();
}
