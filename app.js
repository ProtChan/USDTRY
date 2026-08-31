const state = {
  payload: null,
  qty: 1000,
  range: 'all',
  showMa7: true,
  chart: null,
  spark: null,
};

const yen = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });
const yen0 = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
const signed = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2, signDisplay: 'always' });

function fmt(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return `${digits === 0 ? yen0.format(value) : yen.format(value)} 円`;
}

function mean(values) {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function movingAverage(values, windowSize) {
  return values.map((_, index) => {
    const slice = values.slice(Math.max(0, index - windowSize + 1), index + 1).filter(Number.isFinite);
    return slice.length ? mean(slice) : null;
  });
}

function jpDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

function shortDate(iso) {
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function scale() {
  return state.qty / (state.payload?.meta?.lot_size || 1000);
}

function scaledPerDay(row) {
  return row?.sell_yen_per_day == null ? null : row.sell_yen_per_day * scale();
}

function scaledFxCost(row) {
  return row?.fx_cost_jpy_per_day == null ? null : row.fx_cost_jpy_per_day * scale();
}

function validRows() {
  return state.payload.data.filter(row => Number.isFinite(row.sell_yen_per_day));
}

function visibleRows() {
  const rows = state.payload.data;
  if (state.range === 'all') return rows;
  return rows.slice(-Number(state.range));
}

function rowOnOrBefore(targetIso) {
  const target = new Date(`${targetIso}T00:00:00Z`).getTime();
  const candidates = validRows().filter(row => new Date(`${row.date}T00:00:00Z`).getTime() <= target);
  return candidates[candidates.length - 1] || null;
}

function daysBefore(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function changeVs(latest, reference) {
  const a = scaledPerDay(latest);
  const b = scaledPerDay(reference);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { value: a - b, pct: b === 0 ? null : ((a - b) / b) * 100 };
}

function classForChange(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 0.005) return 'neutral';
  return value > 0 ? 'positive' : 'negative';
}

function changeHtml(change) {
  if (!change) return '—';
  const pct = Number.isFinite(change.pct) ? ` <small>${signed.format(change.pct)}%</small>` : '';
  return `${signed.format(change.value)}<span class="unit">円</span>${pct}`;
}

function setChange(id, metaId, change, reference, prefix = '') {
  const el = document.getElementById(id);
  el.innerHTML = changeHtml(change);
  el.className = `change-value ${classForChange(change?.value)}`;
  document.getElementById(metaId).textContent = reference ? `${prefix}${jpDate(reference.date)}` : '比較データなし';
}

function updateSnapshot() {
  const rows = validRows();
  const latest = rows[rows.length - 1];
  const prev = rows[rows.length - 2] || null;
  const week = rowOnOrBefore(daysBefore(latest.date, 7));
  const month = rowOnOrBefore(daysBefore(latest.date, 30));
  const s = scale();

  document.getElementById('latestValue').innerHTML = `${yen.format(scaledPerDay(latest))}<span class="unit">円 / 日</span>`;
  document.getElementById('latestMeta').textContent = `${jpDate(latest.date)} · ${latest.days}日分付与 · ${state.qty.toLocaleString('ja-JP')} USD`;
  document.getElementById('latestTotal').textContent = `円換算合計 ${fmt(latest.sell_yen * s)}`;
  document.getElementById('latestPoints').textContent = `売りポイント ${yen.format(latest.sell_points)}`;

  setChange('changePrev', 'changePrevMeta', changeVs(latest, prev), prev);
  setChange('changeWeek', 'changeWeekMeta', changeVs(latest, week), week, '比較 ');
  setChange('changeMonth', 'changeMonthMeta', changeVs(latest, month), month, '比較 ');
  buildSpark(rows.slice(-14));
}

function updateKpis() {
  const rows = visibleRows().filter(row => Number.isFinite(row.sell_yen_per_day));
  const all = validRows().map(scaledPerDay);
  const avg7 = mean(all.slice(-7));
  const avg30 = mean(all.slice(-30));
  const high = rows.reduce((best, row) => !best || scaledPerDay(row) > scaledPerDay(best) ? row : best, null);
  const low = rows.reduce((best, row) => !best || scaledPerDay(row) < scaledPerDay(best) ? row : best, null);

  document.getElementById('avg7Value').innerHTML = `${yen.format(avg7)}<span class="unit">円 / 日</span>`;
  document.getElementById('avg30Value').innerHTML = `${yen.format(avg30)}<span class="unit">円 / 日</span>`;
  document.getElementById('monthValue').innerHTML = `${yen0.format(avg30 * 30)}<span class="unit">円 / 30日</span>`;
  document.getElementById('highValue').innerHTML = high ? `${yen.format(scaledPerDay(high))}<span class="unit">円</span>` : '—';
  document.getElementById('highMeta').textContent = high ? jpDate(high.date) : '—';
  document.getElementById('lowValue').innerHTML = low ? `${yen.format(scaledPerDay(low))}<span class="unit">円</span>` : '—';
  document.getElementById('lowMeta').textContent = low ? jpDate(low.date) : '—';
}

function updateTable() {
  const body = document.getElementById('recentBody');
  const rows = [...state.payload.data].reverse().slice(0, 12);
  const chronologicalValid = validRows();
  body.innerHTML = rows.map(row => {
    const total = row.sell_yen * scale();
    const daily = scaledPerDay(row);
    const index = chronologicalValid.findIndex(r => r.date === row.date);
    const prev = index > 0 ? chronologicalValid[index - 1] : null;
    const delta = daily != null && prev ? daily - scaledPerDay(prev) : null;
    const dailyHtml = daily == null ? '<span class="day-badge">—</span>' : `<strong>${yen.format(daily)} 円</strong>`;
    const daysHtml = row.days >= 3 ? `<span class="triple-badge">${row.days}D</span>` : `<span class="day-badge">${row.days}D</span>`;
    const deltaHtml = Number.isFinite(delta) ? `<span class="delta-mini ${classForChange(delta)}">${signed.format(delta)}</span>` : '<span class="day-badge">—</span>';
    return `<tr><td><a class="row-link" href="${row.source_url}" target="_blank" rel="noreferrer">${jpDate(row.date)}</a></td><td>${daysHtml}</td><td>${yen.format(row.sell_points)}</td><td>${yen.format(total)} 円</td><td>${dailyHtml}</td><td>${deltaHtml}</td></tr>`;
  }).join('');
}

function buildSpark(rows) {
  const canvas = document.getElementById('sparkChart');
  const values = rows.map(scaledPerDay);
  if (state.spark) state.spark.destroy();
  state.spark = new Chart(canvas, {
    type: 'line',
    data: { labels: rows.map(r => r.date), datasets: [{ data: values, borderColor: '#5ce1a7', backgroundColor: 'rgba(92,225,167,.08)', borderWidth: 2, pointRadius: 0, fill: true, tension: .28, spanGaps: true }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } } }
  });
}

function niceStep(target) {
  if (!Number.isFinite(target) || target <= 0) return 10;
  const power = 10 ** Math.floor(Math.log10(target));
  const scaled = target / power;
  const factor = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return factor * power;
}

function stableAxisBounds() {
  const values = [
    ...state.payload.data.map(scaledPerDay).filter(Number.isFinite),
    ...state.payload.data.map(scaledFxCost).filter(Number.isFinite),
    0,
  ];
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = Math.max(rawMax - rawMin, state.qty >= 10000 ? 100 : 10);
  const step = niceStep(span / 5);
  const min = Math.floor((rawMin - step * .7) / step) * step;
  const max = Math.ceil((rawMax + step * .7) / step) * step;
  return { min, max: max > min ? max : min + step, step };
}

function setCompactChartHeight() {
  const wrap = document.querySelector('.chart-wrap');
  if (wrap) wrap.style.height = window.matchMedia('(max-width: 620px)').matches ? '255px' : '300px';
}

function buildChart() {
  const canvas = document.getElementById('swapChart');
  const allRows = state.payload.data;
  const rows = visibleRows();
  const labels = rows.map(row => row.date);
  const startIndex = Math.max(0, allRows.length - rows.length);
  const allActual = allRows.map(scaledPerDay);
  const actual = allActual.slice(startIndex);
  const ma7 = movingAverage(allActual, 7).slice(startIndex);
  const fxCost = allRows.map(scaledFxCost).slice(startIndex);
  const multiDay = rows.map(row => row.days >= 2 ? scaledPerDay(row) : null);
  const axis = stableAxisBounds();

  setCompactChartHeight();
  if (state.chart) state.chart.destroy();

  state.chart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [
      {
        label: 'スワップ / 日', data: actual, borderColor: '#5ce1a7', backgroundColor: 'rgba(92,225,167,.035)',
        pointBackgroundColor: '#5ce1a7', pointBorderColor: '#07111f', pointBorderWidth: 2,
        pointRadius(ctx) { return ctx.dataIndex === rows.length - 1 && Number.isFinite(actual[ctx.dataIndex]) ? 3.6 : 0; },
        pointHoverRadius: 4.5, pointHitRadius: 12, borderWidth: 2, fill: true, tension: .18, spanGaps: true,
      },
      {
        label: '7回移動平均', data: ma7, borderColor: '#71a7ff', pointRadius: 0, pointHoverRadius: 0,
        borderDash: [5, 4], borderWidth: 1.45, tension: .2, fill: false, spanGaps: true, hidden: !state.showMa7,
      },
      {
        label: '7日平均 為替差損 / 日', data: fxCost, borderColor: '#ff9d7a', backgroundColor: 'transparent',
        pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 12, borderWidth: 1.9, tension: .16, fill: false, spanGaps: true,
      },
      {
        label: '複数日付与', data: multiDay, showLine: false, pointRadius: 4.1, pointHoverRadius: 5.4,
        pointHitRadius: 10, pointBackgroundColor: '#f6c56d', pointBorderColor: '#07111f', pointBorderWidth: 1.7,
      }
    ]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, resizeDelay: 120, normalized: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0b1728', borderColor: 'rgba(154,181,211,.18)', borderWidth: 1, padding: 10, displayColors: false,
          filter(item) { return item.datasetIndex !== 3; },
          callbacks: {
            title(items) { return jpDate(labels[items[0].dataIndex]); },
            label(context) {
              if (context.raw == null) return `${context.dataset.label}: —`;
              if (context.datasetIndex === 2) {
                const label = context.raw >= 0 ? '為替差損コスト / 日' : '為替差益相当 / 日';
                return `${label}: ${yen.format(Math.abs(context.raw))} 円`;
              }
              return `${context.dataset.label}: ${yen.format(context.raw)} 円`;
            },
            afterBody(items) {
              const row = rows[items[0].dataIndex];
              const detail = [`付与 ${row.days}日 · スワップ合計 ${yen.format(row.sell_yen * scale())}円`];
              if (Number.isFinite(row.usdtry_7d_change_pct)) detail.push(`7日USD/TRY変化 ${signed.format(row.usdtry_7d_change_pct)}%`);
              if (Number.isFinite(row.usdtry_daily_change_pct)) detail.push(`1日換算 ${signed.format(row.usdtry_daily_change_pct)}%`);
              if (Number.isFinite(row.usdtry_rep_rate)) detail.push(`代表 USD/TRY ${row.usdtry_rep_rate.toFixed(4)}`);
              if (Number.isFinite(row.usdjpy_rep_rate)) detail.push(`代表 USD/JPY ${row.usdjpy_rep_rate.toFixed(3)}`);
              return detail;
            }
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#71849b', maxRotation: 0, autoSkip: true, maxTicksLimit: 7, padding: 5, callback(value) { return shortDate(labels[value]); } }, border: { color: 'rgba(154,181,211,.10)' } },
        y: {
          min: axis.min, max: axis.max,
          grid: { color(ctx) { return ctx.tick.value === 0 ? 'rgba(245,248,252,.22)' : 'rgba(154,181,211,.065)'; } },
          ticks: { color: '#71849b', stepSize: axis.step, maxTicksLimit: 7, padding: 7, callback(value) { return `${yen0.format(value)}円`; } },
          border: { display: false }
        }
      }
    }
  });

  const first = rows[0]?.date || state.payload.meta.start_date;
  const last = rows[rows.length - 1]?.date || state.payload.meta.latest_date;
  document.getElementById('rangeLabel').textContent = `${jpDate(first)} — ${jpDate(last)} · ${rows.length} records`;
}

function updateHeader() {
  const meta = state.payload.meta;
  const status = document.getElementById('statusPill');
  status.textContent = `最新 ${jpDate(meta.latest_date)}`;
  status.className = 'status-pill ok';
  document.getElementById('methodStart').textContent = jpDate(meta.start_date);
  const generated = new Date(meta.generated_at);
  document.getElementById('generatedAt').textContent = `Data generated ${generated.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function downloadCsv() {
  const s = scale();
  const header = ['date','days','lot_usd','sell_points','sell_yen_total','swap_yen_per_day','usdtry_rep_rate','usdjpy_rep_rate','usdtry_7d_ref_date','usdtry_7d_ref_rate','usdtry_7d_change_pct','usdtry_daily_change_pct','fx_cost_yen_per_day','fx_cost_yen_accrual_total','source_url'];
  const rows = state.payload.data.map(row => [row.date,row.days,state.qty,row.sell_points,row.sell_yen*s,row.sell_yen_per_day==null?'':row.sell_yen_per_day*s,row.usdtry_rep_rate??'',row.usdjpy_rep_rate??'',row.usdtry_7d_ref_date??'',row.usdtry_7d_ref_rate??'',row.usdtry_7d_change_pct??'',row.usdtry_daily_change_pct??'',row.fx_cost_jpy_per_day==null?'':row.fx_cost_jpy_per_day*s,row.fx_cost_jpy_accrual_total==null?'':row.fx_cost_jpy_accrual_total*s,row.source_url]);
  const csv = '\uFEFF' + [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `USDTRY_swap_fx_${state.qty}USD_${state.payload.meta.latest_date}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function render() { updateHeader(); updateSnapshot(); updateKpis(); updateTable(); buildChart(); }

async function loadData() {
  try {
    const response = await fetch(`./data/usdtry.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.payload = await response.json();
    render();
  } catch (error) {
    console.error(error);
    const status = document.getElementById('statusPill');
    status.textContent = 'データ取得エラー'; status.className = 'status-pill error';
    document.getElementById('recentBody').innerHTML = '<tr><td colspan="6" class="loading-cell">データを読み込めませんでした</td></tr>';
  }
}

document.querySelectorAll('.unit-btn').forEach(button => button.addEventListener('click', () => {
  state.qty = Number(button.dataset.qty);
  document.querySelectorAll('.unit-btn').forEach(b => b.classList.toggle('active', b === button));
  if (state.payload) render();
}));

document.querySelectorAll('.range-btn').forEach(button => button.addEventListener('click', () => {
  state.range = button.dataset.range;
  document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b === button));
  if (state.payload) { updateKpis(); buildChart(); }
}));

document.getElementById('toggleMa7').addEventListener('click', event => {
  state.showMa7 = !state.showMa7;
  const button = event.currentTarget;
  button.classList.toggle('active', state.showMa7);
  button.setAttribute('aria-pressed', String(state.showMa7));
  button.textContent = state.showMa7 ? 'MA7 ON' : 'MA7 OFF';
  document.getElementById('maLegend').classList.toggle('series-muted', !state.showMa7);
  if (state.payload) buildChart();
});

document.getElementById('downloadCsv').addEventListener('click', downloadCsv);
loadData();
