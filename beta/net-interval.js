// Beta net bars: use actual credited swap and actual FX P/L for the same interval.
// No FX 7AVG and no extra calendar-day normalization in the bar height.
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
        label: 'ネット損益',
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
              const days = intervalDays(row);
              return [
                `実付与スワップ: ${fmtYen(swap, 2)}`,
                `${fx < 0 ? '為替差益' : '為替差損'}: ${fmtYen(Math.abs(fx), 2)}`,
                `ネット: ${fmtSignedYen(net, 2)}`,
                days > 1 ? `参考・1暦日換算: ${fmtSignedYen(net / days, 2)} / 日` : '',
              ].filter(Boolean);
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

window.updateNetSectionCopy = function updateNetSectionCopyInterval() {
  const section = document.getElementById('net');
  if (!section) return;
  const heading = section.querySelector('h2');
  const copy = section.querySelector('.section-head p');
  if (heading) heading.textContent = 'ネット日次損益';
  if (copy) copy.textContent = '7AVGは使わず、各ヒロセ日付に実際に付与されたスワップ総額から、同じ保有区間の固定レート差による為替損益総額を差し引きます。3倍木曜は3日分スワップをそのまま木→金FXと比較します。';
};