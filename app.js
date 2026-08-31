const state = {
  payload: null,
  qty: 1000,
  range: 'all',
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

function validRows() {
  return state.payload.data.filter(row => Number.isFinite(row.sell_yen_per_day));
}

function visibleRows() {
  const rows = state.payload.data;
  if (state.range === 'all') return rows;
  return rows.slice(-Number(state.range));
}

function latestValid(rows = state.payload.data) {
  return [...rows].reverse().find(row => Number.isFinite(row.sell_yen_per_day)) || null;
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
  const avg7 = mean(validRows().map(scaledPerDay).slice(-7));
  const avg30 = mean(validRows().map(scaledPerDay).slice(-30));
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
    return `
      <tr>
        <td><a class="row-link" href="${row.source_url}" target="_blank" rel="noreferrer">${jpDate(row.date)}</a></td>
        <td>${daysHtml}</td>
        <td>${yen.format(row.sell_points)}</td>
        <td>${yen.format(total)} 円</td>
        <td>${dailyHtml}</td>
        <td>${deltaHtml}</td>
      </tr>`;
  }).join('');
}

function buildSpark(rows) {
  const canvas = document.getElementById('sparkChart');
  const values = rows.map(scaledPerDay);
  if (state.spark) state.spark.destroy();
  state.spark = new Chart(canvas, {
    type: 'line',
    data: { labels: rows.map(r => r.date), datasets: [{ data: values, borderColor: '#5ce1a7', backgroundColor: 'rgba(92,225,167,.08)', borderWidth: 2, pointRadius: 0, fill: true, tension: .35, spanGaps: true }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } }, elements: { line: { capBezierPoints: true } } }
  });
}

function buildChart() {
  const canvas = document.getElementById('swapChart');
  const rows = visibleRows();
  const labels = rows.map(row => row.date);
  const actual = rows.map(scaledPerDay);
  const ma7 = movingAverage(actual, 7);
  const triple = rows.map(row => row.days >= 3 ? scaledPerDay(row) : null);

  if (state.chart) state.chart.destroy();

  state.chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '1日あたり', data: actual, borderColor: '#5ce1a7', backgroundColor: 'rgba(92,225,167,.10)',
          pointBackgroundColor: '#5ce1a7', pointBorderColor: '#07111f', pointBorderWidth: 2, pointRadius: 2.6,
          pointHoverRadius: 5, borderWidth: 2.2, fill: true, tension: .28, spanGaps: true,
        },
        {
          label: '7回移動平均', data: ma7, borderColor: '#71a7ff', pointRadius: 0,
          borderDash: [6, 5], borderWidth: 1.7, tension: .35, fill: false, spanGaps: true,
        },
        {
          label: '3日付与', data: triple, showLine: false, pointRadius: 5.2, pointHoverRadius: 7,
          pointBackgroundColor: '#f6c56d', pointBorderColor: '#07111f', pointBorderWidth: 2,
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0b1728', borderColor: 'rgba(154,181,211,.18)', borderWidth: 1, padding: 12,
          filter(item) { return item.datasetIndex !== 2 || item.raw != null; },
          callbacks: {
            title(items) { return jpDate(labels[items[0].dataIndex]); },
            label(context) {
              if (context.raw == null) return `${context.dataset.label}: —`;
              return `${context.dataset.label}: ${yen.format(context.raw)} 円 / 日`;
            },
            afterBody(items) {
              const row = rows[items[0].dataIndex];
              return [`付与日数: ${row.days}日`, `売りポイント: ${yen.format(row.sell_points)}`, `円換算合計: ${yen.format(row.sell_yen * scale())} 円`];
            }
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#71849b', maxRotation: 0, autoSkip: true, maxTicksLimit: 9, callback(value) { return shortDate(labels[value]); } }, border: { color: 'rgba(154,181,211,.12)' } },
        y: { grid: { color: 'rgba(154,181,211,.08)' }, ticks: { color: '#71849b', callback(value) { return `${yen0.format(value)}円`; } }, border: { display: false } }
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
  const header = ['date','days','lot_usd','sell_points','sell_yen_total','sell_yen_per_day','source_url'];
  const rows = state.payload.data.map(row => [row.date, row.days, state.qty, row.sell_points, row.sell_yen * s, row.sell_yen_per_day == null ? '' : row.sell_yen_per_day * s, row.source_url]);
  const csv = '\uFEFF' + [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `USDTRY_swap_${state.qty}USD_${state.payload.meta.latest_date}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function render() {
  updateHeader();
  updateSnapshot();
  updateKpis();
  updateTable();
  buildChart();
}

async function loadData() {
  try {
    const response = await fetch(`./data/usdtry.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.payload = await response.json();
    render();
  } catch (error) {
    console.error(error);
    const status = document.getElementById('statusPill');
    status.textContent = 'データ取得エラー';
    status.className = 'status-pill error';
    document.getElementById('recentBody').innerHTML = '<tr><td colspan="6" class="loading-cell">データを読み込めませんでした</td></tr>';
  }
}

document.querySelectorAll('.unit-btn').forEach(button => {
  button.addEventListener('click', () => {
    state.qty = Number(button.dataset.qty);
    document.querySelectorAll('.unit-btn').forEach(b => b.classList.toggle('active', b === button));
    if (state.payload) render();
  });
});

document.querySelectorAll('.range-btn').forEach(button => {
  button.addEventListener('click', () => {
    state.range = button.dataset.range;
    document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b === button));
    if (state.payload) {
      updateKpis();
      buildChart();
    }
  });
});

document.getElementById('downloadCsv').addEventListener('click', downloadCsv);
loadData();
