const state = {
  payload: null,
  qty: 1000,
  chart: null,
};

const yen = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });
const yen0 = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });

function fmtYen(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const formatter = digits === 0 ? yen0 : yen;
  return `${formatter.format(value)} 円`;
}

function mean(values) {
  const xs = values.filter(v => Number.isFinite(v));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
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
  return row.sell_yen_per_day == null ? null : row.sell_yen_per_day * scale();
}

function latestValid(data) {
  return [...data].reverse().find(row => row.sell_yen_per_day != null) || data[data.length - 1];
}

function updateKpis() {
  const { data } = state.payload;
  const latest = latestValid(data);
  const valid = data.map(scaledPerDay).filter(Number.isFinite);
  const avg7 = mean(valid.slice(-7));
  const avg30 = mean(valid.slice(-30));

  document.getElementById('latestValue').innerHTML = `${yen.format(scaledPerDay(latest))}<span class="unit">円 / 日</span>`;
  document.getElementById('latestMeta').textContent = `${jpDate(latest.date)} · ${latest.days}日分付与`;
  document.getElementById('avg7Value').innerHTML = `${yen.format(avg7)}<span class="unit">円 / 日</span>`;
  document.getElementById('avg30Value').innerHTML = `${yen.format(avg30)}<span class="unit">円 / 日</span>`;
  document.getElementById('monthValue').innerHTML = `${yen0.format(avg30 * 30)}<span class="unit">円 / 30日</span>`;
}

function updateTable() {
  const body = document.getElementById('recentBody');
  const rows = [...state.payload.data].reverse().slice(0, 10);
  body.innerHTML = rows.map(row => {
    const total = row.sell_yen * scale();
    const daily = scaledPerDay(row);
    const dailyHtml = daily == null ? '<span style="color:#71849b">—</span>' : `<strong>${yen.format(daily)} 円</strong>`;
    return `
      <tr>
        <td><a class="row-link" href="${row.source_url}" target="_blank" rel="noreferrer">${jpDate(row.date)}</a></td>
        <td>${row.days}</td>
        <td>${yen.format(total)} 円</td>
        <td>${dailyHtml}</td>
      </tr>`;
  }).join('');
}

function buildChart() {
  const canvas = document.getElementById('swapChart');
  const labels = state.payload.data.map(row => row.date);
  const actual = state.payload.data.map(scaledPerDay);
  const ma7 = movingAverage(actual, 7);

  if (state.chart) state.chart.destroy();

  state.chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '1日あたり',
          data: actual,
          borderColor: '#5ce1a7',
          backgroundColor: 'rgba(92,225,167,.12)',
          pointBackgroundColor: '#5ce1a7',
          pointBorderColor: '#07111f',
          pointBorderWidth: 2,
          pointRadius: 2.8,
          pointHoverRadius: 5,
          borderWidth: 2.2,
          fill: true,
          tension: .28,
          spanGaps: true,
        },
        {
          label: '7回移動平均',
          data: ma7,
          borderColor: '#71a7ff',
          pointRadius: 0,
          borderDash: [6, 5],
          borderWidth: 1.7,
          tension: .35,
          fill: false,
          spanGaps: true,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0b1728',
          borderColor: 'rgba(154,181,211,.18)',
          borderWidth: 1,
          padding: 12,
          displayColors: true,
          callbacks: {
            title(items) {
              return jpDate(labels[items[0].dataIndex]);
            },
            label(context) {
              if (context.raw == null) return `${context.dataset.label}: —`;
              return `${context.dataset.label}: ${yen.format(context.raw)} 円 / 日`;
            },
            afterBody(items) {
              const row = state.payload.data[items[0].dataIndex];
              return [`付与日数: ${row.days}日`, `円換算合計: ${yen.format(row.sell_yen * scale())} 円`];
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#71849b',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 9,
            callback(value) { return shortDate(labels[value]); }
          },
          border: { color: 'rgba(154,181,211,.12)' }
        },
        y: {
          grid: { color: 'rgba(154,181,211,.08)' },
          ticks: {
            color: '#71849b',
            callback(value) { return `${yen0.format(value)}円`; }
          },
          border: { display: false }
        }
      }
    }
  });
}

function updateHeader() {
  const meta = state.payload.meta;
  const status = document.getElementById('statusPill');
  status.textContent = `最新 ${jpDate(meta.latest_date)}`;
  status.classList.add('ok');
  document.getElementById('rangeLabel').textContent = `${jpDate(meta.start_date)} — ${jpDate(meta.latest_date)}`;

  const generated = new Date(meta.generated_at);
  document.getElementById('generatedAt').textContent = `Data generated ${generated.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`;
}

function render() {
  updateHeader();
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
    status.classList.add('error');
    document.getElementById('recentBody').innerHTML = '<tr><td colspan="4" class="loading-cell">データを読み込めませんでした</td></tr>';
  }
}

document.querySelectorAll('.unit-btn').forEach(button => {
  button.addEventListener('click', () => {
    state.qty = Number(button.dataset.qty);
    document.querySelectorAll('.unit-btn').forEach(b => b.classList.toggle('active', b === button));
    if (state.payload) {
      updateKpis();
      updateTable();
      buildChart();
    }
  });
});

loadData();
