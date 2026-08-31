// Chart-focused enhancements layered on top of app.js.
// Default FX view uses a smooth rolling 7-calendar-day deterioration rate.

state.fxMode = state.fxMode || 'avg7';

function fxSeriesRaw() {
  return state.payload.data.map(scaledFxCost);
}

function fxSeriesRolling7() {
  const rows = state.payload.data;

  return rows.map((row, index) => {
    const currentRate = Number(row.usdtry_rep_rate);
    const usdJpy = Number(row.usdjpy_rep_rate);
    if (!Number.isFinite(currentRate) || !Number.isFinite(usdJpy)) return null;

    const target = new Date(`${row.date}T00:00:00Z`);
    target.setUTCDate(target.getUTCDate() - 7);
    const targetMs = target.getTime();

    let reference = null;
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = rows[i];
      const candidateRate = Number(candidate.usdtry_rep_rate);
      if (!Number.isFinite(candidateRate)) continue;
      const candidateMs = new Date(`${candidate.date}T00:00:00Z`).getTime();
      if (candidateMs <= targetMs) {
        reference = candidate;
        break;
      }
    }

    if (!reference) return null;
    const referenceRate = Number(reference.usdtry_rep_rate);
    if (!Number.isFinite(referenceRate) || referenceRate <= 0) return null;

    const sevenDayChange = currentRate / referenceRate - 1;
    return state.qty * usdJpy * (sevenDayChange / 7);
  });
}

function selectedFxSeries() {
  return state.fxMode === 'avg7' ? fxSeriesRolling7() : fxSeriesRaw();
}

function visibleAxisBounds(series) {
  const values = series.flat().filter(Number.isFinite);
  if (!values.length) return { min: 0, max: 1, step: 1 };

  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const floorSpan = state.qty >= 10000 ? 100 : 10;
  const span = Math.max(rawMax - rawMin, floorSpan);
  const padding = span * 0.10;
  const step = niceStep((span + padding * 2) / 5);
  const min = Math.floor((rawMin - padding) / step) * step;
  const max = Math.ceil((rawMax + padding) / step) * step;
  return { min, max: max > min ? max : min + step, step };
}

function updateFxModeUi() {
  const button = document.getElementById('toggleFxMode');
  if (!button) return;
  const avg = state.fxMode === 'avg7';
  button.textContent = avg ? 'FX 7AVG' : 'FX DAILY';
  button.classList.toggle('active', avg);
  button.setAttribute('aria-pressed', String(avg));
  const legend = document.getElementById('fxLegendText');
  if (legend) legend.textContent = avg ? '為替差損 7日平均' : '為替差損 / 日';
}

buildChart = function buildChartEnhanced() {
  const canvas = document.getElementById('swapChart');
  const allRows = state.payload.data;
  const rows = visibleRows();
  const labels = rows.map(row => row.date);
  const startIndex = Math.max(0, allRows.length - rows.length);

  const allSwap = allRows.map(scaledPerDay);
  const swap = allSwap.slice(startIndex);
  const ma7 = movingAverage(allSwap, 7).slice(startIndex);
  const allFx = selectedFxSeries();
  const fx = allFx.slice(startIndex);
  const multiDay = rows.map(row => row.days >= 2 ? scaledPerDay(row) : null);

  const axisSeries = [swap, fx];
  if (state.showMa7) axisSeries.push(ma7);
  const axis = visibleAxisBounds(axisSeries);

  setCompactChartHeight();
  if (state.chart) state.chart.destroy();

  state.chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'スワップ / 日',
          data: swap,
          borderColor: '#5ce1a7',
          backgroundColor: 'rgba(92,225,167,.035)',
          pointBackgroundColor: '#5ce1a7',
          pointBorderColor: '#07111f',
          pointBorderWidth: 2,
          pointRadius(ctx) {
            return ctx.dataIndex === rows.length - 1 && Number.isFinite(swap[ctx.dataIndex]) ? 3.6 : 0;
          },
          pointHoverRadius: 4.5,
          pointHitRadius: 14,
          borderWidth: 2,
          fill: true,
          tension: .18,
          spanGaps: true,
        },
        {
          label: '7回移動平均',
          data: ma7,
          borderColor: '#71a7ff',
          pointRadius: 0,
          pointHoverRadius: 0,
          borderDash: [5, 4],
          borderWidth: 1.45,
          tension: .2,
          fill: false,
          spanGaps: true,
          hidden: !state.showMa7,
        },
        {
          label: state.fxMode === 'avg7' ? '為替差損 7日平均' : '為替差損 / 日',
          data: fx,
          borderColor: '#ff9d7a',
          backgroundColor: 'transparent',
          pointRadius: 0,
          pointHoverRadius: 0,
          pointHitRadius: 0,
          borderWidth: state.fxMode === 'avg7' ? 2.15 : 1.75,
          tension: state.fxMode === 'avg7' ? .30 : .16,
          cubicInterpolationMode: state.fxMode === 'avg7' ? 'monotone' : 'default',
          fill: false,
          spanGaps: true,
        },
        {
          label: '複数日付与',
          data: multiDay,
          showLine: false,
          pointRadius: 4.1,
          pointHoverRadius: 4.1,
          pointHitRadius: 0,
          pointBackgroundColor: '#f6c56d',
          pointBorderColor: '#07111f',
          pointBorderWidth: 1.7,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      resizeDelay: 120,
      normalized: true,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'nearest',
          axis: 'x',
          intersect: false,
          position: 'nearest',
          backgroundColor: '#0b1728',
          borderColor: 'rgba(154,181,211,.18)',
          borderWidth: 1,
          padding: 9,
          displayColors: false,
          titleMarginBottom: 6,
          bodySpacing: 2,
          filter(item) { return item.datasetIndex === 0; },
          callbacks: {
            title(items) {
              return items.length ? jpDate(labels[items[0].dataIndex]) : '';
            },
            label(context) {
              const i = context.dataIndex;
              const swapValue = swap[i];
              const fxValue = fx[i];
              const diff = Number.isFinite(swapValue) && Number.isFinite(fxValue) ? swapValue - fxValue : null;
              const fxLabel = Number.isFinite(fxValue) && fxValue < 0 ? '為替差益' : '為替差損';
              return [
                `スワップ: ${Number.isFinite(swapValue) ? yen.format(swapValue) + '円/日' : '—'}`,
                `${fxLabel}: ${Number.isFinite(fxValue) ? yen.format(Math.abs(fxValue)) + '円/日' : '—'}`,
                `差分: ${Number.isFinite(diff) ? (diff > 0 ? '+' : '') + yen.format(diff) + '円/日' : '—'}`,
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
            stepSize: axis.step,
            maxTicksLimit: 6,
            padding: 7,
            callback(value) { return `${yen0.format(value)}円`; },
          },
          border: { display: false },
        },
      },
    },
  });

  const first = rows[0]?.date || state.payload.meta.start_date;
  const last = rows[rows.length - 1]?.date || state.payload.meta.latest_date;
  const mode = state.fxMode === 'avg7' ? 'FX 7日平均' : 'FX 日次';
  document.getElementById('rangeLabel').textContent = `${jpDate(first)} — ${jpDate(last)} · ${mode}`;
  updateFxModeUi();
};

const fxModeButton = document.getElementById('toggleFxMode');
if (fxModeButton) {
  fxModeButton.addEventListener('click', () => {
    state.fxMode = state.fxMode === 'avg7' ? 'daily' : 'avg7';
    updateFxModeUi();
    if (state.payload) buildChart();
  });
}

updateFxModeUi();
if (state.payload) buildChart();