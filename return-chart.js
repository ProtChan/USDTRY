// Bonus total-return chart for a 1x USD/TRY short with Hirose sell swap included.
// Uses actual credited swap totals, so multi-day accrual rows are reflected in full.

state.showMa7 = false;
state.returnChart = null;

const maButtonOnLoad = document.getElementById('toggleMa7');
if (maButtonOnLoad) {
  maButtonOnLoad.classList.remove('active');
  maButtonOnLoad.setAttribute('aria-pressed', 'false');
  maButtonOnLoad.textContent = 'MA7 OFF';
}
const maLegendOnLoad = document.getElementById('maLegend');
if (maLegendOnLoad) maLegendOnLoad.classList.add('series-muted');

function totalReturnSeries() {
  if (!state.payload?.data?.length) return [];

  const rows = state.payload.data.filter(row =>
    Number.isFinite(Number(row.usdjpy_rep_rate)) &&
    Number.isFinite(Number(row.lot_size || state.payload.meta?.lot_size || 1000))
  );
  if (!rows.length) return [];

  let index = 100;
  const first = rows[0];
  const baselineDate = first.usdtry_prev_date || first.date;
  const points = [{
    date: baselineDate,
    index,
    periodReturnPct: 0,
    swapJpy: 0,
    fxPnlJpy: 0,
    netPnlJpy: 0,
    days: 0,
  }];

  for (const row of rows) {
    const lotUsd = Number(row.lot_size || state.payload.meta?.lot_size || 1000);
    const usdJpy = Number(row.usdjpy_rep_rate);
    const swapJpy = Number(row.sell_yen);
    const fxCostJpy = Number(row.fx_cost_jpy_total);
    if (!Number.isFinite(lotUsd) || lotUsd <= 0 || !Number.isFinite(usdJpy) || usdJpy <= 0) continue;
    if (!Number.isFinite(swapJpy) || !Number.isFinite(fxCostJpy)) continue;

    // 1x reference capital is the JPY value of the USD notional. The return is
    // compounded observation by observation, equivalent to rebalancing back to 1x.
    const referenceCapitalJpy = lotUsd * usdJpy;
    const fxPnlJpy = -fxCostJpy;
    const netPnlJpy = swapJpy + fxPnlJpy;
    const periodReturn = netPnlJpy / referenceCapitalJpy;
    index *= 1 + periodReturn;

    points.push({
      date: row.date,
      index,
      periodReturnPct: periodReturn * 100,
      swapJpy,
      fxPnlJpy,
      netPnlJpy,
      days: Number(row.days || 0),
    });
  }

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

  const points = totalReturnSeries();
  if (points.length < 2) return;

  const labels = points.map(point => point.date);
  const values = points.map(point => point.index);
  const axis = returnAxisBounds(values);

  if (state.returnChart) state.returnChart.destroy();
  state.returnChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '1x Total Return Index',
        data: values,
        borderColor: '#5ce1a7',
        backgroundColor: 'rgba(92,225,167,.045)',
        borderWidth: 2.15,
        pointRadius(ctx) {
          return ctx.dataIndex === values.length - 1 ? 3.5 : 0;
        },
        pointHoverRadius: 4.5,
        pointHitRadius: 12,
        fill: true,
        tension: .22,
        cubicInterpolationMode: 'monotone',
        spanGaps: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
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
              const point = points[context.dataIndex];
              const totalPct = point.index - 100;
              return [
                `Index: ${point.index.toFixed(3)}`,
                `累計: ${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(3)}%`,
              ];
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
  const summary = document.getElementById('returnSummary');
  if (summary) {
    const totalPct = latest.index - 100;
    summary.textContent = `現在 ${latest.index.toFixed(3)} · ${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(3)}%`;
  }
  const baseline = document.getElementById('returnBaseline');
  if (baseline) baseline.textContent = `Index 100 = ${jpDate(points[0].date)} · 1x`;
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
