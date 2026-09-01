// Beta interval accounting: one Hirose row = one market interval to the next fixed rate.
// FX is NEVER divided by elapsed calendar days here. Friday->Monday is one interval.
// Net = actual credited swap total - actual FX P/L total for the same interval.

function trailing30IntervalNet() {
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
  return recent.length
    ? recent.map(intervalNetTotal).filter(Number.isFinite).reduce((sum, value) => sum + value, 0)
    : null;
}

window.updateOverview = function updateOverviewInterval() {
  const latest = latestSwapRow();
  if (!latest) return;

  const swap = swapPerDay(latest);
  document.getElementById('latestSwap').innerHTML = `${yen.format(swap)}<small>円 / 日</small>`;
  document.getElementById('latestSwapMeta').textContent = `${jpDate(latest.date)} · ${Number(latest.days || 0)}日分付与 · ${state.qty.toLocaleString('ja-JP')} USD`;
  document.getElementById('latestSwapTotal').textContent = fmtYen(swapTotal(latest), 2);
  document.getElementById('latestSwapPoints').textContent = finite(latest.sell_points) ? yen.format(Number(latest.sell_points)) : '—';

  const swaps = allRows().map(swapPerDay).filter(Number.isFinite);
  document.getElementById('swapAvg7').innerHTML = `${yen.format(mean(swaps.slice(-7)))}<small>円/日</small>`;
  document.getElementById('swapAvg30').innerHTML = `${yen.format(mean(swaps.slice(-30)))}<small>円/日</small>`;

  const row = latestConfirmedRow();
  const net = row ? intervalNetTotal(row) : null;
  const netEl = document.getElementById('latestNet');
  netEl.innerHTML = Number.isFinite(net)
    ? `${net > 0 ? '+' : ''}${yen.format(net)}<small>円 / 市場区間</small>`
    : '—';
  setTone(netEl, net);
  document.getElementById('latestNetMeta').textContent = row
    ? `${jpDate(row.date)}${row.usdtry_next_date ? ` → ${jpDate(row.usdtry_next_date)}` : ''} · 暦日割りなし`
    : '確定区間なし';

  const trailing = trailing30IntervalNet();
  const trailingEl = document.getElementById('net30Estimate');
  trailingEl.innerHTML = Number.isFinite(trailing)
    ? `${trailing > 0 ? '+' : ''}${yen0.format(trailing)}<small>円 / 直近30日</small>`
    : '—';
  setTone(trailingEl, trailing);

  buildSwapSpark(allRows().filter(r => finite(r.sell_yen_per_day)).slice(-18));
};

window.buildNetChart = function buildNetChartInterval() {
  destroyChart('net');
  const rows = visibleConfirmedRows();
  const labels = rows.map(row => row.date);
  const values = rows.map(intervalNetTotal);
  const axis = axisBounds(values, true);

  state.charts.net = new Chart(document.getElementById('netChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'ネット損益 / 市場区間',
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
              return row.usdtry_next_date
                ? `${jpDate(row.date)} → ${jpDate(row.usdtry_next_date)}`
                : jpDate(row.date);
            },
            label(context) {
              const row = rows[context.dataIndex];
              const swap = swapTotal(row);
              const fx = fxTotal(row);
              const net = intervalNetTotal(row);
              return [
                `実付与スワップ: ${fmtYen(swap, 2)}`,
                `${fx < 0 ? '為替差益' : '為替差損'}: ${fmtYen(Math.abs(fx), 2)}`,
                `ネット: ${fmtSignedYen(net, 2)}`,
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
            color(context) {
              return context.tick.value === 0 ? 'rgba(244,247,251,.24)' : 'rgba(148,171,201,.06)';
            },
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
  const total = values.filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
  const boxes = document.querySelectorAll('#netSummary b');
  boxes[0].textContent = fmtSignedYen(avg, 2);
  boxes[1].textContent = `${positives} / ${values.length}`;
  boxes[2].textContent = fmtSignedYen(total, 0);
  setTone(boxes[0], avg);
  setTone(boxes[2], total);
};

// Keep the smoothed 7AVG line chart, but make its latest decomposition use the raw market interval.
const baseBuildCarryChartForInterval = buildCarryChart;
window.buildCarryChart = function buildCarryChartInterval() {
  baseBuildCarryChartForInterval();
  const row = latestConfirmedRow();
  if (!row) return;
  const swap = swapTotal(row);
  const fx = fxTotal(row);
  const net = intervalNetTotal(row);
  document.getElementById('decompDate').textContent = row.usdtry_next_date
    ? `${jpDate(row.date)} → ${jpDate(row.usdtry_next_date)}`
    : jpDate(row.date);
  document.getElementById('decompSwap').textContent = `+${fmtYen(swap, 2)}`;
  document.getElementById('decompFx').textContent = `${fx >= 0 ? '−' : '+'}${fmtYen(Math.abs(fx), 2)}`;
  const netEl = document.getElementById('decompNet');
  netEl.textContent = fmtSignedYen(net, 2);
  setTone(netEl, net);
  document.getElementById('decompNote').textContent = '実付与スワップ総額と次の取引日固定レートまでのFX総額を直接比較。金→月も1市場区間として扱い、暦日数では割りません。';
};

window.updateRecentCards = function updateRecentCardsInterval() {
  const target = document.getElementById('recentCards');
  const rows = [...allRows()].reverse().slice(0, 12);
  target.innerHTML = rows.map(row => {
    const swapDay = swapPerDay(row);
    const swap = swapTotal(row);
    const fx = fxTotal(row);
    const net = intervalNetTotal(row);
    const dayClass = Number(row.days || 0) >= 3 ? 'day-pill triple' : 'day-pill';
    const netClass = !Number.isFinite(net) ? 'neutral' : net > 0 ? 'positive' : net < 0 ? 'negative' : 'neutral';
    return `
      <article class="data-card card">
        <div class="data-card-head">
          <a class="data-card-date source-link" href="${row.source_url}" target="_blank" rel="noreferrer">${jpDate(row.date)}</a>
          <span class="${dayClass}">${Number(row.days || 0)}D</span>
        </div>
        <div class="data-values">
          <div><span>SWAP / DAY</span><b>${Number.isFinite(swapDay) ? fmtYen(swapDay, 2) : '—'}</b></div>
          <div><span>SWAP TOTAL</span><b>${Number.isFinite(swap) ? fmtYen(swap, 2) : '—'}</b></div>
          <div><span>FX / INTERVAL</span><b>${Number.isFinite(fx) ? fmtYen(fx, 2) : '未確定'}</b></div>
          <div><span>NET / INTERVAL</span><b class="${netClass}">${Number.isFinite(net) ? fmtSignedYen(net, 2) : '—'}</b></div>
        </div>
      </article>`;
  }).join('');
};

window.updateNetSectionCopy = function updateNetSectionCopyInterval() {
  const section = document.getElementById('net');
  if (!section) return;
  const heading = section.querySelector('h2');
  const copy = section.querySelector('.section-head p');
  if (heading) heading.textContent = 'ネット損益 / 市場区間';
  if (copy) copy.textContent = '7AVGは使わず、各ヒロセ日付の実付与スワップ総額から、次の取引日固定レートまでの為替損益総額をそのまま差し引きます。金→月も1市場区間として扱い、3暦日では割りません。3倍木曜は3日分スワップと木→金FXを総額同士で比較します。';
};