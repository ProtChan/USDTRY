const state = {
  payload: null,
  qty: 1000,
  range: 'all',
  charts: {},
};

const yen = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });
const yen0 = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });

function finite(value) {
  return value != null && Number.isFinite(Number(value));
}

function mean(values) {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
}

function fmtYen(value, digits = 0) {
  if (!Number.isFinite(value)) return '—';
  return `${digits ? yen.format(value) : yen0.format(value)}円`;
}

function fmtSignedYen(value, digits = 0) {
  if (!Number.isFinite(value)) return '—';
  const body = digits ? yen.format(value) : yen0.format(value);
  return `${value > 0 ? '+' : ''}${body}円`;
}

function jpDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

function shortDate(iso) {
  if (!iso) return '—';
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function scale() {
  return state.qty / Number(state.payload?.meta?.lot_size || 1000);
}

function swapPerDay(row) {
  return finite(row?.sell_yen_per_day) ? Number(row.sell_yen_per_day) * scale() : null;
}

function swapTotal(row) {
  return finite(row?.sell_yen) ? Number(row.sell_yen) * scale() : null;
}

function fxDaily(row) {
  return finite(row?.fx_cost_jpy_per_day) ? Number(row.fx_cost_jpy_per_day) * scale() : null;
}

function fxTotal(row) {
  return finite(row?.fx_cost_jpy_total) ? Number(row.fx_cost_jpy_total) * scale() : null;
}

function fxAvg7(row) {
  return finite(row?.fx_cost_7d_jpy_per_day) ? Number(row.fx_cost_7d_jpy_per_day) * scale() : null;
}

function intervalDays(row) {
  const days = Number(row?.fx_interval_calendar_days || 0);
  return Number.isFinite(days) && days > 0 ? days : 1;
}

// Net bars intentionally do NOT use FX 7AVG and do NOT divide triple swap by Hirose accrual days.
// First align the actual credited swap total with the FX total for the same forward interval,
// then normalize the resulting interval P/L by elapsed calendar days.
function intervalNetTotal(row) {
  const swap = swapTotal(row);
  const fx = fxTotal(row);
  return Number.isFinite(swap) && Number.isFinite(fx) ? swap - fx : null;
}

function alignedSwapPerCalendarDay(row) {
  const swap = swapTotal(row);
  return Number.isFinite(swap) ? swap / intervalDays(row) : null;
}

function alignedFxPerCalendarDay(row) {
  const fx = fxTotal(row);
  return Number.isFinite(fx) ? fx / intervalDays(row) : null;
}

function netPerCalendarDay(row) {
  const net = intervalNetTotal(row);
  return Number.isFinite(net) ? net / intervalDays(row) : null;
}

function allRows() {
  return state.payload?.data || [];
}

function confirmedRows() {
  return allRows().filter(row => Number.isFinite(intervalNetTotal(row)));
}

function visibleConfirmedRows() {
  const rows = confirmedRows();
  return state.range === 'all' ? rows : rows.slice(-Number(state.range));
}

function latestSwapRow() {
  const rows = allRows().filter(row => finite(row.sell_yen_per_day));
  return rows[rows.length - 1] || null;
}

function latestConfirmedRow() {
  const rows = confirmedRows();
  return rows[rows.length - 1] || null;
}

function niceStep(target) {
  if (!Number.isFinite(target) || target <= 0) return 10;
  const power = 10 ** Math.floor(Math.log10(target));
  const scaled = target / power;
  const factor = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return factor * power;
}

function axisBounds(values, includeZero = false) {
  const xs = values.filter(Number.isFinite);
  if (includeZero) xs.push(0);
  if (!xs.length) return { min: -1, max: 1, step: 1 };
  const rawMin = Math.min(...xs);
  const rawMax = Math.max(...xs);
  const minSpan = state.qty >= 10000 ? 300 : 30;
  const span = Math.max(rawMax - rawMin, minSpan);
  const step = niceStep(span / 5);
  const pad = step * .65;
  const min = Math.floor((rawMin - pad) / step) * step;
  const max = Math.ceil((rawMax + pad) / step) * step;
  return { min, max: max > min ? max : min + step, step };
}

function returnAxisBounds(values) {
  const xs = values.filter(Number.isFinite);
  if (!xs.length) return { min: 99.5, max: 100.5 };
  const rawMin = Math.min(...xs);
  const rawMax = Math.max(...xs);
  const span = Math.max(rawMax - rawMin, 0.35);
  const pad = span * .14;
  return { min: rawMin - pad, max: rawMax + pad };
}

function destroyChart(name) {
  if (state.charts[name]) state.charts[name].destroy();
  state.charts[name] = null;
}

function setTone(el, value) {
  if (!el) return;
  el.classList.remove('positive', 'negative', 'neutral');
  el.classList.add(!Number.isFinite(value) || Math.abs(value) < .005 ? 'neutral' : value > 0 ? 'positive' : 'negative');
}

function syncUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('qty', String(state.qty));
  url.searchParams.set('range', state.range);
  history.replaceState(null, '', url);
}

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const qty = Number(params.get('qty'));
  if (qty === 1000 || qty === 10000) state.qty = qty;
  const range = params.get('range');
  if (range === '30' || range === 'all') state.range = range;
}

function syncControls() {
  document.querySelectorAll('.qty-btn').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.qty) === state.qty);
  });
  document.querySelectorAll('.range-btn').forEach(button => {
    button.classList.toggle('active', button.dataset.range === state.range);
  });
}

function monthlyNetEstimate() {
  const rows = confirmedRows();
  if (!rows.length) return null;
  const latest = rows[rows.length - 1];
  const end = new Date(`${latest.usdtry_next_date || latest.date}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);

  const recent = rows.filter(row => {
    const d = new Date(`${row.date}T00:00:00Z`);
    return d >= start && d <= end;
  });
  if (!recent.length) return null;
  const totalNet = recent.map(intervalNetTotal).filter(Number.isFinite).reduce((a, b) => a + b, 0);
  const totalDays = recent.reduce((sum, row) => sum + intervalDays(row), 0);
  return totalDays > 0 ? (totalNet / totalDays) * 30 : null;
}

function updateOverview() {
  const latest = latestSwapRow();
  if (!latest) return;

  const swap = swapPerDay(latest);
  document.getElementById('latestSwap').innerHTML = `${yen.format(swap)}<small>円 / 日</small>`;
  document.getElementById('latestSwapMeta').textContent = `${jpDate(latest.date)} · ${Number(latest.days || 0)}日分付与 · ${state.qty.toLocaleString('ja-JP')} USD`;
  document.getElementById('latestSwapTotal').textContent = fmtYen(swapTotal(latest), 2);
  document.getElementById('latestSwapPoints').textContent = finite(latest.sell_points) ? yen.format(Number(latest.sell_points)) : '—';

  const swaps = allRows().map(swapPerDay).filter(Number.isFinite);
  const avg7 = mean(swaps.slice(-7));
  const avg30 = mean(swaps.slice(-30));
  document.getElementById('swapAvg7').innerHTML = `${yen.format(avg7)}<small>円/日</small>`;
  document.getElementById('swapAvg30').innerHTML = `${yen.format(avg30)}<small>円/日</small>`;

  const latestNetRow = latestConfirmedRow();
  const latestNetValue = latestNetRow ? netPerCalendarDay(latestNetRow) : null;
  const latestNetEl = document.getElementById('latestNet');
  latestNetEl.innerHTML = Number.isFinite(latestNetValue)
    ? `${latestNetValue > 0 ? '+' : ''}${yen.format(latestNetValue)}<small>円/日</small>`
    : '—';
  setTone(latestNetEl, latestNetValue);
  document.getElementById('latestNetMeta').textContent = latestNetRow
    ? `${jpDate(latestNetRow.date)}${latestNetRow.usdtry_next_date ? ` → ${jpDate(latestNetRow.usdtry_next_date)}` : ''} · 実付与ベース`
    : '確定区間なし';

  const estimate = monthlyNetEstimate();
  const estimateEl = document.getElementById('net30Estimate');
  estimateEl.innerHTML = Number.isFinite(estimate)
    ? `${estimate > 0 ? '+' : ''}${yen0.format(estimate)}<small>円/30日</small>`
    : '—';
  setTone(estimateEl, estimate);

  buildSwapSpark(allRows().filter(row => finite(row.sell_yen_per_day)).slice(-18));
}

function buildSwapSpark(rows) {
  destroyChart('spark');
  const values = rows.map(swapPerDay);
  state.charts.spark = new Chart(document.getElementById('swapSpark'), {
    type: 'line',
    data: {
      labels: rows.map(row => row.date),
      datasets: [{
        data: values,
        borderColor: '#62e6ad',
        backgroundColor: 'rgba(98,230,173,.07)',
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: .25,
        spanGaps: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
    },
  });
}

function updateFreshness() {
  const meta = state.payload.meta || {};
  const latest = latestSwapRow();
  const confirmed = latestConfirmedRow();
  const badge = document.getElementById('statusBadge');
  badge.textContent = 'LIVE DATA';
  badge.className = 'status-badge ok';

  const fxComplete = latest && finite(latest.fx_cost_jpy_total);
  document.getElementById('freshnessHeadline').textContent = fxComplete
    ? '最新スワップとFX区間が確定済み'
    : '最新スワップ取得済み · FXは次回固定レート待ち';
  document.getElementById('freshnessDetail').textContent = confirmed
    ? `直近確定ネット区間: ${jpDate(confirmed.date)}${confirmed.usdtry_next_date ? ` → ${jpDate(confirmed.usdtry_next_date)}` : ''}`
    : 'ネット損益の確定区間はまだありません';
  document.getElementById('freshSwapDate').textContent = latest ? jpDate(latest.date) : '—';
  document.getElementById('freshFxStatus').textContent = fxComplete ? '最新まで確定' : 'NEXT RATE待ち';

  let generated = '—';
  if (meta.generated_at) {
    const date = new Date(meta.generated_at);
    if (!Number.isNaN(date.getTime())) {
      generated = date.toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    }
  }
  document.getElementById('freshGenerated').textContent = generated;
  document.getElementById('footerGenerated').textContent = `Generated ${generated}`;
}

function buildNetChart() {
  destroyChart('net');
  const rows = visibleConfirmedRows();
  const labels = rows.map(row => row.date);
  const values = rows.map(netPerCalendarDay);
  const axis = axisBounds(values, true);

  state.charts.net = new Chart(document.getElementById('netChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'ネット日次損益',
        data: values,
        backgroundColor(context) {
          return Number(context.raw) >= 0 ? 'rgba(98,230,173,.72)' : 'rgba(255,136,150,.72)';
        },
        borderColor(context) {
          return Number(context.raw) >= 0 ? '#62e6ad' : '#ff8896';
        },
        borderWidth: 1,
        borderRadius: 4,
        borderSkipped: false,
        maxBarThickness: 22,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0b1728',
          borderColor: 'rgba(148,171,201,.20)',
          borderWidth: 1,
          padding: 10,
          displayColors: false,
          callbacks: {
            title(items) {
              if (!items.length) return '';
              const row = rows[items[0].dataIndex];
              return row.usdtry_next_date ? `${jpDate(row.date)} → ${jpDate(row.usdtry_next_date)}` : jpDate(row.date);
            },
            label(context) {
              const row = rows[context.dataIndex];
              const swap = swapTotal(row);
              const fx = fxTotal(row);
              const net = intervalNetTotal(row);
              const days = intervalDays(row);
              return [
                `実付与スワップ: ${fmtYen(swap, 2)}`,
                `${fx < 0 ? '為替差益' : '為替差損'}: ${fmtYen(Math.abs(fx), 2)}`,
                `区間ネット: ${fmtSignedYen(net, 2)}`,
                `日次換算 (${days}暦日): ${fmtSignedYen(net / days, 2)} / 日`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#677c93',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 9,
            callback(value) { return shortDate(labels[value]); },
          },
          border: { color: 'rgba(148,171,201,.10)' },
        },
        y: {
          min: axis.min,
          max: axis.max,
          grid: {
            color(context) { return context.tick.value === 0 ? 'rgba(244,247,251,.24)' : 'rgba(148,171,201,.06)'; },
          },
          ticks: {
            color: '#677c93',
            stepSize: axis.step,
            maxTicksLimit: 7,
            callback(value) { return `${yen0.format(value)}円`; },
          },
          border: { display: false },
        },
      },
    },
  });

  const avg = mean(values);
  const positives = values.filter(value => Number.isFinite(value) && value > 0).length;
  const total = rows.map(intervalNetTotal).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
  const boxes = document.querySelectorAll('#netSummary b');
  boxes[0].textContent = fmtSignedYen(avg, 2);
  boxes[1].textContent = `${positives} / ${values.length}`;
  boxes[2].textContent = fmtSignedYen(total, 0);
  setTone(boxes[0], avg);
  setTone(boxes[2], total);
}

function buildCarryChart() {
  destroyChart('carry');
  const rows = allRows();
  const labels = rows.map(row => row.date);
  const swap = rows.map(swapPerDay);
  const fx = rows.map(fxAvg7);
  const axis = axisBounds([...swap, ...fx], false);

  state.charts.carry = new Chart(document.getElementById('carryChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'スワップ / 日', data: swap, borderColor: '#62e6ad', backgroundColor: 'transparent',
          borderWidth: 2.1, pointRadius: 0, pointHoverRadius: 4, tension: .22, spanGaps: true,
        },
        {
          label: '為替差損 7AVG', data: fx, borderColor: '#ff9e7c', backgroundColor: 'transparent',
          borderWidth: 2.1, pointRadius: 0, pointHoverRadius: 4, tension: .30, cubicInterpolationMode: 'monotone', spanGaps: true,
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
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0b1728', borderColor: 'rgba(148,171,201,.20)', borderWidth: 1, padding: 10, displayColors: false,
          callbacks: {
            title(items) { return items.length ? jpDate(labels[items[0].dataIndex]) : ''; },
            label(context) {
              if (context.datasetIndex !== 0) return '';
              const i = context.dataIndex;
              const diff = Number.isFinite(swap[i]) && Number.isFinite(fx[i]) ? swap[i] - fx[i] : null;
              return [
                `スワップ: ${Number.isFinite(swap[i]) ? fmtYen(swap[i], 2) + ' / 日' : '—'}`,
                `為替差損 7AVG: ${Number.isFinite(fx[i]) ? fmtYen(fx[i], 2) + ' / 日' : '—'}`,
                `差分: ${Number.isFinite(diff) ? fmtSignedYen(diff, 2) + ' / 日' : '—'}`,
              ];
            },
          },
          filter(item) { return item.datasetIndex === 0; },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#677c93', maxRotation: 0, autoSkip: true, maxTicksLimit: 8, callback(value) { return shortDate(labels[value]); } },
          border: { color: 'rgba(148,171,201,.10)' },
        },
        y: {
          min: axis.min, max: axis.max,
          grid: { color: 'rgba(148,171,201,.06)' },
          ticks: { color: '#677c93', stepSize: axis.step, maxTicksLimit: 7, callback(value) { return `${yen0.format(value)}円`; } },
          border: { display: false },
        },
      },
    },
  });

  const row = latestConfirmedRow();
  if (!row) return;
  const swapValue = alignedSwapPerCalendarDay(row);
  const fxValue = alignedFxPerCalendarDay(row);
  const netValue = netPerCalendarDay(row);
  document.getElementById('decompDate').textContent = row.usdtry_next_date
    ? `${jpDate(row.date)} → ${jpDate(row.usdtry_next_date)}`
    : jpDate(row.date);
  document.getElementById('decompSwap').textContent = `+${fmtYen(swapValue, 2)}`;
  document.getElementById('decompFx').textContent = `${fxValue >= 0 ? '−' : '+'}${fmtYen(Math.abs(fxValue), 2)}`;
  const netEl = document.getElementById('decompNet');
  netEl.textContent = fmtSignedYen(netValue, 2);
  setTone(netEl, netValue);
  document.getElementById('decompNote').textContent = `実付与総額と同区間FXを先に相殺し、${intervalDays(row)}暦日で日次化。7AVGは使いません。`;
}

function tripleRows() {
  return allRows().filter(row => Number(row.days || 0) === 3 && Number.isFinite(swapTotal(row)) && Number.isFinite(fxTotal(row)));
}

function buildTripleChart() {
  destroyChart('triple');
  const rows = tripleRows();
  const labels = rows.map(row => row.date);
  const swaps = rows.map(swapTotal);
  const fx = rows.map(fxTotal);
  const axis = axisBounds([...swaps, ...fx], true);

  state.charts.triple = new Chart(document.getElementById('tripleChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: '3日スワップ実額', data: swaps, backgroundColor: 'rgba(98,230,173,.72)', borderColor: '#62e6ad', borderWidth: 1, borderRadius: 5, borderSkipped: false, maxBarThickness: 27 },
        { label: '木→金 為替差損', data: fx, backgroundColor: 'rgba(255,158,124,.70)', borderColor: '#ff9e7c', borderWidth: 1, borderRadius: 5, borderSkipped: false, maxBarThickness: 27 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, align: 'start', labels: { color: '#8397ad', boxWidth: 12, boxHeight: 8, padding: 13, font: { size: 10, weight: '700' } } },
        tooltip: {
          backgroundColor: '#0b1728', borderColor: 'rgba(148,171,201,.20)', borderWidth: 1, padding: 10, displayColors: false,
          callbacks: {
            title(items) {
              if (!items.length) return '';
              const row = rows[items[0].dataIndex];
              return row.usdtry_next_date ? `${jpDate(row.date)} → ${jpDate(row.usdtry_next_date)}` : jpDate(row.date);
            },
            label(context) {
              if (context.datasetIndex !== 0) return '';
              const i = context.dataIndex;
              const diff = swaps[i] - fx[i];
              return [
                `3日スワップ: ${fmtYen(swaps[i], 0)}`,
                `${fx[i] < 0 ? '為替差益' : '為替差損'}: ${fmtYen(Math.abs(fx[i]), 0)}`,
                `差分: ${fmtSignedYen(diff, 0)}`,
              ];
            },
          },
          filter(item) { return item.datasetIndex === 0; },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#677c93', maxRotation: 0, autoSkip: false, callback(value) { return shortDate(labels[value]); } }, border: { color: 'rgba(148,171,201,.10)' } },
        y: { min: axis.min, max: axis.max, grid: { color: 'rgba(148,171,201,.06)' }, ticks: { color: '#677c93', stepSize: axis.step, maxTicksLimit: 7, callback(value) { return `${yen0.format(value)}円`; } }, border: { display: false } },
      },
    },
  });

  const diffs = swaps.map((value, index) => value - fx[index]);
  const wins = diffs.filter(value => value > 0).length;
  const boxes = document.querySelectorAll('#tripleSummary b');
  boxes[0].textContent = `${wins} / ${diffs.length}`;
  boxes[1].textContent = fmtYen(mean(swaps), 0);
  boxes[2].textContent = fmtYen(mean(fx), 0);
  boxes[3].textContent = fmtSignedYen(mean(diffs), 0);
  setTone(boxes[3], mean(diffs));
}

function isThursdayTriple(row) {
  if (Number(row.days || 0) < 3) return false;
  return new Date(`${row.date}T12:00:00Z`).getUTCDay() === 4;
}

function totalReturnSeries() {
  const rows = allRows().filter(row => finite(row.usdjpy_rep_rate) && finite(row.sell_yen) && finite(row.fx_cost_jpy_total));
  if (!rows.length) return [];

  const notional = 10000;
  const roundTripCost = 100;
  let hold = 100;
  let dodge = 100;
  const points = [{ date: rows[0].date, hold, dodge, triple: false, intervalEnd: null }];

  rows.forEach(row => {
    const baseLot = Number(row.lot_size || state.payload.meta?.lot_size || 1000);
    const factor = notional / baseLot;
    const usdJpy = Number(row.usdjpy_rep_rate);
    const swap = Number(row.sell_yen) * factor;
    const fxCost = Number(row.fx_cost_jpy_total) * factor;
    const capital = notional * usdJpy;
    const triple = isThursdayTriple(row);

    hold *= 1 + (swap - fxCost) / capital;
    const dodgeNet = triple ? -roundTripCost : swap - fxCost;
    dodge *= 1 + dodgeNet / capital;
    points.push({
      date: row.usdtry_next_date || row.date,
      hold,
      dodge,
      triple,
      intervalStart: row.date,
      intervalEnd: row.usdtry_next_date || null,
    });
  });
  return points;
}

function buildReturnChart() {
  destroyChart('return');
  const points = totalReturnSeries();
  if (points.length < 2) return;
  const labels = points.map(point => point.date);
  const hold = points.map(point => point.hold);
  const dodge = points.map(point => point.dodge);
  const axis = returnAxisBounds([...hold, ...dodge]);

  state.charts.return = new Chart(document.getElementById('returnChartBeta'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '通常ホールド', data: hold, borderColor: '#62e6ad', backgroundColor: 'transparent', borderWidth: 2.1, pointRadius: 0, pointHoverRadius: 4, tension: .22, cubicInterpolationMode: 'monotone' },
        { label: '木曜回避', data: dodge, borderColor: '#78a9ff', backgroundColor: 'transparent', borderWidth: 2.1, pointRadius: 0, pointHoverRadius: 4, tension: .22, cubicInterpolationMode: 'monotone' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0b1728', borderColor: 'rgba(148,171,201,.20)', borderWidth: 1, padding: 10, displayColors: false,
          callbacks: {
            title(items) { return items.length ? jpDate(labels[items[0].dataIndex]) : ''; },
            label(context) {
              const value = Number(context.raw);
              return `${context.dataset.label}: ${value.toFixed(3)} (${value - 100 >= 0 ? '+' : ''}${(value - 100).toFixed(3)}%)`;
            },
            afterBody(items) {
              if (!items.length) return [];
              const point = points[items[0].dataIndex];
              if (!point?.triple) return [];
              const interval = point.intervalStart && point.intervalEnd
                ? `${jpDate(point.intervalStart)} → ${jpDate(point.intervalEnd)}`
                : '木→金';
              return [`${interval}: 3日スワップ + 木→金FXを回避`, `往復コスト: 100円 / 10,000 USD`];
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#677c93', maxRotation: 0, autoSkip: true, maxTicksLimit: 8, callback(value) { return shortDate(labels[value]); } }, border: { color: 'rgba(148,171,201,.10)' } },
        y: { min: axis.min, max: axis.max, grid: { color: 'rgba(148,171,201,.06)' }, ticks: { color: '#677c93', maxTicksLimit: 7, callback(value) { return Number(value).toFixed(2); } }, border: { display: false } },
      },
    },
  });

  const latest = points[points.length - 1];
  const holdPct = latest.hold - 100;
  const dodgePct = latest.dodge - 100;
  const edge = latest.dodge - latest.hold;
  const boxes = document.querySelectorAll('#returnSummaryBeta b');
  boxes[0].textContent = `${holdPct >= 0 ? '+' : ''}${holdPct.toFixed(3)}%`;
  boxes[1].textContent = `${dodgePct >= 0 ? '+' : ''}${dodgePct.toFixed(3)}%`;
  boxes[2].textContent = `${edge >= 0 ? '+' : ''}${edge.toFixed(3)}pt`;
  setTone(boxes[0], holdPct);
  setTone(boxes[1], dodgePct);
  setTone(boxes[2], edge);
}

function updateRecentCards() {
  const target = document.getElementById('recentCards');
  const rows = [...allRows()].reverse().slice(0, 12);
  target.innerHTML = rows.map(row => {
    const swap = swapPerDay(row);
    const fx = alignedFxPerCalendarDay(row);
    const net = netPerCalendarDay(row);
    const dayClass = Number(row.days || 0) >= 3 ? 'day-pill triple' : 'day-pill';
    const netClass = !Number.isFinite(net) ? 'neutral' : net > 0 ? 'positive' : net < 0 ? 'negative' : 'neutral';
    return `
      <article class="data-card card">
        <div class="data-card-head">
          <a class="data-card-date source-link" href="${row.source_url}" target="_blank" rel="noreferrer">${jpDate(row.date)}</a>
          <span class="${dayClass}">${Number(row.days || 0)}D</span>
        </div>
        <div class="data-values">
          <div><span>SWAP / DAY</span><b>${Number.isFinite(swap) ? fmtYen(swap, 2) : '—'}</b></div>
          <div><span>SWAP TOTAL</span><b>${Number.isFinite(swapTotal(row)) ? fmtYen(swapTotal(row), 2) : '—'}</b></div>
          <div><span>FX / CAL DAY</span><b>${Number.isFinite(fx) ? fmtYen(fx, 2) : '未確定'}</b></div>
          <div><span>NET / CAL DAY</span><b class="${netClass}">${Number.isFinite(net) ? fmtSignedYen(net, 2) : '—'}</b></div>
        </div>
      </article>`;
  }).join('');
}

function updateNetSectionCopy() {
  const section = document.getElementById('net');
  if (!section) return;
  const heading = section.querySelector('h2');
  const copy = section.querySelector('.section-head p');
  if (heading) heading.textContent = 'ネット日次損益';
  if (copy) copy.textContent = '7AVGは使わず、各ヒロセ行の実付与スワップ総額と同じ固定レート区間のFX損益を先に相殺し、その区間の実暦日数で日次化します。3倍日は3日分スワップを1/3にせず、木→金FXと総額同士で比較します。';
}

function renderAll() {
  syncControls();
  updateNetSectionCopy();
  updateOverview();
  updateFreshness();
  buildNetChart();
  buildCarryChart();
  buildTripleChart();
  buildReturnChart();
  updateRecentCards();
}

function bindControls() {
  document.querySelectorAll('.qty-btn').forEach(button => {
    button.addEventListener('click', () => {
      state.qty = Number(button.dataset.qty);
      syncUrl();
      renderAll();
    });
  });
  document.querySelectorAll('.range-btn').forEach(button => {
    button.addEventListener('click', () => {
      state.range = button.dataset.range;
      syncUrl();
      renderAll();
    });
  });
}

async function init() {
  readUrlState();
  bindControls();
  syncControls();
  try {
    const response = await fetch(`../data/usdtry.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.payload = await response.json();
    renderAll();
  } catch (error) {
    console.error(error);
    const badge = document.getElementById('statusBadge');
    badge.textContent = 'DATA ERROR';
    badge.className = 'status-badge error';
    document.getElementById('freshnessHeadline').textContent = 'データ取得に失敗しました';
    document.getElementById('freshnessDetail').textContent = String(error?.message || error);
  }
}

init();