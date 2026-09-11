const Dashboard = (() => {
  const state = {
    payload: null,
    qty: 1000,
    range: 'all',
    fxMode: 'avg7',
    charts: {},
  };

  const yen = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });
  const yen0 = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
  const rate4 = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

  const isFiniteNumber = value => value !== null && value !== '' && Number.isFinite(Number(value));
  const scale = () => state.qty / Number(state.payload?.meta?.lot_size || 1000);
  const scaled = value => isFiniteNumber(value) ? Number(value) * scale() : null;
  const swapPerDay = row => scaled(row?.sell_yen_per_day);
  const swapTotal = row => scaled(row?.sell_yen);
  const fxDaily = row => scaled(row?.fx_cost_jpy_per_day);
  const fx7 = row => scaled(row?.fx_cost_7d_jpy_per_day);
  const fxTotal = row => scaled(row?.fx_cost_jpy_total);
  const isMultiDay = row => Number(row?.days || 0) >= 3;

  // Display invariant:
  // FX 7AVG -> normalized swap/day.
  // FX DAILY -> actual credited swap on each Hirose row (sell_yen), with no day division.
  const trendSwap = row => state.fxMode === 'daily' ? swapTotal(row) : swapPerDay(row);

  const netInterval = row => {
    const swap = swapTotal(row);
    const fx = fxTotal(row);
    return Number.isFinite(swap) && Number.isFinite(fx) ? swap - fx : null;
  };

  function jpDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = String(iso).split('-');
    return `${y}/${m}/${d}`;
  }

  function shortDate(iso) {
    if (!iso) return '—';
    const [, m, d] = String(iso).split('-');
    return `${Number(m)}/${Number(d)}`;
  }

  function addDays(iso, days) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function mean(values) {
    const xs = values.filter(Number.isFinite);
    return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
  }

  function money(value, digits = 2) {
    if (!Number.isFinite(value)) return '—';
    return `${digits === 0 ? yen0.format(value) : yen.format(value)}円`;
  }

  function signedMoney(value, digits = 2) {
    if (!Number.isFinite(value)) return '—';
    return `${value > 0 ? '+' : ''}${money(value, digits)}`;
  }

  function pct(value, digits = 3) {
    if (!Number.isFinite(value)) return '—';
    return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function validSwapRows() {
    return state.payload.data.filter(row => isFiniteNumber(row.sell_yen_per_day));
  }

  function confirmedIntervalRows() {
    return state.payload.data.filter(row => isFiniteNumber(row.fx_cost_jpy_total));
  }

  function multiDayRows() {
    return state.payload.data.filter(row => isMultiDay(row) && isFiniteNumber(row.fx_cost_jpy_total));
  }

  function visibleRows() {
    if (state.range === 'all') return state.payload.data;
    return state.payload.data.slice(-Number(state.range));
  }

  function destroyChart(name) {
    if (state.charts[name]) {
      state.charts[name].destroy();
      state.charts[name] = null;
    }
  }

  function axisBounds(series, floorSpan = 20) {
    const values = series.flat().filter(Number.isFinite);
    if (!values.length) return { min: 0, max: 1 };
    const lo = Math.min(...values, 0);
    const hi = Math.max(...values, 0);
    const span = Math.max(hi - lo, floorSpan * scale());
    return { min: lo - span * 0.12, max: hi + span * 0.12 };
  }

  function baseChartOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0a1728',
          borderColor: 'rgba(159,181,209,.18)',
          borderWidth: 1,
          padding: 10,
          displayColors: false,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: 'rgba(159,181,209,.10)' },
          ticks: { color: '#71849b', maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
        },
        y: {
          border: { display: false },
          grid: { color: 'rgba(159,181,209,.07)' },
          ticks: { color: '#71849b', maxTicksLimit: 6 },
        },
      },
    };
  }

  function renderHeader() {
    const meta = state.payload.meta;
    const latestRow = state.payload.data[state.payload.data.length - 1];
    const generatedRaw = meta.market_updated_at || meta.swap_updated_at || meta.generated_at;
    const generated = generatedRaw ? new Date(generatedRaw) : null;

    setText('statusPill', `最新 ${jpDate(meta.latest_date)}`);
    document.getElementById('statusPill')?.classList.add('ok');
    setText('freshSwap', jpDate(meta.latest_date));
    setText(
      'freshAnchor',
      isFiniteNumber(latestRow?.market_rate_hour_jst)
        ? `${latestRow.market_rate_hour_jst}:00 JST${Number(latestRow.market_rate_anchor_distance_hours || 0) ? ' fallback' : ''}`
        : '未確定'
    );
    setText(
      'freshGenerated',
      generated && Number.isFinite(generated.getTime())
        ? generated.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—'
    );
    setText(
      'generatedAt',
      generated && Number.isFinite(generated.getTime())
        ? `Generated ${generated.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`
        : '—'
    );
  }

  function renderOverview() {
    const swaps = validSwapRows();
    const latest = swaps[swaps.length - 1];
    const confirmed = confirmedIntervalRows();
    const latestConfirmed = confirmed[confirmed.length - 1];
    if (!latest) return;

    document.getElementById('latestSwap').innerHTML = `${yen.format(swapPerDay(latest))}<small>円 / 日</small>`;
    setText('latestSwapMeta', `${jpDate(latest.date)} · ${latest.days}日分 · ${state.qty.toLocaleString('ja-JP')} USD`);
    setText('latestSwapTotal', money(swapTotal(latest)));
    setText('latestSwapPoints', yen.format(Number(latest.sell_points || 0)));
    setText('avg7', money(mean(swaps.slice(-7).map(swapPerDay))));
    setText('avg30', money(mean(swaps.slice(-30).map(swapPerDay))));

    const latestNet = latestConfirmed ? netInterval(latestConfirmed) : null;
    setText('latestNet', signedMoney(latestNet));
    setText(
      'latestNetMeta',
      latestConfirmed?.usdtry_next_date
        ? `${shortDate(latestConfirmed.date)}→${shortDate(latestConfirmed.usdtry_next_date)} · Swap − FX`
        : '確定区間なし'
    );

    if (latestConfirmed) {
      const start = addDays(latestConfirmed.date, -29);
      const net30 = confirmed
        .filter(row => row.date >= start && row.date <= latestConfirmed.date)
        .map(netInterval)
        .filter(Number.isFinite)
        .reduce((sum, value) => sum + value, 0);
      setText('net30', signedMoney(net30, 0));
    } else {
      setText('net30', '—');
    }

    renderSpark(swaps.slice(-18));
  }

  function renderSpark(rows) {
    const canvas = document.getElementById('sparkChart');
    if (!canvas || typeof Chart === 'undefined') return;
    destroyChart('spark');
    state.charts.spark = new Chart(canvas, {
      type: 'line',
      data: {
        labels: rows.map(row => row.date),
        datasets: [{
          data: rows.map(swapPerDay),
          borderColor: '#5ce1a7',
          backgroundColor: 'rgba(92,225,167,.07)',
          borderWidth: 2,
          pointRadius: 0,
          tension: .28,
          fill: true,
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

  function renderTrend() {
    const canvas = document.getElementById('trendChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const rows = visibleRows();
    const labels = rows.map(row => row.date);
    const swap = rows.map(trendSwap);
    const fx = rows.map(row => state.fxMode === 'avg7' ? fx7(row) : fxDaily(row));
    const events = rows.map(row => isMultiDay(row) ? trendSwap(row) : null);
    const axis = axisBounds([swap, fx]);

    destroyChart('trend');
    const options = baseChartOptions();
    options.scales.y.min = axis.min;
    options.scales.y.max = axis.max;
    options.scales.y.ticks.callback = value => `${yen0.format(value)}円`;
    options.scales.x.ticks.callback = value => shortDate(labels[value]);
    options.plugins.tooltip.filter = item => item.datasetIndex === 0;
    options.plugins.tooltip.callbacks = {
      title(items) {
        return items.length ? jpDate(labels[items[0].dataIndex]) : '';
      },
      label(context) {
        const i = context.dataIndex;
        const row = rows[i];
        const swapValue = swap[i];
        const fxValue = fx[i];
        const dailyActual = state.fxMode === 'daily';
        const difference = Number.isFinite(swapValue) && Number.isFinite(fxValue) ? swapValue - fxValue : null;
        const fxLabel = Number.isFinite(fxValue) && fxValue < 0 ? '為替差益' : '為替差損';
        const days = Number(row.days || 0);
        const swapSuffix = dailyActual
          ? (days > 1 ? ` · ${days}日分実額` : ' · 実額')
          : ' / 日';
        const lines = [
          `スワップ: ${money(swapValue)}${swapSuffix}`,
          `${fxLabel}: ${money(Number.isFinite(fxValue) ? Math.abs(fxValue) : null)} / 日`,
          `差: ${signedMoney(difference)}${dailyActual ? '' : ' / 日'}`,
        ];
        if (!dailyActual && isMultiDay(row)) lines.push(`複数日付与: ${days}日分（日割り表示）`);
        return lines;
      },
    };

    state.charts.trend = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: state.fxMode === 'daily' ? 'スワップ実額' : 'スワップ / 日',
            data: swap,
            borderColor: '#5ce1a7',
            backgroundColor: 'rgba(92,225,167,.04)',
            borderWidth: 2.2,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHitRadius: 14,
            tension: .20,
            fill: true,
            spanGaps: true,
          },
          {
            label: state.fxMode === 'avg7' ? '為替差損 7AVG' : '為替差損 / 日',
            data: fx,
            borderColor: '#ff9d7a',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            tension: state.fxMode === 'avg7' ? .28 : .12,
            fill: false,
            spanGaps: true,
          },
          {
            label: '複数日付与',
            data: events,
            showLine: false,
            pointRadius: 4.2,
            pointHoverRadius: 5,
            pointBackgroundColor: '#f6c56d',
            pointBorderColor: '#07111f',
            pointBorderWidth: 1.5,
          },
        ],
      },
      options,
    });

    setText('swapLegend', state.fxMode === 'daily' ? 'スワップ実額' : 'スワップ / 日');
    setText('fxLegend', state.fxMode === 'avg7' ? '為替差損 7日平均' : '為替差損 / 日');
    setText(
      'trendDescription',
      state.fxMode === 'avg7'
        ? '7AVGではスワップを付与日数で割った日次額と、7日平均の為替悪化率を表示します。FX DAILYへ切り替えるとスワップは全行で付与実額を使います。'
        : 'FX DAILYではスワップを日数で割らず、各ヒロセ日付で実際に付与された sell_yen 総額をそのまま表示します。複数日付与は3日・4日分の総額としてグラフに反映します。'
    );

    const toggle = document.getElementById('toggleFxMode');
    if (toggle) {
      toggle.textContent = state.fxMode === 'avg7' ? 'FX 7AVG' : 'FX DAILY';
      toggle.classList.toggle('active', state.fxMode === 'avg7');
    }
    if (rows.length) {
      setText('trendRange', `${jpDate(rows[0].date)} — ${jpDate(rows[rows.length - 1].date)} · ${rows.length} rows`);
    }
  }

  function renderEvents() {
    const canvas = document.getElementById('eventChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const rows = multiDayRows();
    const labels = rows.map(row => `${shortDate(row.date)} · ${row.days}D`);
    const swaps = rows.map(swapTotal);
    const fx = rows.map(fxTotal);
    const nets = rows.map(netInterval);

    destroyChart('events');
    const options = baseChartOptions();
    options.interaction = { mode: 'index', intersect: false };
    options.scales.y.ticks.callback = value => `${yen0.format(value)}円`;
    options.scales.x.ticks.autoSkip = rows.length > 10;
    options.plugins.legend = {
      display: true,
      align: 'start',
      labels: { color: '#8ea0b6', boxWidth: 12, boxHeight: 8, padding: 14 },
    };
    options.plugins.tooltip.callbacks = {
      title(items) {
        const row = rows[items[0]?.dataIndex];
        return row ? `${jpDate(row.date)} → ${jpDate(row.usdtry_next_date)} · ${row.days}日分` : '';
      },
      label(context) {
        const i = context.dataIndex;
        if (context.datasetIndex === 0) return `スワップ総額: ${money(swaps[i])}`;
        const value = fx[i];
        return `${value < 0 ? '為替差益' : '為替差損'}: ${money(Math.abs(value))}`;
      },
      footer(items) {
        const i = items[0]?.dataIndex;
        return Number.isInteger(i) ? `差引: ${signedMoney(nets[i])}` : '';
      },
    };

    state.charts.events = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'スワップ総額',
            data: swaps,
            backgroundColor: 'rgba(92,225,167,.72)',
            borderColor: '#5ce1a7',
            borderWidth: 1,
            borderRadius: 5,
          },
          {
            label: '為替差損',
            data: fx,
            backgroundColor: 'rgba(255,157,122,.68)',
            borderColor: '#ff9d7a',
            borderWidth: 1,
            borderRadius: 5,
          },
        ],
      },
      options,
    });

    const wins = nets.filter(value => Number.isFinite(value) && value > 0).length;
    const avgNet = mean(nets);
    const maxDays = rows.length ? Math.max(...rows.map(row => Number(row.days || 0))) : 0;
    const cells = document.querySelectorAll('#eventSummary > div b');
    if (cells[0]) cells[0].textContent = `${rows.length}回`;
    if (cells[1]) cells[1].textContent = rows.length ? `${wins}/${rows.length}` : '—';
    if (cells[2]) cells[2].textContent = signedMoney(avgNet, 0);
    if (cells[3]) cells[3].textContent = maxDays ? `${maxDays}日分` : '—';
  }

  function returnSeries() {
    const rows = confirmedIntervalRows().filter(row => isFiniteNumber(row.usdjpy_rep_rate));
    if (!rows.length) return [];

    const benchmarkUsd = 10000;
    const roundTripCost = 100;
    let hold = 100;
    let avoid = 100;
    const points = [{ date: rows[0].date, hold, avoid, event: false }];

    rows.forEach(row => {
      const sourceLot = Number(row.lot_size || state.payload.meta.lot_size || 1000);
      const benchmarkScale = benchmarkUsd / sourceLot;
      const swap = Number(row.sell_yen || 0) * benchmarkScale;
      const fx = Number(row.fx_cost_jpy_total) * benchmarkScale;
      const capital = benchmarkUsd * Number(row.usdjpy_rep_rate);
      if (!Number.isFinite(capital) || capital <= 0 || !Number.isFinite(fx)) return;

      const event = isMultiDay(row);
      const holdNet = swap - fx;
      const avoidNet = event ? -roundTripCost : holdNet;
      hold *= 1 + holdNet / capital;
      avoid *= 1 + avoidNet / capital;
      points.push({ date: row.usdtry_next_date || row.date, hold, avoid, event });
    });
    return points;
  }

  function renderReturns() {
    const canvas = document.getElementById('returnChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const points = returnSeries();
    if (points.length < 2) return;
    const labels = points.map(point => point.date);
    const hold = points.map(point => point.hold);
    const avoid = points.map(point => point.avoid);
    const all = [...hold, ...avoid];
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const span = Math.max(hi - lo, .3);

    destroyChart('returns');
    const options = baseChartOptions();
    options.scales.y.min = lo - span * .12;
    options.scales.y.max = hi + span * .12;
    options.scales.y.ticks.callback = value => Number(value).toFixed(2);
    options.scales.x.ticks.callback = value => shortDate(labels[value]);
    options.plugins.tooltip.callbacks = {
      title(items) { return items.length ? jpDate(labels[items[0].dataIndex]) : ''; },
      label(context) {
        const value = Number(context.raw);
        return `${context.dataset.label}: ${value.toFixed(3)} (${pct(value - 100)})`;
      },
    };

    state.charts.returns = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '通常ホールド', data: hold, borderColor: '#5ce1a7', borderWidth: 2.2, pointRadius: 0, tension: .18, fill: false },
          { label: '複数日回避', data: avoid, borderColor: '#71a7ff', borderWidth: 2.2, pointRadius: 0, tension: .18, fill: false },
        ],
      },
      options,
    });

    const latest = points[points.length - 1];
    const cells = document.querySelectorAll('#returnSummary > div b');
    if (cells[0]) cells[0].textContent = pct(latest.hold - 100);
    if (cells[1]) cells[1].textContent = pct(latest.avoid - 100);
    if (cells[2]) cells[2].textContent = `${latest.avoid - latest.hold >= 0 ? '+' : ''}${(latest.avoid - latest.hold).toFixed(3)}pt`;
  }

  function renderRecent() {
    const body = document.getElementById('recentBody');
    if (!body) return;

    const rows = [...state.payload.data].reverse().slice(0, 14);
    body.innerHTML = rows.map(row => {
      const days = Number(row.days || 0);
      const fx = fxTotal(row);
      const fxClass = Number.isFinite(fx) && fx < 0 ? 'positive' : Number.isFinite(fx) ? 'negative' : '';
      return `<tr>
        <td data-label="日付"><a href="${row.source_url}" target="_blank" rel="noreferrer">${jpDate(row.date)}</a></td>
        <td data-label="日数"><span class="day-badge ${days >= 3 ? 'multi' : ''}">${days}D</span></td>
        <td data-label="Swap/日">${money(swapPerDay(row))}</td>
        <td data-label="付与総額">${money(swapTotal(row))}</td>
        <td data-label="USD/TRY">${isFiniteNumber(row.usdtry_rep_rate) ? rate4.format(Number(row.usdtry_rep_rate)) : '—'}</td>
        <td data-label="区間FX" class="${fxClass}">${Number.isFinite(fx) ? signedMoney(-fx) : '—'}</td>
      </tr>`;
    }).join('');
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function downloadCsv() {
    const header = [
      'date', 'days', 'lot_usd', 'sell_points', 'swap_yen_total', 'swap_yen_per_day',
      'usdtry_rate', 'usdjpy_rate', 'rate_hour_jst', 'next_date', 'fx_cost_yen_total',
      'fx_cost_yen_per_day', 'net_interval_yen', 'source_url'
    ];
    const rows = state.payload.data.map(row => [
      row.date,
      row.days,
      state.qty,
      row.sell_points,
      swapTotal(row) ?? '',
      swapPerDay(row) ?? '',
      row.usdtry_rep_rate ?? '',
      row.usdjpy_rep_rate ?? '',
      row.market_rate_hour_jst ?? '',
      row.usdtry_next_date ?? '',
      fxTotal(row) ?? '',
      fxDaily(row) ?? '',
      netInterval(row) ?? '',
      row.source_url,
    ]);
    const csv = '\uFEFF' + [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `USDTRY_dashboard_${state.qty}USD_${state.payload.meta.latest_date}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function render() {
    renderHeader();
    renderOverview();
    renderTrend();
    renderEvents();
    renderReturns();
    renderRecent();
  }

  function bindControls() {
    document.querySelectorAll('[data-qty]').forEach(button => {
      button.addEventListener('click', () => {
        state.qty = Number(button.dataset.qty);
        document.querySelectorAll('[data-qty]').forEach(item => item.classList.toggle('active', item === button));
        if (state.payload) render();
      });
    });

    document.querySelectorAll('[data-range]').forEach(button => {
      button.addEventListener('click', () => {
        state.range = button.dataset.range;
        document.querySelectorAll('[data-range]').forEach(item => item.classList.toggle('active', item === button));
        if (state.payload) renderTrend();
      });
    });

    document.getElementById('toggleFxMode')?.addEventListener('click', () => {
      state.fxMode = state.fxMode === 'avg7' ? 'daily' : 'avg7';
      if (state.payload) renderTrend();
    });

    document.getElementById('downloadCsv')?.addEventListener('click', downloadCsv);
  }

  function validatePayload(payload) {
    if (!payload || !Array.isArray(payload.data) || !payload.data.length) {
      throw new Error('data array is empty');
    }
    if (!payload.meta || payload.meta.latest_date !== payload.data[payload.data.length - 1].date) {
      throw new Error('metadata and data are inconsistent');
    }
  }

  async function load() {
    try {
      const response = await fetch(`./data/usdtry.json?v=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      validatePayload(payload);
      state.payload = payload;
      render();
    } catch (error) {
      console.error(error);
      setText('statusPill', 'データ取得エラー');
      document.getElementById('statusPill')?.classList.add('error');
      const body = document.getElementById('recentBody');
      if (body) body.innerHTML = '<tr><td colspan="6" class="loading-cell">データを読み込めませんでした</td></tr>';
    }
  }

  return { init() { bindControls(); load(); } };
})();

Dashboard.init();
