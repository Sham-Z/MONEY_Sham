import { drawSparkline, drawKline, drawEquity } from './chart.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------ 工具 ------------------------------ */

const fmt = {
  price(v) {
    if (!Number.isFinite(v)) return '--';
    const d = Math.abs(v) < 1 ? 3 : 2;
    return v.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  pct(v, d = 2) {
    if (!Number.isFinite(v)) return '--';
    return `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
  },
  signed(v, d = 2) {
    if (!Number.isFinite(v)) return '--';
    return `${v > 0 ? '+' : ''}${v.toFixed(d)}`;
  },
  money(v) {
    if (!Number.isFinite(v) || v === 0) return '--';
    const abs = Math.abs(v);
    if (abs >= 1e12) return `${(v / 1e12).toFixed(2)} 万亿`;
    if (abs >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
    if (abs >= 1e4) return `${(v / 1e4).toFixed(2)} 万`;
    return v.toFixed(0);
  },
  amount(v) {
    if (!Number.isFinite(v) || v === 0) return '--';
    return fmt.money(v);
  },
  date(iso) {
    if (!iso) return '--';
    return String(iso).replace('T', ' ').slice(0, 16);
  },
};

const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function apiGet(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  const json = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (!res.ok || json.ok === false) throw new Error(json.error || `请求失败 (${res.status})`);
  return json;
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (!res.ok) throw new Error(json.error || `请求失败 (${res.status})`);
  return json;
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ------------------------------ 状态 ------------------------------ */

const state = {
  overview: null,
  quote: { page: 1, size: 50, sort: 'changepercent', asc: 0, search: '' },
  screenMeta: null,
  screen: null,
  stock: { code: '', name: '', period: 'day', series: null, detail: null, strategy: 'ma_cross', btDays: 500, layout: null },
  trade: { account: null, prices: {}, timer: null },
};

/* ------------------------------ 顶栏 ------------------------------ */

function renderTicker(indices) {
  const el = $('#ticker');
  el.innerHTML = (indices || [])
    .map(
      (i) => `<div class="tick"><b>${esc(i.short)}</b>
        <span class="${cls(i.changePct)}">${fmt.price(i.price)}</span>
        <em class="${cls(i.changePct)}">${fmt.pct(i.changePct)}</em></div>`,
    )
    .join('');
}

function startClock() {
  const el = $('#clock');
  const tick = () => {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}

/* ------------------------------ 行情总览 ------------------------------ */

async function loadOverview(force = false) {
  try {
    const data = await apiGet('/api/overview');
    state.overview = data;
    renderTicker(data.indices);
    renderIndexCards(data);
    renderBoards(data.boards);
    $('#turnoverTotal').textContent = fmt.money(data.turnoverTotal);
    $('#overviewTime').textContent = new Date(data.updatedAt).toLocaleTimeString('zh-CN', { hour12: false });
    $('#marketStatus')?.classList.add('ok');
    const badge = $('#market-status');
    badge.textContent = data.stale ? '缓存数据' : '实时行情已接入';
    badge.className = `chip dot${data.stale ? '' : ' live'}`;
    if (force) toast('行情已刷新');
  } catch (err) {
    toast(`行情加载失败：${err.message}`, true);
    const badge = $('#market-status');
    badge.textContent = '数据源异常';
    badge.className = 'chip dot error';
  }
}

function renderIndexCards(data) {
  const sparks = new Map((data.sparks || []).map((s) => [s.symbol, s.points]));
  const wrap = $('#indexGrid');
  wrap.innerHTML = data.indices
    .slice(0, 4)
    .map(
      (i, idx) => `
      <div class="index-card">
        <div class="idx-name">${esc(i.name)}</div>
        <div class="idx-amount">成交 ${fmt.money(i.amount)}</div>
        <div class="idx-price ${cls(i.changePct)}">${fmt.price(i.price)}</div>
        <div class="idx-row ${cls(i.changePct)}">
          <span>${fmt.signed(i.change)}</span><span>${fmt.pct(i.changePct)}</span>
        </div>
        <canvas data-spark="${idx}" height="46"></canvas>
      </div>`,
    )
    .join('');
  data.indices.slice(0, 4).forEach((i, idx) => {
    const canvas = wrap.querySelector(`canvas[data-spark="${idx}"]`);
    drawSparkline(canvas, sparks.get(i.symbol) || [], i.changePct >= 0);
  });
}

function renderBoards(boards) {
  const build = (rows, key, isPct) =>
    rows
      .map(
        (r, i) => `
        <div class="board-row" data-code="${esc(r.code)}">
          <span class="rk">${i + 1}</span>
          <span class="nm">${esc(r.name)}<code>${esc(r.code)}</code></span>
          <span class="px">${fmt.price(r.price)}</span>
          <span class="pct ${cls(isPct ? r.changePct : r.turnoverRate)}">${isPct ? fmt.pct(r.changePct) : `${r.turnoverRate.toFixed(2)}%`}</span>
        </div>`,
      )
      .join('');
  $('#boardGainers').innerHTML = build(boards.gainers, 'pct', true);
  $('#boardLosers').innerHTML = build(boards.losers, 'pct', true);
  $('#boardActives').innerHTML = boards.actives
    .map(
      (r, i) => `<div class="board-row" data-code="${esc(r.code)}">
        <span class="rk">${i + 1}</span>
        <span class="nm">${esc(r.name)}<code>${esc(r.code)}</code></span>
        <span class="px ${cls(r.changePct)}">${fmt.pct(r.changePct)}</span>
        <span class="pct">${fmt.amount(r.amount)}</span></div>`,
    )
    .join('');
  $('#boardTurnover').innerHTML = build(boards.turnover, 'turnover', false);
}

async function loadQuotes() {
  const tbody = $('#quoteTable tbody');
  tbody.innerHTML = `<tr><td colspan="8" class="empty">加载中…</td></tr>`;
  const q = state.quote;
  try {
    const data = await apiGet(`/api/quotes?page=${q.page}&size=${q.size}&sort=${q.sort}&asc=${q.asc}`);
    const rows = data.items || [];
    const filtered = q.search
      ? rows.filter((r) => r.name.includes(q.search) || r.code.includes(q.search))
      : rows;
    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty">没有匹配的股票</td></tr>`;
    } else {
      tbody.innerHTML = filtered
        .map(
          (r) => `<tr data-code="${esc(r.code)}">
            <td><div class="name-cell"><b>${esc(r.name)}</b><span>${esc(r.code)}</span></div></td>
            <td class="num ${cls(r.changePct)}">${fmt.price(r.price)}</td>
            <td class="num ${cls(r.changePct)}">${fmt.pct(r.changePct)}</td>
            <td class="num ${cls(r.changePct)}">${fmt.signed(r.change)}</td>
            <td class="num">${Number.isFinite(r.turnoverRate) ? r.turnoverRate.toFixed(2) + '%' : '--'}</td>
            <td class="num">${fmt.amount(r.amount)}</td>
            <td class="num">${r.pe > 0 ? r.pe.toFixed(2) : '亏损'}</td>
            <td class="num">${fmt.money(r.floatCap)}</td>
          </tr>`,
        )
        .join('');
    }
    $('#quotePageInfo').textContent = `第 ${q.page} 页`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">加载失败：${esc(err.message)}</td></tr>`;
  }
}

/* ------------------------------ 量化选股 ------------------------------ */

async function initScreenControls() {
  let meta;
  try {
    meta = await apiGet('/api/screen/meta');
  } catch {
    return;
  }
  state.screenMeta = meta;
  $('#weightSliders').innerHTML = meta.factors
    .map(
      (f) => `
      <div class="slider-row">
        <div class="slider-top"><label for="w-${f.key}">${esc(f.label)}</label><span class="val" id="wv-${f.key}">${f.default}</span></div>
        <input type="range" id="w-${f.key}" data-key="${f.key}" min="0" max="50" step="1" value="${f.default}" style="--p:${(f.default / 50) * 100}%" />
        <div class="desc">${esc(f.desc)}</div>
      </div>`,
    )
    .join('');

  $$('#weightSliders input[type="range"]').forEach((input) => {
    input.addEventListener('input', () => {
      $(`#wv-${input.dataset.key}`).textContent = input.value;
      input.style.setProperty('--p', `${(Number(input.value) / 50) * 100}%`);
    });
  });

  const fields = [
    ['scanCount', '扫描成交额前 N 只', 'select', [300, 600, 900, 1200]],
    ['candidates', '技术评估候选数', 'select', [40, 70, 100]],
    ['limit', '输出结果数', 'select', [12, 24, 40]],
    ['peMax', '市盈率上限', 'number', 150],
    ['minPrice', '最低价格', 'number', 2],
    ['maxPrice', '最高价格', 'number', 800],
    ['minFloatCap', '流通市值下限(亿)', 'number', 20],
    ['maxFloatCap', '流通市值上限(亿)', 'number', 8000],
    ['minTurnover', '换手率下限(%)', 'number', 0.5],
    ['maxTurnover', '换手率上限(%)', 'number', 30],
  ];
  $('#filterGrid').innerHTML = fields
    .map(([key, label, type, val]) => {
      if (type === 'select') {
        return `<label class="field"><span>${label}</span><select data-filter="${key}">
          ${val.map((v) => `<option value="${v}"${v === meta.defaults[key] ? ' selected' : ''}>${v}</option>`).join('')}
        </select></label>`;
      }
      return `<label class="field"><span>${label}</span><input type="number" data-filter="${key}" value="${val}" step="any" /></label>`;
    })
    .join('');

  $('#boardFilter').innerHTML = meta.boards
    .map(
      (b) => `<label><input type="checkbox" value="${b.key}" checked /> ${esc(b.label)}</label>
        <label><input type="checkbox" id="excludeST" checked /> 排除 ST</label>`,
    )
    .join('');
}

async function runScreen() {
  const btn = $('#runScreen');
  btn.disabled = true;
  btn.textContent = '因子计算中…';
  const tbody = $('#screenTable tbody');
  tbody.innerHTML = Array.from({ length: 6 }, () => `<tr><td colspan="12"><div class="skeleton" style="margin:6px 0"></div></td></tr>`).join('');

  const weights = {};
  $$('#weightSliders input[type="range"]').forEach((i) => { weights[i.dataset.key] = Number(i.value); });
  const filters = {};
  $$('[data-filter]').forEach((i) => { filters[i.dataset.filter] = Number(i.value); });
  filters.boards = $$('#boardFilter input[type="checkbox"][value]').filter((i) => i.checked).map((i) => i.value);
  filters.excludeST = $('#excludeST')?.checked ?? true;

  try {
    const data = await apiPost('/api/screen', { weights, filters });
    state.screen = data;
    renderScreenResult(data);
  } catch (err) {
    toast(`选股失败：${err.message}`, true);
    tbody.innerHTML = `<tr><td colspan="12" class="empty">选股失败：${esc(err.message)}</td></tr>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '运行量化选股';
  }
}

function factorCell(v) {
  return `<td class="factor-cell"><div class="fb"><i style="width:${Math.round(v)}%"></i></div><span>${Math.round(v)}</span></td>`;
}

function renderScreenResult(data) {
  const m = data.meta || {};
  $('#screenMeta').innerHTML = `
    <span>扫描股票<b>${m.scanned ?? 0}</b></span>
    <span>通过过滤<b>${m.filtered ?? 0}</b></span>
    <span>技术评估<b>${m.evaluated ?? 0}</b></span>
    <span>耗时<b>${m.elapsedMs ?? 0} ms</b></span>
    <span>财报期<b>${esc(m.reportDate || '--')}</b></span>
    <span>权重合计<b>${Object.values(m.weights || {}).reduce((a, b) => a + b, 0)}</b></span>`;
  $('#screenHint').textContent = `按综合得分排序 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;

  const tbody = $('#screenTable tbody');
  if (!data.items?.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="empty">没有符合条件的结果，请放宽过滤条件</td></tr>`;
    return;
  }
  tbody.innerHTML = data.items
    .map(
      (r, i) => `
      <tr data-code="${esc(r.code)}">
        <td class="num" style="color:var(--dim)">${i + 1}</td>
        <td><div class="name-cell"><b>${esc(r.name)}</b><span>${esc(r.code)}</span></div></td>
        <td class="num ${cls(r.changePct)}">${fmt.price(r.price)}</td>
        <td class="num ${cls(r.changePct)}">${fmt.pct(r.changePct)}</td>
        <td><div class="score-cell"><div class="score-bar"><i style="width:${Math.min(100, r.score)}%"></i></div><span class="score-val">${r.score.toFixed(1)}</span></div></td>
        ${factorCell(r.factors.momentum)}${factorCell(r.factors.trend)}${factorCell(r.factors.volume)}
        ${factorCell(r.factors.volatility)}${factorCell(r.factors.valuation)}${factorCell(r.factors.growth)}
        <td><div class="sig-list">${(r.signals || []).slice(0, 3).map((s) => `<span class="sig">${esc(s)}</span>`).join('') || '<span class="sig blue">趋势稳健</span>'}</div></td>
      </tr>`,
    )
    .join('');
}

/* ------------------------------ 个股分析 ------------------------------ */

function setStockRoute(code) {
  location.hash = `#/stock?code=${code}`;
}

async function loadStock(code, period = state.stock.period) {
  if (!/^\d{6}$/.test(code)) {
    toast('请输入 6 位股票代码', true);
    return;
  }
  state.stock.code = code;
  state.stock.period = period;
  $('#stockMain').hidden = false;
  $('#backtestCard').hidden = false;
  $('#klineEmpty').hidden = false;
  $('#klineEmpty').textContent = '加载行情中…';

  const count = period === 'week' ? 260 : 320;
  try {
    const detail = await apiGet(`/api/stock?code=${code}&period=${period}&count=${count}`);
    state.stock.detail = detail;
    state.stock.series = detail.series;
    $('#klineEmpty').hidden = true;
    renderStockHeader(detail);
    state.stock.layout = drawKline($('#klineCanvas'), detail.series, { showMacd: true });
    renderTech(detail);
    renderFund(detail);
    renderBacktestControls(detail.strategies);
    document.title = `${detail.name || code} · MONEY 量化终端`;
  } catch (err) {
    $('#klineEmpty').hidden = false;
    $('#klineEmpty').textContent = `加载失败：${err.message}`;
    toast(`个股数据加载失败：${err.message}`, true);
  }
}

function renderStockHeader(d) {
  const q = d.quote || {};
  $('#stockHeader').innerHTML = `
    <div class="stock-title"><h2>${esc(d.name || q.name || d.code)}</h2><code>${esc(d.code)}${q.symbol ? ' · ' + esc(q.symbol.toUpperCase()) : ''}</code></div>
    <div class="stock-price ${cls(q.changePct)}">${fmt.price(q.price)}</div>
    <div class="stock-sub ${cls(q.changePct)}">
      <span>${fmt.signed(q.change)}</span><span>${fmt.pct(q.changePct)}</span>
      <span style="color:var(--dim);font-size:11px">${q.time ? String(q.time).slice(8, 10) + ':' + String(q.time).slice(10, 12) : ''}</span>
    </div>
    <div class="stock-stats">
      <div><span>市盈率</span><b>${q.pe > 0 ? q.pe.toFixed(2) : '亏损'}</b></div>
      <div><span>市净率</span><b>${q.pb ? q.pb.toFixed(2) : '--'}</b></div>
      <div><span>流通市值</span><b>${fmt.money(q.floatCap)}</b></div>
      <div><span>换手率</span><b>${q.turnoverRate ? q.turnoverRate.toFixed(2) + '%' : '--'}</b></div>
      <div><span>成交额</span><b>${fmt.amount(q.amount)}</b></div>
      <div><span>振幅</span><b>${q.amplitude ? q.amplitude.toFixed(2) + '%' : '--'}</b></div>
    </div>
    <div class="header-actions">
      <button class="btn ghost" id="gotoTrade">去模拟交易</button>
    </div>`;
  $('#gotoTrade')?.addEventListener('click', () => {
    location.hash = `#/trade?code=${d.code}`;
  });
}

function renderTech(d) {
  const t = d.technical;
  $('#techAsOf').textContent = d.series?.dates?.at(-1) || '';
  if (!t) {
    $('#techGrid').innerHTML = '<div style="grid-column:1/-1;color:var(--dim)">数据不足，无法计算指标</div>';
    return;
  }
  const items = [
    ['MA5', fmt.price(t.ma5)],
    ['MA10', fmt.price(t.ma10)],
    ['MA20', fmt.price(t.ma20)],
    ['MA60', fmt.price(t.ma60)],
    ['RSI(14)', t.rsi14 ? t.rsi14.toFixed(1) : '--'],
    ['MACD 柱', t.macdHist != null ? t.macdHist.toFixed(3) : '--'],
    ['20 日涨幅', fmt.pct((t.mom20 || 0) * 100)],
    ['60 日涨幅', fmt.pct((t.mom60 || 0) * 100)],
    ['年化波动', `${(t.vol20 * 100).toFixed(1)}%`],
    ['量能比', t.volRatio.toFixed(2)],
  ];
  $('#techGrid').innerHTML = items
    .map(([k, v]) => `<div><span>${k}</span><b class="${k.includes('涨幅') ? cls(v.startsWith('+') ? 1 : -1) : ''}">${v}</b></div>`)
    .join('');
  $('#stockSignals').innerHTML = (t.signals || []).map((s) => `<span class="sig">${esc(s)}</span>`).join('') || '<span class="sig blue">暂无明显信号</span>';
}

function renderFund(d) {
  const f = d.fundamentals;
  $('#fundDate').textContent = d.reportDate || '';
  if (!f) {
    $('#fundGrid').innerHTML = '<div style="grid-column:1/-1;color:var(--dim)">暂无该股票财报记录</div>';
    return;
  }
  const items = [
    ['营业收入', fmt.money(f.revenue)],
    ['归母净利润', fmt.money(f.netProfit)],
    ['每股收益', f.eps ? f.eps.toFixed(2) + ' 元' : '--'],
    ['ROE', f.roe ? f.roe.toFixed(2) + '%' : '--'],
    ['营收同比', fmt.pct(f.revenueYoY)],
    ['净利同比', fmt.pct(f.profitYoY)],
  ];
  $('#fundGrid').innerHTML = items
    .map(([k, v]) => `<div><span>${k}</span><b class="${k.includes('同比') ? cls(v.startsWith('+') ? 1 : -1) : ''}">${v}</b></div>`)
    .join('');
}

/* --------------------------- 搜索建议 --------------------------- */

let searchTimer = null;
async function onSearchInput(value) {
  const box = $('#stockSuggest');
  const q = value.trim();
  clearTimeout(searchTimer);
  if (!q) {
    box.hidden = true;
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const data = await apiGet(`/api/search?q=${encodeURIComponent(q)}`);
      const items = data.items || [];
      if (!items.length) {
        box.hidden = true;
        return;
      }
      box.innerHTML = items
        .map((i) => `<div data-code="${esc(i.code)}"><span>${esc(i.name)}</span><code>${esc(i.code)} ${esc(i.market)}</code></div>`)
        .join('');
      box.hidden = false;
    } catch {
      box.hidden = true;
    }
  }, 220);
}

/* ------------------------------ 回测 ------------------------------ */

function renderBacktestControls(strategies) {
  if (!strategies || !strategies.length) return;
  const sel = $('#btStrategy');
  if (!sel.options.length) {
    sel.innerHTML = strategies.map((s) => `<option value="${s.key}">${esc(s.name)}</option>`).join('');
    sel.value = state.stock.strategy;
  }
  renderBtParams();
}

function currentStrategy() {
  return (state.stock.detail?.strategies || []).find((s) => s.key === state.stock.strategy);
}

function renderBtParams() {
  const s = currentStrategy();
  if (!s) return;
  const labels = {
    fast: '快线周期', slow: '慢线周期', period: '动量周期',
    low: 'RSI 买入', high: 'RSI 卖出', entry: '突破周期', exit: '离场周期',
  };
  $('#btParams').innerHTML =
    `<span class="hint" style="flex-basis:100%">${esc(s.desc)}</span>` +
    Object.entries(s.params)
      .map(
        ([k, v]) => `<label class="field" style="width:120px"><span>${labels[k] || k}</span>
          <input type="number" data-btparam="${k}" value="${v}" step="1" /></label>`,
      )
      .join('');
}

async function runBacktest() {
  const s = currentStrategy();
  if (!s || !state.stock.code) return;
  const btn = $('#runBacktest');
  btn.disabled = true;
  btn.textContent = '回测中…';
  const params = {};
  $$('[data-btparam]').forEach((i) => { params[i.dataset.btparam] = Number(i.value); });
  const days = Number($('#btDays').value) || 500;
  try {
    const qs = new URLSearchParams({ code: state.stock.code, strategy: s.key, days: String(days), ...params });
    const data = await apiGet(`/api/backtest?${qs}`);
    renderBacktest(data);
  } catch (err) {
    toast(`回测失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '运行回测';
  }
}

function renderBacktest(data) {
  const m = data.metrics;
  const cards = [
    ['总收益率', fmt.pct(m.totalReturn), m.totalReturn],
    ['年化收益', fmt.pct(m.annualized), m.annualized],
    ['最大回撤', fmt.pct(m.maxDrawdown), m.maxDrawdown],
    ['夏普比率', m.sharpe.toFixed(2), m.sharpe],
    ['胜率', `${m.winRate}%`, m.winRate - 50],
    ['交易次数', String(m.tradeCount), 0],
    ['基准收益', fmt.pct(m.benchmarkReturn), m.benchmarkReturn],
    ['期末资金', fmt.money(m.finalEquity), m.finalEquity - m.capital],
  ];
  $('#btMetrics').innerHTML = cards
    .map(([k, v, dir]) => `<div class="metric"><span>${k}</span><b class="${cls(dir)}">${v}</b></div>`)
    .join('');
  $('#btTrades').innerHTML = data.trades?.length
    ? data.trades
        .map(
          (t) => `<tr>
            <td>${esc(t.date)}</td>
            <td class="${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? '买入' : '卖出'}</td>
            <td class="num">${fmt.price(t.price)}</td>
            <td class="num">${t.shares}</td>
            <td class="num">${fmt.money(t.amount)}</td>
            <td class="num ${t.pnl != null ? cls(t.pnl) : 'flat'}">${t.pnl != null ? `${fmt.signed(t.pnl)} (${t.pnlPct}%)` : '--'}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="empty">该区间内没有触发交易</td></tr>';
  state.stock.btCurve = data.curve;
  const canvas = $('#equityCanvas');
  drawEquity(canvas, data.curve);
}

/* ------------------------------ 模拟交易 ------------------------------ */

const PF_KEY = 'money.paper.v1';
const INITIAL_CASH = 1_000_000;

function loadAccount() {
  try {
    const raw = localStorage.getItem(PF_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { cash: INITIAL_CASH, positions: {}, orders: [] };
}

function saveAccount(acc) {
  state.trade.account = acc;
  localStorage.setItem(PF_KEY, JSON.stringify(acc));
}

function feeOf(amount, side) {
  const commission = Math.max(5, amount * 0.00025);
  const transfer = amount * 0.00001;
  const stamp = side === 'sell' ? amount * 0.0005 : 0;
  return Number((commission + transfer + stamp).toFixed(2));
}

function positionList() {
  const acc = state.trade.account;
  return Object.values(acc.positions || {});
}

function accountSnapshot() {
  const acc = state.trade.account;
  let market = 0;
  let dayPnl = 0;
  for (const p of positionList()) {
    const q = state.trade.prices[p.code];
    const price = q?.price || p.cost;
    market += price * p.qty;
    if (q?.prevClose) dayPnl += (price - q.prevClose) * p.qty;
  }
  const total = acc.cash + market;
  return { total, market, cash: acc.cash, dayPnl, pnl: total - INITIAL_CASH, pnlPct: ((total - INITIAL_CASH) / INITIAL_CASH) * 100 };
}

function renderAccount() {
  const s = accountSnapshot();
  $('#accountGrid').innerHTML = `
    <div class="account-card"><span>总资产</span><b>¥${fmt.price(s.total)}</b><em class="${cls(s.pnl)}">${fmt.signed(s.pnl)} (${fmt.pct(s.pnlPct)})</em></div>
    <div class="account-card"><span>可用资金</span><b>¥${fmt.price(s.cash)}</b><em class="flat">现金</em></div>
    <div class="account-card"><span>持仓市值</span><b>¥${fmt.price(s.market)}</b><em class="flat">${positionList().length} 只持仓</em></div>
    <div class="account-card"><span>当日盈亏（估算）</span><b class="${cls(s.dayPnl)}">${fmt.signed(s.dayPnl)}</b><em class="flat">按现价与昨收</em></div>`;
}

function renderPositions() {
  const tbody = $('#positionTable tbody');
  const list = positionList();
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">暂无持仓</td></tr>';
    return;
  }
  tbody.innerHTML = list
    .map((p) => {
      const q = state.trade.prices[p.code];
      const price = q?.price || p.cost;
      const mv = price * p.qty;
      const pnl = (price - p.cost) * p.qty;
      const pnlPct = p.cost ? (price / p.cost - 1) * 100 : 0;
      return `<tr>
        <td><div class="name-cell"><b>${esc(p.name)}</b><span>${esc(p.code)}</span></div></td>
        <td class="num">${p.qty}</td>
        <td class="num">${fmt.price(p.cost)}</td>
        <td class="num ${cls(price - p.cost)}">${fmt.price(price)}</td>
        <td class="num">${fmt.price(mv)}</td>
        <td class="num ${cls(pnl)}">${fmt.signed(pnl)}</td>
        <td class="num ${cls(pnl)}">${fmt.pct(pnlPct)}</td>
        <td><button class="btn ghost" data-sell="${esc(p.code)}">卖出</button></td>
      </tr>`;
    })
    .join('');
}

function renderOrders() {
  const acc = state.trade.account;
  const tbody = $('#orderTable tbody');
  if (!acc.orders?.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无委托</td></tr>';
    return;
  }
  tbody.innerHTML = acc.orders
    .slice(0, 100)
    .map(
      (o) => `<tr>
        <td style="font-family:var(--mono);font-size:11.5px">${esc(o.time)}</td>
        <td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? '买入' : '卖出'}</td>
        <td><div class="name-cell"><b>${esc(o.name)}</b><span>${esc(o.code)}</span></div></td>
        <td class="num">${fmt.price(o.price)}</td>
        <td class="num">${o.qty}</td>
        <td class="num">${fmt.price(o.amount)}</td>
        <td class="num">${fmt.price(o.fee)}</td>
      </tr>`,
    )
    .join('');
}

async function refreshPrices() {
  const codes = positionList().map((p) => p.code);
  const watch = $('#orderCode').value.trim();
  if (watch && !codes.includes(watch)) codes.push(watch);
  if (!codes.length) return;
  try {
    const data = await apiGet(`/api/quotes?codes=${codes.join(',')}`);
    for (const q of data.items || []) state.trade.prices[q.code] = q;
    renderAccount();
    renderPositions();
    updateOrderQuote();
  } catch {
    /* 静默失败，保留旧价格 */
  }
}

function updateOrderQuote() {
  const code = $('#orderCode').value.trim();
  const q = state.trade.prices[code];
  const el = $('#orderQuote');
  if (!q) {
    el.textContent = '输入代码后自动获取现价';
    return;
  }
  el.innerHTML = `<b>${esc(q.name)}</b><span class="${cls(q.changePct)}">${fmt.price(q.price)} ${fmt.pct(q.changePct)}</span>
    <span style="color:var(--dim)">昨收 ${fmt.price(q.prevClose)}</span>`;
  const priceInput = $('#orderPrice');
  if (!priceInput.value || document.activeElement !== priceInput) priceInput.value = q.price.toFixed(2);
  updateOrderSummary();
}

function updateOrderSummary() {
  const price = Number($('#orderPrice').value) || 0;
  const qty = Number($('#orderQty').value) || 0;
  const amount = price * qty;
  if (!amount) {
    $('#orderSummary').textContent = '--';
    return;
  }
  const buyFee = feeOf(amount, 'buy');
  const sellFee = feeOf(amount, 'sell');
  $('#orderSummary').innerHTML =
    `成交金额 ¥${fmt.price(amount)}<br>` +
    `买入费用 ¥${fmt.price(buyFee)} · 卖出费用 ¥${fmt.price(sellFee)}<br>` +
    `<span style="color:var(--dim)">买入需 ¥${fmt.price(amount + buyFee)} · 卖出得 ¥${fmt.price(amount - sellFee)}</span>`;
}

function placeOrder(side) {
  const acc = state.trade.account;
  const code = $('#orderCode').value.trim();
  const price = Number($('#orderPrice').value);
  const qty = Math.floor(Number($('#orderQty').value));
  if (!/^\d{6}$/.test(code)) return toast('请输入 6 位股票代码', true);
  if (!Number.isFinite(price) || price <= 0) return toast('请输入有效委托价格', true);
  if (!Number.isFinite(qty) || qty < 100 || qty % 100 !== 0) return toast('委托数量需为 100 股的整数倍', true);

  const q = state.trade.prices[code];
  const name = q?.name || acc.positions[code]?.name || code;
  const amount = price * qty;
  const fee = feeOf(amount, side);
  const time = new Date().toLocaleString('zh-CN', { hour12: false });

  if (side === 'buy') {
    if (amount + fee > acc.cash + 1e-6) return toast('可用资金不足', true);
    acc.cash -= amount + fee;
    const pos = acc.positions[code] || { code, name, qty: 0, cost: 0 };
    const totalCost = pos.cost * pos.qty + amount + fee;
    pos.qty += qty;
    pos.cost = totalCost / pos.qty;
    pos.name = name;
    acc.positions[code] = pos;
  } else {
    const pos = acc.positions[code];
    if (!pos || pos.qty < qty) return toast('持仓数量不足', true);
    acc.cash += amount - fee;
    pos.qty -= qty;
    if (pos.qty === 0) delete acc.positions[code];
  }

  acc.orders = acc.orders || [];
  acc.orders.unshift({ time, side, code, name, price, qty, amount, fee });
  saveAccount(acc);
  renderAccount();
  renderPositions();
  renderOrders();
  toast(`${side === 'buy' ? '买入' : '卖出'} ${name} ${qty} 股 · 成交价 ¥${fmt.price(price)}`);
}

function resetAccount() {
  if (!window.confirm('确定重置模拟账户？所有持仓与委托记录将被清空。')) return;
  const acc = { cash: INITIAL_CASH, positions: {}, orders: [] };
  saveAccount(acc);
  renderAccount();
  renderPositions();
  renderOrders();
  toast('模拟账户已重置');
}

/* ------------------------------ 路由 ------------------------------ */

function setView(view) {
  $$('.view').forEach((v) => v.classList.remove('active'));
  $(`#view-${view}`)?.classList.add('active');
  $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  const titles = { market: '行情总览', screen: '量化选股', trade: '模拟交易', docs: '策略说明' };
  if (titles[view]) document.title = `${titles[view]} · MONEY 量化终端`;
  if (view === 'trade') {
    refreshPrices();
    clearInterval(state.trade.timer);
    state.trade.timer = setInterval(() => {
      if (location.hash.startsWith('#/trade')) refreshPrices();
    }, 60_000);
  } else {
    clearInterval(state.trade.timer);
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function route() {
  const hash = location.hash || '#/market';
  const [path, query] = hash.replace(/^#\//, '').split('?');
  const params = new URLSearchParams(query || '');
  const view = ['market', 'screen', 'stock', 'trade', 'docs'].includes(path) ? path : 'market';

  if (view === 'stock') {
    setView('stock');
    const code = params.get('code');
    if (code && code !== state.stock.code) loadStock(code);
    else if (!code) {
      $('#stockMain').hidden = true;
      $('#backtestCard').hidden = true;
      $('#stockHeader').innerHTML = '<div class="empty-block">输入股票代码或名称开始分析</div>';
    }
    return;
  }
  setView(view);
  if (view === 'trade') {
    const code = params.get('code');
    if (code) {
      $('#orderCode').value = code;
      refreshPrices().then(updateOrderQuote);
    }
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindEvents() {
  window.addEventListener('hashchange', route);

  // 行情总览
  $('#quoteSort').addEventListener('change', (e) => {
    state.quote.sort = e.target.value;
    state.quote.page = 1;
    loadQuotes();
  });
  $('#quoteAsc').addEventListener('click', (e) => {
    state.quote.asc = state.quote.asc ? 0 : 1;
    state.quote.page = 1;
    e.target.textContent = state.quote.asc ? '升序' : '降序';
    loadQuotes();
  });
  $('#quotePrev').addEventListener('click', () => {
    if (state.quote.page > 1) { state.quote.page -= 1; loadQuotes(); }
  });
  $('#quoteNext').addEventListener('click', () => { state.quote.page += 1; loadQuotes(); });
  let quoteSearchTimer = null;
  $('#quoteSearch').addEventListener('input', (e) => {
    clearTimeout(quoteSearchTimer);
    quoteSearchTimer = setTimeout(() => {
      state.quote.search = e.target.value.trim();
      loadQuotes();
    }, 200);
  });

  // 榜单 / 表格跳转
  document.addEventListener('click', (e) => {
    const row = e.target.closest('.board-row, #quoteTable tbody tr, #screenTable tbody tr');
    if (!row || row.querySelector('.empty')) return;
    const code = row.dataset.code;
    if (code) setStockRoute(code);
  });

  // 选股
  $('#runScreen').addEventListener('click', runScreen);

  // 个股
  $('#stockSearchInput').addEventListener('input', (e) => onSearchInput(e.target.value));
  $('#stockSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = e.target.value.trim();
      $('#stockSuggest').hidden = true;
      if (/^\d{6}$/.test(v)) setStockRoute(v);
      else toast('请输入 6 位股票代码', true);
    }
    if (e.key === 'Escape') $('#stockSuggest').hidden = true;
  });
  $('#stockSuggest').addEventListener('click', (e) => {
    const item = e.target.closest('[data-code]');
    if (!item) return;
    $('#stockSuggest').hidden = true;
    $('#stockSearchInput').value = '';
    setStockRoute(item.dataset.code);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) $('#stockSuggest').hidden = true;
  });
  $('#periodSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-period]');
    if (!btn || !state.stock.code) return;
    $$('#periodSwitch button').forEach((b) => b.classList.toggle('active', b === btn));
    loadStock(state.stock.code, btn.dataset.period);
  });
  $('#btStrategy').addEventListener('change', (e) => {
    state.stock.strategy = e.target.value;
    renderBtParams();
  });
  $('#runBacktest').addEventListener('click', runBacktest);

  // K 线十字光标
  const klineCanvas = $('#klineCanvas');
  klineCanvas.addEventListener('mousemove', (e) => {
    const layout = state.stock.layout;
    const series = state.stock.series;
    if (!layout || !series) return;
    const rect = klineCanvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const idx = layout.indexFromX(px);
    state.stock.layout = drawKline(klineCanvas, series, { showMacd: true, hoverIndex: idx, mouseY: py });
    const b = series.bars[idx];
    if (!b) return;
    const prev = series.bars[idx - 1]?.close ?? b.open;
    const chg = ((b.close / prev - 1) * 100).toFixed(2);
    const tip = $('#klineTip');
    tip.innerHTML = `
      <div><span class="k">日期</span> ${b.date}</div>
      <div><span class="k">开</span> ${fmt.price(b.open)} <span class="k">高</span> ${fmt.price(b.high)}</div>
      <div><span class="k">低</span> ${fmt.price(b.low)} <span class="k">收</span> ${fmt.price(b.close)}</div>
      <div><span class="k">涨跌</span> <span class="${cls(Number(chg))}">${fmt.pct(Number(chg))}</span></div>
      <div><span class="k">成交量</span> ${fmt.money(b.volume)}股</div>
      ${series.ma.ma5[idx] != null ? `<div><span class="k">MA5</span> ${fmt.price(series.ma.ma5[idx])} <span class="k">MA20</span> ${fmt.price(series.ma.ma20[idx])}</div>` : ''}`;
    tip.hidden = false;
    const tw = tip.offsetWidth || 160;
    const left = px + 18 + tw > rect.width ? px - tw - 14 : px + 18;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.min(Math.max(6, py - 60), rect.height - 110)}px`;
  });
  klineCanvas.addEventListener('mouseleave', () => {
    $('#klineTip').hidden = true;
    if (state.stock.series) state.stock.layout = drawKline(klineCanvas, state.stock.series, { showMacd: true });
  });

  // 回测净值光标
  const eqCanvas = $('#equityCanvas');
  eqCanvas.addEventListener('mousemove', (e) => {
    const curve = state.stock.btCurve;
    if (!curve) return;
    const rect = eqCanvas.getBoundingClientRect();
    const layout = drawEquity(eqCanvas, curve);
    if (!layout) return;
    const idx = layout.indexFromX(e.clientX - rect.left);
    drawEquity(eqCanvas, curve, idx);
    const p = curve[idx];
    const tip = $('#equityTip');
    tip.innerHTML = `<div><span class="k">日期</span> ${p.date}</div>
      <div><span class="k">策略净值</span> <span class="${cls(p.equity - 1)}">${(p.equity * 100).toFixed(1)}%</span></div>
      <div><span class="k">基准净值</span> ${(p.benchmark * 100).toFixed(1)}%</div>`;
    tip.hidden = false;
    tip.style.left = `${Math.min(rect.width - 170, e.clientX - rect.left + 16)}px`;
    tip.style.top = '14px';
  });
  eqCanvas.addEventListener('mouseleave', () => {
    $('#equityTip').hidden = true;
    if (state.stock.btCurve) drawEquity(eqCanvas, state.stock.btCurve);
  });

  // 模拟交易
  $('#orderCode').addEventListener('change', async () => {
    const code = $('#orderCode').value.trim();
    if (!/^\d{6}$/.test(code)) return;
    try {
      const data = await apiGet(`/api/quotes?codes=${code}`);
      const q = data.items?.[0];
      if (q) {
        state.trade.prices[code] = q;
        updateOrderQuote();
      } else toast('未找到该股票行情', true);
    } catch (err) {
      toast(`行情获取失败：${err.message}`, true);
    }
  });
  $('#orderPrice').addEventListener('input', updateOrderSummary);
  $('#orderQty').addEventListener('input', updateOrderSummary);
  $('#btnBuy').addEventListener('click', () => placeOrder('buy'));
  $('#btnSell').addEventListener('click', () => placeOrder('sell'));
  $('#refreshPositions').addEventListener('click', async () => {
    await refreshPrices();
    toast('持仓行情已刷新');
  });
  $('#resetAccount').addEventListener('click', resetAccount);
  $('.qty-shortcuts').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-qty]');
    if (!btn) return;
    const price = Number($('#orderPrice').value) || 0;
    const acc = state.trade.account;
    const maxShares = price > 0 ? Math.floor(acc.cash / price / 100) * 100 : 0;
    const v = btn.dataset.qty;
    if (v === 'half') $('#orderQty').value = Math.max(100, Math.floor(maxShares / 2 / 100) * 100);
    else if (v === 'all') $('#orderQty').value = Math.max(100, maxShares);
    else $('#orderQty').value = v;
    updateOrderSummary();
  });
  $('#positionTable').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sell]');
    if (!btn) return;
    const code = btn.dataset.sell;
    const pos = state.trade.account.positions[code];
    if (!pos) return;
    $('#orderCode').value = code;
    $('#orderQty').value = pos.qty;
    updateOrderQuote();
    updateOrderSummary();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // 窗口尺寸变化重绘
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.stock.series) state.stock.layout = drawKline($('#klineCanvas'), state.stock.series, { showMacd: true });
      if (state.stock.btCurve) drawEquity($('#equityCanvas'), state.stock.btCurve);
      if (state.overview) renderIndexCards(state.overview);
    }, 160);
  });
}

/* ------------------------------ 启动 ------------------------------ */

async function boot() {
  startClock();
  state.trade.account = loadAccount();
  renderAccount();
  renderOrders();
  bindEvents();
  $('#stockQuick').innerHTML = [
    ['600519', '贵州茅台'], ['300750', '宁德时代'],
    ['000001', '平安银行'], ['601318', '中国平安'], ['002594', '比亚迪'],
  ]
    .map(([code, name]) => `<button data-code="${code}">${name} ${code}</button>`)
    .join('');
  $('#stockQuick').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-code]');
    if (btn) setStockRoute(btn.dataset.code);
  });

  await Promise.all([loadOverview(), initScreenControls()]);
  loadQuotes();
  renderPositions();
  route();
  setInterval(loadOverview, 60_000);
}

boot();
