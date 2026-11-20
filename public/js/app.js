import { drawSparkline, drawKline, drawEquity, drawIntraday } from './chart.js';

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
  screenStrategy: 'volume_price',
  screenParams: {},
  screenLoading: false,
  stock: {
    code: '', name: '', period: 'day', series: null, detail: null,
    btDays: 500, layout: null,
    intraday: null, advice: null, adviceLoading: false, intradayLayout: null,
    intradayTimer: null, intradayLoadingCode: '',
  },
  picks: {
    data: null,
    loading: false,
    timer: null,
    filters: { minPrice: 2, maxPrice: 800, minMarketCap: 0, maxMarketCap: 100000 },
  },
  trade: { account: null, prices: {}, timer: null },
  portfolio: { holdings: [], diagnosis: null, timer: null, loading: false },
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
    if (!state.overview) {
      $('#indexGrid').innerHTML =
        '<div class="index-card"><div class="idx-name">行情数据暂不可用</div><div class="idx-price">--</div><div class="idx-row">请稍后刷新页面重试</div></div>';
    }
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

function strategyDef(key) {
  return (state.screenMeta?.strategies || []).find((s) => s.key === key) || null;
}

function collectFilters() {
  const filters = {};
  $$('[data-filter]').forEach((i) => { filters[i.dataset.filter] = Number(i.value); });
  filters.boards = $$('#boardFilter input[type="checkbox"][value]').filter((i) => i.checked).map((i) => i.value);
  filters.excludeST = $('#excludeST')?.checked ?? true;
  return filters;
}

function collectWeights() {
  const weights = {};
  $$('#weightSliders input[type="range"]').forEach((i) => { weights[i.dataset.key] = Number(i.value); });
  return weights;
}

async function initScreenControls() {
  let meta;
  try {
    meta = await apiGet('/api/screen/meta');
  } catch {
    return;
  }
  state.screenMeta = meta;
  if (!meta.strategies?.some((s) => s.key === state.screenStrategy)) {
    state.screenStrategy = meta.defaultStrategy || 'volume_price';
  }

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
    ['scanCount', '扫描成交额前 N 只', 'select', [300, 600, 936, 1200]],
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

  $('#boardFilter').innerHTML =
    meta.boards.map((b) => `<label><input type="checkbox" value="${b.key}" checked /> ${esc(b.label)}</label>`).join('') +
    '<label><input type="checkbox" id="excludeST" checked /> 排除 ST</label>';

  renderStrategyStrip();
  selectStrategy(state.screenStrategy, { auto: false });
  if (location.hash.startsWith('#/screen')) runStrategy();
}

function renderStrategyStrip() {
  const defs = state.screenMeta?.strategies || [];
  const cards = defs
    .map(
      (s) => `<div class="strategy-card" data-strategy="${esc(s.key)}">
        <div class="st-top"><b>${esc(s.name)}</b><span class="st-tag">${esc(s.tag)}</span></div>
        <p>${esc(s.desc)}</p>
        <div class="st-source">${esc(s.source)}</div>
      </div>`,
    )
    .join('');
  $('#strategyStrip').innerHTML =
    cards +
    `<div class="strategy-card" data-strategy="custom">
      <div class="st-top"><b>自定义多因子</b><span class="st-tag">手动</span></div>
      <p>自行调整动量、趋势、量能、波动、估值、成长六类因子的权重。</p>
      <div class="st-source">原有因子模型</div>
    </div>`;
}

function selectStrategy(key, opts = {}) {
  const def = strategyDef(key);
  const custom = !def;
  state.screenStrategy = custom ? 'custom' : def.key;
  $$('.strategy-card').forEach((c) => c.classList.toggle('active', c.dataset.strategy === state.screenStrategy));

  const panel = $('#strategyPanel');
  if (custom) {
    panel.innerHTML = `<div class="card-head"><h3>自定义多因子</h3><span class="hint">手动调权重</span></div>
      <p>按下方六类因子权重加权打分，适合有明确风格偏好的场景。</p>`;
    $('#factorPanel').hidden = false;
    $('#strategyParams').innerHTML = '';
    $('#runScreen').textContent = '运行量化选股';
  } else {
    state.screenParams = { ...(def.params || {}) };
    panel.innerHTML = `<div class="card-head"><h3>${esc(def.name)}</h3><span class="st-tag">${esc(def.tag)}</span></div>
      <p>${esc(def.desc)}</p>
      <div class="st-meta">来源：${esc(def.source)} · 入选阈值 ${def.minScore}</div>`;
    $('#factorPanel').hidden = true;
    const labels = { entry: '突破周期(20/60)', low: 'RSI 超卖线', minRoe: 'ROE 门槛(%)', minGrowth: '净利增速门槛(%)' };
    $('#strategyParams').innerHTML = Object.entries(def.params || {})
      .map(
        ([k, v]) => `<label class="field"><span>${esc(labels[k] || k)}</span>
          <input type="number" data-sparam="${esc(k)}" value="${v}" step="1" min="0" /></label>`,
      )
      .join('');
    $('#runScreen').textContent = '运行策略选股';
  }
  $('#screenNote').textContent =
    custom ? '选股基于公开行情与财报数据计算，仅供研究参考，不构成投资建议。' : `当前策略：${def ? def.name : ''}。结果与理由均由公开数据自动计算，不构成投资建议。`;
  if (opts.auto !== false) runStrategy();
}

async function runScreen() {
  await runStrategy();
}

async function runStrategy() {
  const btn = $('#runScreen');
  state.screenLoading = true;
  btn.disabled = true;
  btn.textContent = '策略扫描中…';
  const tbody = $('#screenTable tbody');
  tbody.innerHTML = Array.from({ length: 6 }, () => '<tr><td colspan="12"><div class="skeleton" style="margin:6px 0"></div></td></tr>').join('');
  $('#recGrid').innerHTML = '<div class="empty">正在扫描全市场并计算策略得分…</div>';

  const filters = collectFilters();
  const params = {};
  $$('[data-sparam]').forEach((i) => { params[i.dataset.sparam] = Number(i.value); });

  try {
    let data;
    if (state.screenStrategy === 'custom') {
      data = await apiPost('/api/screen', { weights: collectWeights(), filters });
    } else {
      data = await apiPost('/api/recommend', {
        strategy: state.screenStrategy,
        params,
        filters,
        scanCount: Number(filters.scanCount),
        candidates: Number(filters.candidates),
        limit: Number(filters.limit),
      });
    }
    state.screen = data;
    renderScreenResult(data);
    renderRecommendations(data);
  } catch (err) {
    toast(`选股失败：${err.message}`, true);
    tbody.innerHTML = `<tr><td colspan="12" class="empty">选股失败：${esc(err.message)}</td></tr>`;
  } finally {
    state.screenLoading = false;
    btn.disabled = false;
    btn.textContent = state.screenStrategy === 'custom' ? '运行量化选股' : '运行策略选股';
  }
}

function factorCell(v) {
  return `<td class="factor-cell"><div class="fb"><i style="width:${Math.round(v)}%"></i></div><span>${Math.round(v)}</span></td>`;
}

function renderRecommendations(data) {
  const items = data.items || [];
  const meta = data.meta || {};
  const def = strategyDef(state.screenStrategy);
  const title = def ? `${def.name} · 今日荐股` : '自定义多因子 · 选股结果';
  $('#recTitle').textContent = title;
  $('#recHint').textContent = `扫描 ${meta.scanned ?? 0} 只 · 符合策略 ${meta.qualified ?? 0} 只 · 市场${meta.market?.regime || '--'}`;

  if (!items.length) {
    $('#recGrid').innerHTML = '<div class="empty">暂无符合该策略的股票，可放宽过滤条件后重试</div>';
    return;
  }
  $('#recGrid').innerHTML = items
    .slice(0, 3)
    .map(
      (r, i) => `<div class="rec-item" data-code="${esc(r.code)}">
        <div class="rec-head">
          <div><span class="grade-badge ${esc(r.grade || 'C')}">${esc(r.grade || '-')}</span>
            <b style="margin-left:6px">${esc(r.name)}</b><code>${esc(r.code)}</code></div>
          <span class="rec-score">${Number(r.score).toFixed(1)}</span>
        </div>
        <div class="rec-sub"><span class="${cls(r.changePct)}">${fmt.price(r.price)} ${fmt.pct(r.changePct)}</span>
          <span style="color:var(--dim)">第 ${i + 1} 名</span></div>
        <div class="rec-reasons">${(r.reasons || r.signals || []).slice(0, 4).map((s) => `<span class="sig">${esc(s)}</span>`).join('')}</div>
        <div class="rec-foot"><span>PE ${r.pe > 0 ? r.pe.toFixed(1) : '亏损'} · 换手 ${Number(r.turnoverRate || 0).toFixed(1)}%</span>
          <button class="btn ghost" data-add-holding="${esc(r.code)}" data-name="${esc(r.name)}">+ 持仓</button></div>
      </div>`,
    )
    .join('');
}

function renderScreenResult(data) {
  const m = data.meta || {};
  const def = data.meta?.strategy || strategyDef(state.screenStrategy);
  $('#screenMeta').innerHTML = `
    <span>策略<b>${esc(def?.name || '自定义多因子')}</b></span>
    <span>扫描股票<b>${m.scanned ?? 0}</b></span>
    <span>通过过滤<b>${m.filtered ?? 0}</b></span>
    <span>技术评估<b>${m.evaluated ?? 0}</b></span>
    <span>符合策略<b>${m.qualified ?? 0}</b></span>
    <span>市场温度<b>${m.market?.regime || '--'} (${m.market?.breadth ?? '--'}%)</b></span>
    <span>耗时<b>${m.elapsedMs ?? 0} ms</b></span>
    <span>财报期<b>${esc(m.reportDate || '--')}</b></span>`;
  $('#screenHint').textContent = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 更新 · 按策略得分排序`;

  const tbody = $('#screenTable tbody');
  if (!data.items?.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">没有符合条件的结果，请放宽过滤条件</td></tr>';
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
        <td><div class="sig-list">${(r.reasons || r.signals || []).slice(0, 3).map((s) => `<span class="sig">${esc(s)}</span>`).join('') || '<span class="sig blue">趋势稳健</span>'}</div></td>
      </tr>`,
    )
    .join('');
}

/* ------------------------------ 荐股榜单 ------------------------------ */

const DEFAULT_PICKS_FILTERS = Object.freeze({ minPrice: 2, maxPrice: 800, minMarketCap: 0, maxMarketCap: 100000 });

function syncPicksFilterInputs() {
  $$('[data-picks-filter]').forEach((input) => {
    input.value = state.picks.filters[input.dataset.picksFilter];
  });
}

async function loadPicks(force = false) {
  if (state.picks.loading) return;
  state.picks.loading = true;
  $('#applyPicksFilters').disabled = true;
  if (!state.picks.data) {
    $('#marketPicksGrid').innerHTML = '<div class="empty">正在计算多策略综合评分…</div>';
    $('#picksTable tbody').innerHTML = '<tr><td colspan="9" class="empty">正在扫描候选池并运行 9 个策略…</td></tr>';
  }
  const query = new URLSearchParams({ limit: '20', ...state.picks.filters });
  if (force) query.set('refresh', '1');
  try {
    const data = await apiGet(`/api/picks?${query}`);
    state.picks.data = data;
    renderMarketPicks(data);
    renderPicks(data);
    if (force) toast('荐股榜单已刷新');
  } catch (err) {
    $('#marketPicksGrid').innerHTML = `<div class="empty">榜单加载失败：${esc(err.message)}</div>`;
    $('#picksTable tbody').innerHTML = `<tr><td colspan="9" class="empty">榜单加载失败：${esc(err.message)}</td></tr>`;
    $('#picksUpdated').textContent = '加载失败';
    if (force) toast(`榜单刷新失败：${err.message}`, true);
  } finally {
    state.picks.loading = false;
    $('#applyPicksFilters').disabled = false;
  }
}

function renderMarketPicks(data) {
  const items = (data.items || []).slice(0, 5);
  if (!items.length) {
    $('#marketPicksGrid').innerHTML = '<div class="empty">暂无可展示的荐股结果</div>';
    return;
  }
  const m = data.meta || {};
  $('#marketPicksHint').textContent = `${new Date(m.asOf).toLocaleTimeString('zh-CN', { hour12: false })} 更新 · 候选 ${m.candidates} 只 · 9 策略综合`;
  $('#marketPicksGrid').innerHTML = items
    .map(
      (r, i) => `<div class="pick-mini" data-code="${esc(r.code)}">
        <div class="pm-head">
          <span class="grade-badge ${esc(r.grade)}">${esc(r.grade)}</span>
          <b>${esc(r.name)}</b><code>${esc(r.code)}</code>
          <span class="pm-rank">#${i + 1}</span>
        </div>
        <div class="pm-body">
          <div class="pm-score">${r.consensus.toFixed(1)}<small>综合分</small></div>
          <div class="pm-px ${cls(r.changePct)}">${fmt.price(r.price)}<small>${fmt.pct(r.changePct)}</small></div>
        </div>
        <div class="pm-foot">
          <span>命中 ${r.qualified}/${r.strategyHits.length}</span>
          <span>最佳：${esc(r.bestStrategy?.name || '--')}</span>
        </div>
        <div class="pm-reason">${esc((r.reasons || [])[0] || r.label)}</div>
      </div>`,
    )
    .join('');
}

function renderPicks(data) {
  const m = data.meta || {};
  const items = data.items || [];
  $('#picksUpdated').textContent = `${new Date(m.asOf).toLocaleTimeString('zh-CN', { hour12: false })} 更新`;
  $('#picksMeta').innerHTML = `
    <span>扫描股票<b>${m.scanned ?? 0}</b></span>
    <span>通过过滤<b>${m.filtered ?? 0}</b></span>
    <span>技术评估<b>${m.evaluated ?? 0}</b></span>
    <span>候选池<b>${m.candidates ?? 0}</b></span>
    <span>市场温度<b>${m.market?.regime || '--'} (${m.market?.breadth ?? '--'}%)</b></span>
    <span>参与策略<b>${m.strategyCount ?? 9}</b></span>
    <span>耗时<b>${m.elapsedMs ?? 0} ms</b></span>`;
  $('#picksNote').textContent = data.disclaimer || '';
  const f = m.filters || state.picks.filters;
  $('#picksFilterSummary').textContent = `当前：股价 ${f.minPrice}–${f.maxPrice} 元，总市值 ${f.minMarketCap}–${f.maxMarketCap} 亿元；同时应用于首页荐股榜。`;

  $('#picksStrategyStats').innerHTML = (data.strategyStats || [])
    .map(
      (s) => `<div class="strategy-score-card">
        <div class="ssc-top"><b>${esc(s.name)}</b><span class="st-tag">${esc(s.tag)}</span></div>
        <div class="ssc-score">${s.avgScore.toFixed(1)}<small>平均分</small></div>
        <div class="ssc-bar"><i style="width:${Math.min(100, s.avgScore)}%"></i></div>
        <div class="ssc-foot">命中 ${s.passCount}/${m.candidates ?? '--'} · ${s.passRate.toFixed(0)}%</div>
      </div>`,
    )
    .join('');

  const tbody = $('#picksTable tbody');
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">暂无符合条件的结果</td></tr>';
    return;
  }
  tbody.innerHTML = items
    .map(
      (r, i) => `<tr data-code="${esc(r.code)}">
        <td class="num" style="color:var(--dim)">${i + 1}</td>
        <td><div class="name-cell"><b>${esc(r.name)}</b><span>${esc(r.code)}</span></div></td>
        <td class="num ${cls(r.changePct)}">${fmt.price(r.price)}</td>
        <td class="num ${cls(r.changePct)}">${fmt.pct(r.changePct)}</td>
        <td><div class="score-cell"><div class="score-bar"><i style="width:${Math.min(100, r.consensus)}%"></i></div>
          <span class="score-val">${r.consensus.toFixed(1)}</span>
          <span class="grade-badge ${esc(r.grade)}">${esc(r.label)}</span></div></td>
        <td class="num">${r.qualified}/${r.strategyHits.length}</td>
        <td><div class="name-cell"><b>${esc(r.bestStrategy?.name || '--')}</b><span>得分 ${r.bestStrategy?.score ?? '--'}</span></div></td>
        <td><div class="sig-list">${(r.reasons || []).slice(0, 2).map((s) => `<span class="sig">${esc(s)}</span>`).join('')}</div></td>
        <td><button class="btn ghost" data-open="${esc(r.code)}">分析</button></td>
      </tr>`,
    )
    .join('');
}

/* ------------------------------ 个股分析 ------------------------------ */

function setStockRoute(code) {
  location.hash = `#/stock?code=${code}`;
}

function stopIntradayAutoRefresh() {
  clearInterval(state.stock.intradayTimer);
  state.stock.intradayTimer = null;
}

function syncIntradayAutoRefresh() {
  stopIntradayAutoRefresh();
  if (state.stock.period !== 'min' || !state.stock.code || !location.hash.startsWith('#/stock')) return;
  state.stock.intradayTimer = setInterval(() => {
    if (!document.hidden) loadIntraday(state.stock.code, { silent: true });
  }, 30_000);
}

async function loadStock(code, period = state.stock.period) {
  if (!/^\d{6}$/.test(code)) {
    toast('请输入 6 位股票代码', true);
    return;
  }
  const codeChanged = state.stock.code !== code;
  state.stock.code = code;
  state.stock.period = period;
  syncIntradayAutoRefresh();
  if (codeChanged) {
    state.stock.advice = null;
    state.stock.intraday = null;
    $('#adviceBody').innerHTML = '<div class="empty">正在运行 9 个回测策略并计算权重…</div>';
    $('#adviceCard').hidden = false;
  }
  $('#stockMain').hidden = false;
  $('#backtestCard').hidden = false;
  $$('#periodSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.period === period));
  const emptyEl = $('#klineEmpty');
  emptyEl.style.display = 'grid';
  emptyEl.textContent = '加载行情中…';

  try {
    if (period === 'min') {
      $('#chartTitle').textContent = '分时走势';
      $('#maLegend').innerHTML = '<i style="background:#ff4d63"></i>价格 <i style="background:#f5c542"></i>均价 <i class="mark-buy">▲</i>买点 <i class="mark-sell">▼</i>卖点';
      $('#intradaySummary').hidden = false;
      if (!state.stock.detail || state.stock.detail.code !== code) {
        const detail = await apiGet(`/api/stock?code=${code}&period=day&count=320`);
        applyStockDetail(detail);
      }
      await loadIntraday(code);
    } else {
      $('#chartTitle').textContent = period === 'week' ? '周 K 线' : '日 K 线';
      $('#maLegend').innerHTML = '<i style="background:#f5c542"></i>MA5 <i style="background:#3ba9ff"></i>MA10 <i style="background:#a78bfa"></i>MA20 <i style="background:#7dd3a0"></i>MA60' +
        (period === 'day' ? ' <i style="background:#e879f9"></i>缠论笔 <i style="height:7px;background:rgba(59,169,255,.35)"></i>中枢' : '');
      $('#intradaySummary').hidden = true;
      const count = period === 'week' ? 260 : 320;
      const detail = await apiGet(`/api/stock?code=${code}&period=${period}&count=${count}`);
      applyStockDetail(detail);
      $('#klineEmpty').style.display = 'none';
      state.stock.layout = drawKline($('#klineCanvas'), detail.series, { showMacd: true, showChan: period === 'day' });
      state.stock.intradayLayout = null;
    }
  } catch (err) {
    const empty = $('#klineEmpty');
    empty.style.display = 'grid';
    empty.textContent = `加载失败：${err.message}`;
    toast(`个股数据加载失败：${err.message}`, true);
  }

  if (codeChanged || !state.stock.advice) loadAdvice(code);
}

function applyStockDetail(detail) {
  state.stock.detail = detail;
  state.stock.series = detail.series;
  state.stock.name = detail.name || '';
  renderStockHeader(detail);
  renderTech(detail);
  renderFund(detail);
  renderChanPanel(detail);
  document.title = `${detail.name || detail.code} · MONEY 量化终端`;
}

function renderChanPanel(detail) {
  const panel = $('#chanPanel');
  const visible = state.stock.period === 'day' && detail?.period === 'day' && detail.series?.chan;
  panel.hidden = !visible;
  if (!visible) {
    panel.innerHTML = '';
    return;
  }
  const c = detail.series.chan;
  const s = c.summary || {};
  const point = s.latestPoint;
  const pivot = s.latestPivot;
  const sector = state.stock.advice?.sector;
  panel.innerHTML = `
    <div class="chan-title"><b>缠论解读</b><span>已确认结构 · 标记位于确认 K 线</span></div>
    <div class="chan-tags">
      <span>最近笔 <b>${esc(s.trend || '震荡')}</b></span>
      <span>中枢位置 <b>${esc(s.position || '暂无中枢')}</b></span>
      <span>中枢区间 <b>${pivot ? `${fmt.price(pivot.low)} – ${fmt.price(pivot.high)}` : '--'}</b></span>
      <span>最近信号 <b class="${point?.side === 'buy' ? 'up' : point?.side === 'sell' ? 'down' : ''}">${point ? `${esc(point.type)} · ${esc(point.confirmDate)}` : '等待确认'}</b></span>
    </div>
    <ul>${(c.descriptions || []).map((text) => `<li>${esc(text)}</li>`).join('')}</ul>
    ${sector ? `<div class="chan-sector">板块情绪：${esc(sector.boardName || '行业数据降级')} · ${esc(sector.state || '中性')} ${fmt.price(sector.score)} 分，环境修正 ${fmt.signed(sector.adjustment || 0, 1)} 分。${esc(sector.available === false ? '当前按中性值降级，不影响原策略。' : '实时涨跌家数仅展示，不参与历史分。')}</div>` : ''}
    <p class="fineprint">缠论为固定规则的工程化近似，不覆盖所有主观流派与完整多级别递归；分型、笔和买卖点均有右侧确认滞后，禁止用极值日事后倒填信号。</p>`;
}

async function loadAdvice(code) {
  state.stock.adviceLoading = true;
  try {
    const data = await apiGet(`/api/stock/advice?code=${code}`);
    if (state.stock.code !== code) return;
    state.stock.advice = data;
    $('#adviceCard').hidden = false;
    renderAdvice(data);
  } catch (err) {
    $('#adviceBody').innerHTML = `<div class="empty">多策略建议生成失败：${esc(err.message)}</div>`;
    $('#adviceAsOf').textContent = '生成失败';
  } finally {
    state.stock.adviceLoading = false;
  }
}

function adviceTone(action) {
  if (action === 'buy') return 'buy';
  if (action === 'sell') return 'sell';
  return 'hold';
}

function renderAdvice(d) {
  const tone = adviceTone(d.action);
  if (state.stock.detail) renderChanPanel(state.stock.detail);
  const sector = d.sector || null;
  const rows = (d.strategies || [])
    .map(
      (s) => `<tr>
        <td><div class="name-cell"><b>${esc(s.name)}</b><span>${esc(s.desc || '')}</span></div></td>
        <td class="num ${s.metrics.totalReturn >= 0 ? 'up' : 'down'}">${fmt.pct(s.metrics.totalReturn)}</td>
        <td class="num">${s.metrics.winRate}%</td>
        <td class="num">${s.metrics.profitFactor != null ? s.metrics.profitFactor.toFixed(2) : '--'}</td>
        <td class="num ${s.metrics.maxDrawdown < 0 ? 'down' : ''}">${fmt.pct(s.metrics.maxDrawdown)}</td>
        <td class="num">${s.metrics.closedTrades}</td>
        <td><div class="weight-cell"><div class="weight-bar"><i style="width:${Math.min(100, s.weight)}%"></i></div><span>${s.weight.toFixed(1)}%</span></div></td>
        <td><span class="sig ${s.signal === 'long' ? 'buy' : 'sell'}">${s.signal === 'long' ? '持仓' : '空仓'}${s.fresh ? ' · 新信号' : ''}</span></td>
      </tr>`,
    )
    .join('');

  $('#adviceAsOf').textContent = `回测 ${d.days} 交易日 · ${new Date(d.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })} 更新`;
  $('#adviceBody').innerHTML = `
    <div class="advice-top">
      <div class="verdict ${tone}">
        <span>综合建议</span>
        <b>${esc(d.actionLabel)}</b>
        <em>置信度 ${d.confidence}%</em>
      </div>
      <div class="advice-gauge">
        <div class="gauge-num">${d.score.toFixed(1)}<small>/100</small></div>
        <div class="gauge-label">加权综合评分</div>
        <div class="gauge-track"><i class="${tone}" style="width:${Math.min(100, Math.max(0, d.score))}%"></i></div>
        <div class="gauge-split">
          <span class="up">多头权重 ${d.consensus.bullWeightPct}%</span>
          <span class="down">空头权重 ${d.consensus.bearWeightPct}%</span>
        </div>
      </div>
      <div class="advice-reasons">
        <div class="advice-consensus ${tone}">${esc(d.consensus.label)}</div>
        <b>${d.consensus.longCount}/${d.consensus.total} 个策略当前持仓</b>
        <ul>${(d.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        ${(d.warnings || []).length ? `<div class="advice-warn">${d.warnings.map((w) => `<span>⚠ ${esc(w)}</span>`).join('')}</div>` : ''}
      </div>
    </div>
    ${sector ? `<div class="sector-strip">
      <div><span>所属行业</span><b>${esc(sector.boardName || '暂不可用')}</b></div>
      <div><span>短线板块情绪</span><b>${esc(sector.state || '中性')} · ${fmt.price(sector.score)} 分</b></div>
      <div><span>综合分环境修正</span><b>${fmt.signed(sector.adjustment || 0, 1)} 分</b></div>
      <div><span>板块上涨 / 下跌家数</span><b>${sector.breadth ? `${sector.breadth.upCount ?? '--'} / ${sector.breadth.downCount ?? '--'}` : '仅实时展示，暂不可用'}</b></div>
      <p>${esc((sector.descriptions || []).join('；') || '板块情绪只作环境修正，不独立触发买卖点。')}</p>
    </div>` : ''}
    <div class="table-wrap advice-table-wrap">
      <table class="data-table advice-table">
        <thead><tr>
          <th>策略</th><th class="num">区间收益</th><th class="num">胜率</th><th class="num">盈亏比</th>
          <th class="num">最大回撤</th><th class="num">完成交易</th><th>权重</th><th>当前信号</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="fineprint">${esc(d.disclaimer)}</p>`;
}

async function loadIntraday(code, { silent = false } = {}) {
  if (state.stock.intradayLoadingCode === code) return;
  state.stock.intradayLoadingCode = code;
  const empty = $('#klineEmpty');
  if (!silent || !state.stock.intraday) {
    empty.style.display = 'grid';
    empty.textContent = '加载分时数据…';
  }
  try {
    const data = await apiGet(`/api/intraday?code=${code}`);
    if (state.stock.code !== code || state.stock.period !== 'min') return;
    state.stock.intraday = data;
    empty.style.display = 'none';
    state.stock.intradayLayout = drawIntraday($('#klineCanvas'), data);
    renderIntradaySummary(data);
  } catch (err) {
    if (silent && state.stock.intraday && state.stock.code === code) {
      const note = $('#intradayLiveNote');
      if (note) note.textContent = `本次自动刷新失败，保留上一快照：${err.message}`;
    } else {
      empty.style.display = 'grid';
      empty.textContent = `分时数据加载失败：${err.message}`;
      toast(`分时数据加载失败：${err.message}`, true);
    }
  } finally {
    if (state.stock.intradayLoadingCode === code) state.stock.intradayLoadingCode = '';
  }
}

function renderIntradaySummary(d) {
  const s = d.summary || {};
  const tone = s.stance === '偏多' ? 'up' : s.stance === '偏空' ? 'down' : 'flat';
  const markers = (d.markers || [])
    .slice(-6)
    .reverse()
    .map(
      (m) => `<span class="marker ${m.side}">
        <b>${m.side === 'buy' ? '买点' : '卖点'}</b> ${esc(m.time)} · ${fmt.price(m.price)}
        <em>${esc((m.reasons || []).join(' / '))}</em>
      </span>`,
    )
    .join('');
  $('#intradaySummary').innerHTML = `
    <div class="intraday-stats">
      <span>分时结论 <b class="${tone}">${esc(s.stance || '--')}</b></span>
      <span>现价 <b class="${cls(d.changePct)}">${fmt.price(d.price)} ${fmt.pct(d.changePct)}</b></span>
      <span>VWAP <b>${fmt.price(d.vwap)}</b></span>
      <span>高 / 低 <b>${fmt.price(d.high)} / ${fmt.price(d.low)}</b></span>
      <span>买卖点 <b><i class="dot-buy"></i>${s.buyCount || 0} / <i class="dot-sell"></i>${s.sellCount || 0}</b></span>
      <span>量比 / OBV <b>${fmt.price(s.volRatio)} / ${fmt.signed(s.obvStrength)}</b></span>
      <span>5 分钟缠论 <b>${d.chan?.latestPoint ? `${esc(d.chan.latestPoint.type)} · ${esc(d.chan.latestPoint.confirmTime || d.chan.latestPoint.confirmDate)}` : esc(d.chan?.trend || '等待确认')}</b></span>
      <span>板块情绪 <b>${d.sector ? `${esc(d.sector.boardName || '中性降级')} · ${esc(d.sector.state || '中性')} ${fmt.price(d.sector.score)}` : '--'}</b></span>
      <span>高位禁买 / 低位禁卖 <b>${s.blockedBuy || 0} / ${s.blockedSell || 0}</b></span>
      <span>数据时间 <b>${esc(d.dataTime || '--')}</b></span>
      <span>数据源 <b>${esc(d.source || '--')}</b></span>
    </div>
    <div class="marker-list">${markers || '<span class="hint">当日暂未触发多策略共识买卖点</span>'}</div>
    <p class="fineprint intraday-live" id="intradayLiveNote">${esc(d.live?.note || '分钟快照每 30 秒刷新，非逐笔实时信号。')}</p>`;
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

async function runBacktest() {
  if (!state.stock.code) return;
  const btn = $('#runBacktest');
  btn.disabled = true;
  btn.textContent = '综合回测中…';
  const days = Number($('#btDays').value) || 500;
  try {
    const qs = new URLSearchParams({ code: state.stock.code, days: String(days) });
    const data = await apiGet(`/api/backtest?${qs}`);
    renderBacktest(data);
  } catch (err) {
    toast(`回测失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '运行综合回测';
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
    ['盈亏比', m.profitFactor != null ? m.profitFactor.toFixed(2) : '--', m.profitFactor - 1],
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
  const sector = data.sector || {};
  const walk = data.walkForward || {};
  $('#btComposite').innerHTML = `
    <div class="bt-context">
      <span>最新综合分 <b>${fmt.price(data.composite?.score)}</b></span>
      <span>板块环境 <b>${esc(sector.boardName || '中性降级')} · ${esc(sector.state || '中性')} ${fmt.price(sector.score)}</b></span>
      <span>环境修正 <b>${fmt.signed(sector.adjustment || 0, 1)} 分</b></span>
      <span>调权区间 <b>${esc(walk.lastTraining?.start || '--')} 至 ${esc(walk.lastTraining?.end || '--')}</b></span>
    </div>
    <div class="bt-weight-grid">${(data.weights || []).map((w) => `
      <div><span>${esc(w.name)}</span><b>${Number(w.weight).toFixed(2)}%</b><em class="${w.signal === 'long' ? 'up' : 'down'}">${w.signal === 'long' ? '持仓' : '空仓'}</em></div>`).join('')}
    </div>
    <p class="fineprint">${esc(walk.execution || '收盘确认，下一交易日开盘成交')} · 每 ${walk.rebalanceEvery || 20} 个交易日调权，训练窗口最多 ${walk.trainingDays || 400} 日。${esc(sector.warning || walk.industryNote || '')}</p>`;
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

/* ------------------------------ 持仓信息 ------------------------------ */

const HOLD_KEY = 'money.portfolio.v1';
const ACTION_TEXT = { buy: '买入', add: '加仓', hold: '持有', watch: '观望', reduce: '减仓', exit: '清仓' };

function loadHoldings() {
  try {
    const raw = localStorage.getItem(HOLD_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) {
      state.portfolio.holdings = arr
        .filter((h) => /^\d{6}$/.test(String(h.code || '')))
        .slice(0, 30)
        .map((h) => ({
          code: String(h.code),
          name: String(h.name || ''),
          shares: Math.max(0, Math.floor(Number(h.shares) || 0)),
          cost: Math.max(0, Number(h.cost) || 0),
        }));
    }
  } catch {
    state.portfolio.holdings = [];
  }
}

function saveHoldings() {
  localStorage.setItem(HOLD_KEY, JSON.stringify(state.portfolio.holdings));
}

function diagnosisMap() {
  return new Map((state.portfolio.diagnosis?.items || []).map((i) => [i.code, i]));
}

function renderPfSummary() {
  const d = state.portfolio.diagnosis;
  const s = d?.summary;
  const counts = s?.actionCounts || {};
  const dist = Object.keys(ACTION_TEXT)
    .filter((k) => counts[k])
    .map((k) => `${ACTION_TEXT[k]} ${counts[k]}`)
    .join(' · ');
  $('#pfSummary').innerHTML = `
    <div class="account-card"><span>组合市值</span><b>¥${s ? fmt.price(s.marketValue) : '--'}</b><em class="flat">${s ? `${s.count} 只持仓` : '尚未诊断'}</em></div>
    <div class="account-card"><span>持仓成本</span><b>¥${s ? fmt.price(s.costValue) : '--'}</b><em class="flat">按成本价合计</em></div>
    <div class="account-card"><span>浮动盈亏</span><b class="${cls(s?.pnl || 0)}">${s ? fmt.signed(s.pnl) : '--'}</b><em class="${cls(s?.pnl || 0)}">${s ? fmt.pct(s.pnlPct) : ''}</em></div>
    <div class="account-card"><span>今日盈亏（估算）</span><b class="${cls(s?.dayPnl || 0)}">${s ? fmt.signed(s.dayPnl) : '--'}</b><em class="flat">按现价与昨收</em></div>
    <div class="account-card"><span>策略信号分布</span><b style="font-size:16px">${dist || '--'}</b><em class="flat">实时规则综合判断</em></div>`;
}

function renderPfEditor() {
  const tbody = $('#pfTable tbody');
  const holdings = state.portfolio.holdings;
  if (!holdings.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无持仓，请添加股票</td></tr>';
    return;
  }
  const map = diagnosisMap();
  tbody.innerHTML = holdings
    .map((h) => {
      const d = map.get(h.code);
      const price = d?.price || 0;
      const mv = d?.marketValue || price * h.shares;
      const pnl = d?.pnl ?? (h.cost > 0 ? (price - h.cost) * h.shares : 0);
      const pnlPct = d?.pnlPct ?? (h.cost > 0 && price > 0 ? (price / h.cost - 1) * 100 : 0);
      return `<tr data-code="${esc(h.code)}">
        <td><div class="name-cell"><b>${esc(d?.name || h.name || h.code)}</b><span>${esc(h.code)}</span></div></td>
        <td class="num"><input type="number" data-pf-shares="${esc(h.code)}" value="${h.shares}" step="100" min="0" /></td>
        <td class="num"><input type="number" data-pf-cost="${esc(h.code)}" value="${h.cost || ''}" step="0.01" min="0" placeholder="0.00" /></td>
        <td class="num ${cls(d?.changePct || 0)}">${price ? fmt.price(price) : '--'}</td>
        <td class="num">${price ? fmt.price(mv) : '--'}</td>
        <td class="num ${cls(pnl)}">${price ? `${fmt.signed(pnl)} (${fmt.pct(pnlPct)})` : '--'}</td>
        <td><button class="btn ghost danger" data-pf-del="${esc(h.code)}">删除</button></td>
      </tr>`;
    })
    .join('');
}

function renderPfDiagnosis() {
  const d = state.portfolio.diagnosis;
  const alerts = d?.summary?.riskAlerts || [];
  $('#pfAlerts').innerHTML = alerts.map((a) => `<div class="pf-alert">${esc(a)}</div>`).join('');
  const list = $('#pfDiagList');
  if (!d?.items?.length) {
    list.innerHTML = '<div class="diag-empty">添加持仓后自动给出持有 / 买入 / 减仓等信号</div>';
    return;
  }
  list.innerHTML = d.items
    .map((r) => {
      const lv = r.levels || {};
      return `<div class="diag-item" data-code="${esc(r.code)}">
        <div class="diag-head">
          <div class="nm"><b>${esc(r.name)}</b><code>${esc(r.code)}</code>
            <span class="badge ${esc(r.action)}">${esc(r.actionLabel || ACTION_TEXT[r.action] || '')}</span></div>
          <div style="text-align:right">
            <div class="${cls(r.changePct)}" style="font-family:var(--mono);font-size:13px">${fmt.price(r.price)} ${fmt.pct(r.changePct)}</div>
            <div class="hint">置信度 ${r.confidence}% · 风险 ${esc(r.riskLevel || '--')}</div>
          </div>
        </div>
        <div class="diag-meta">
          <span>持仓 ${r.shares} 股</span><span>成本 ${r.cost ? fmt.price(r.cost) : '--'}</span>
          <span class="${cls(r.pnl)}">浮盈 ${fmt.signed(r.pnl)} (${fmt.pct(r.pnlPct ?? 0)})</span>
          <span>市值 ${fmt.price(r.marketValue)}</span>
          <span>MA20 ${r.technical?.ma20 ? fmt.price(r.technical.ma20) : '--'}</span>
          <span>RSI ${r.technical?.rsi14 ? r.technical.rsi14.toFixed(1) : '--'}</span>
        </div>
        <div class="rec-reasons">${(r.reasons || []).map((s) => `<span class="sig">${esc(s)}</span>`).join('')}</div>
        ${r.warnings?.length ? `<div class="diag-warn">${r.warnings.map((w) => `<span>⚠ ${esc(w)}</span>`).join('')}</div>` : ''}
        ${lv.support ? `<div class="level-grid">
          <div><span>支撑位</span><b>${fmt.price(lv.support)}</b></div>
          <div><span>压力位</span><b>${fmt.price(lv.resistance)}</b></div>
          <div><span>止损位</span><b class="down">${fmt.price(lv.stopLoss)}</b></div>
          <div><span>目标位</span><b class="up">${fmt.price(lv.takeProfit)}</b></div>
        </div>` : ''}
      </div>`;
    })
    .join('');
}

async function addHolding() {
  const code = $('#pfCode').value.trim();
  let shares = Math.floor(Number($('#pfShares').value) || 0);
  let cost = Number($('#pfCost').value) || 0;
  if (!/^\d{6}$/.test(code)) return toast('请输入 6 位股票代码', true);
  if (shares < 0) shares = 0;

  let name = '';
  if (shares > 0 && cost <= 0) {
    try {
      const data = await apiGet(`/api/quotes?codes=${code}`);
      const q = data.items?.[0];
      if (q) {
        cost = q.price;
        name = q.name;
      }
    } catch {
      /* 无法获取现价时允许成本为 0 */
    }
  }

  const idx = state.portfolio.holdings.findIndex((h) => h.code === code);
  if (idx >= 0) {
    state.portfolio.holdings[idx] = {
      ...state.portfolio.holdings[idx],
      shares,
      cost: cost > 0 ? cost : state.portfolio.holdings[idx].cost,
      name: name || state.portfolio.holdings[idx].name,
    };
  } else {
    state.portfolio.holdings.push({ code, name, shares, cost });
  }
  saveHoldings();
  $('#pfCode').value = '';
  $('#pfShares').value = '';
  $('#pfCost').value = '';
  renderPfEditor();
  await diagnosePortfolio(true);
  toast(`${idx >= 0 ? '已更新' : '已添加'} ${code} · ${shares} 股`);
}

function importPaperHoldings() {
  const acc = state.trade.account || loadAccount();
  const positions = Object.values(acc.positions || {});
  if (!positions.length) return toast('模拟账户暂无持仓', true);
  let added = 0;
  for (const p of positions) {
    const idx = state.portfolio.holdings.findIndex((h) => h.code === p.code);
    const item = { code: p.code, name: p.name, shares: p.qty, cost: Number(p.cost.toFixed(2)) };
    if (idx >= 0) state.portfolio.holdings[idx] = item;
    else state.portfolio.holdings.push(item);
    added += 1;
  }
  saveHoldings();
  renderPfEditor();
  diagnosePortfolio(true);
  toast(`已导入 ${added} 只模拟持仓`);
}

async function diagnosePortfolio(showToast = false) {
  if (state.portfolio.loading) return;
  const holdings = state.portfolio.holdings;
  if (!holdings.length) {
    state.portfolio.diagnosis = null;
    renderPfSummary();
    renderPfEditor();
    renderPfDiagnosis();
    $('#pfUpdated').textContent = '--';
    return;
  }
  state.portfolio.loading = true;
  $('#pfDiagList').innerHTML = '<div class="diag-empty">正在获取实时行情并计算持仓信号…</div>';
  $('#pfUpdated').textContent = '诊断中…';
  try {
    const data = await apiPost('/api/portfolio/diagnose', { holdings });
    state.portfolio.diagnosis = data;
    renderPfSummary();
    if (!document.activeElement || !document.activeElement.closest('#pfTable')) renderPfEditor();
    renderPfDiagnosis();
    $('#pfUpdated').textContent = `${new Date(data.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })} 更新`;
    if (showToast) toast('持仓诊断已更新');
  } catch (err) {
    $('#pfDiagList').innerHTML = `<div class="diag-empty">诊断失败：${esc(err.message)}</div>`;
    $('#pfUpdated').textContent = '诊断失败';
    if (showToast) toast(`诊断失败：${err.message}`, true);
  } finally {
    state.portfolio.loading = false;
  }
}

function removeHolding(code) {
  state.portfolio.holdings = state.portfolio.holdings.filter((h) => h.code !== code);
  saveHoldings();
  renderPfEditor();
  diagnosePortfolio();
}

/* ------------------------------ 路由 ------------------------------ */

function setView(view) {
  $$('.view').forEach((v) => v.classList.remove('active'));
  $(`#view-${view}`)?.classList.add('active');
  $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  const titles = {
    market: '行情总览',
    picks: '荐股榜单',
    screen: '量化选股',
    portfolio: '持仓信息',
    stock: '个股分析',
    trade: '模拟交易',
    docs: '策略说明',
  };
  if (titles[view]) document.title = `${titles[view]} · MONEY 量化终端`;
  if (view === 'stock') syncIntradayAutoRefresh();
  else stopIntradayAutoRefresh();
  if (view === 'picks' || view === 'market') {
    if (!state.picks.data) loadPicks();
    clearInterval(state.picks.timer);
    state.picks.timer = setInterval(() => {
      const h = location.hash;
      if ((h.startsWith('#/picks') || h.startsWith('#/market')) && !state.picks.loading) loadPicks();
    }, 180_000);
  } else {
    clearInterval(state.picks.timer);
  }
  if (view === 'trade') {
    refreshPrices();
    clearInterval(state.trade.timer);
    state.trade.timer = setInterval(() => {
      if (location.hash.startsWith('#/trade')) refreshPrices();
    }, 60_000);
  } else {
    clearInterval(state.trade.timer);
  }
  if (view === 'portfolio') {
    renderPfSummary();
    if (state.portfolio.holdings.length) diagnosePortfolio();
    clearInterval(state.portfolio.timer);
    state.portfolio.timer = setInterval(() => {
      if (location.hash.startsWith('#/portfolio') && !state.portfolio.loading) diagnosePortfolio();
    }, 60_000);
  } else {
    clearInterval(state.portfolio.timer);
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function route() {
  const hash = location.hash || '#/market';
  const [path, query] = hash.replace(/^#\//, '').split('?');
  const params = new URLSearchParams(query || '');
  const view = ['market', 'picks', 'screen', 'portfolio', 'stock', 'trade', 'docs'].includes(path) ? path : 'market';

  if (view === 'stock') {
    setView('stock');
    const code = params.get('code');
    if (code && code !== state.stock.code) loadStock(code);
    else if (!code) {
      stopIntradayAutoRefresh();
      $('#stockMain').hidden = true;
      $('#backtestCard').hidden = true;
      $('#adviceCard').hidden = true;
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
  if (view === 'screen' && state.screenMeta && !state.screen && !state.screenLoading) runStrategy();
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
    const row = e.target.closest('.board-row, #quoteTable tbody tr, #screenTable tbody tr, #picksTable tbody tr, .pick-mini');
    if (!row || row.querySelector('.empty')) return;
    const code = row.dataset.code;
    if (code) setStockRoute(code);
  });

  // 荐股榜单
  $('#refreshPicks').addEventListener('click', () => loadPicks(true));
  $('#picksFilters').addEventListener('submit', (e) => {
    e.preventDefault();
    const next = {};
    $$('[data-picks-filter]').forEach((input) => { next[input.dataset.picksFilter] = Number(input.value); });
    if (next.minPrice > next.maxPrice || next.minMarketCap > next.maxMarketCap) {
      toast('筛选下限不能大于上限', true);
      return;
    }
    state.picks.filters = next;
    state.picks.data = null;
    loadPicks(true);
  });
  $('#resetPicksFilters').addEventListener('click', () => {
    state.picks.filters = { ...DEFAULT_PICKS_FILTERS };
    state.picks.data = null;
    syncPicksFilterInputs();
    loadPicks(true);
  });

  // 选股
  $('#runScreen').addEventListener('click', runScreen);
  $('#strategyStrip').addEventListener('click', (e) => {
    const card = e.target.closest('[data-strategy]');
    if (card) selectStrategy(card.dataset.strategy);
  });
  $('#recGrid').addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add-holding]');
    if (add) {
      e.stopPropagation();
      const code = add.dataset.addHolding;
      let price = 0;
      let name = add.dataset.name || '';
      try {
        const data = await apiGet(`/api/quotes?codes=${code}`);
        const q = data.items?.[0];
        if (q) {
          price = q.price;
          name = q.name || name;
        }
      } catch {
        /* 允许先添加再由诊断补齐 */
      }
      const idx = state.portfolio.holdings.findIndex((h) => h.code === code);
      const holding = { code, name, shares: 100, cost: price || 0 };
      if (idx >= 0) state.portfolio.holdings[idx] = { ...state.portfolio.holdings[idx], ...holding };
      else state.portfolio.holdings.push(holding);
      saveHoldings();
      renderPfEditor();
      toast(`已加入持仓 ${name || code}，可在「持仓信息」调整股数与成本`);
      return;
    }
    const card = e.target.closest('.rec-item');
    if (card?.dataset.code) setStockRoute(card.dataset.code);
  });

  // 持仓信息
  $('#pfAdd').addEventListener('click', addHolding);
  $('#pfImport').addEventListener('click', importPaperHoldings);
  $('#pfRefresh').addEventListener('click', () => diagnosePortfolio(true));
  $('#pfCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') addHolding(); });
  $('#pfTable').addEventListener('click', (e) => {
    const del = e.target.closest('[data-pf-del]');
    if (del) removeHolding(del.dataset.pfDel);
  });
  $('#pfTable').addEventListener('change', (e) => {
    const sharesInput = e.target.closest('[data-pf-shares]');
    const costInput = e.target.closest('[data-pf-cost]');
    const code = sharesInput?.dataset.pfShares || costInput?.dataset.pfCost;
    if (!code) return;
    const holding = state.portfolio.holdings.find((h) => h.code === code);
    if (!holding) return;
    if (sharesInput) holding.shares = Math.max(0, Math.floor(Number(sharesInput.value) || 0));
    if (costInput) holding.cost = Math.max(0, Number(costInput.value) || 0);
    saveHoldings();
    diagnosePortfolio();
  });
  $('#pfDiagList').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const item = e.target.closest('.diag-item');
    if (item?.dataset.code) setStockRoute(item.dataset.code);
  });

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
  $('#runBacktest').addEventListener('click', runBacktest);

  // 图表十字光标（分时 / K 线）
  const klineCanvas = $('#klineCanvas');
  klineCanvas.addEventListener('mousemove', (e) => {
    const rect = klineCanvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const tip = $('#klineTip');
    if (state.stock.period === 'min') {
      const data = state.stock.intraday;
      const layout = state.stock.intradayLayout;
      if (!data || !layout) return;
      const idx = layout.indexFromX(px);
      state.stock.intradayLayout = drawIntraday(klineCanvas, data, { hoverIndex: idx });
      const b = data.bars[idx];
      if (!b) return;
      const prev = idx ? data.bars[idx - 1].price : data.prevClose;
      const chg = ((b.price / prev - 1) * 100).toFixed(2);
      tip.innerHTML = `
        <div><span class="k">时间</span> ${b.time}</div>
        <div><span class="k">价格</span> ${fmt.price(b.price)} <span class="k">均价</span> ${fmt.price(b.avg)}</div>
        <div><span class="k">较前</span> <span class="${cls(Number(chg))}">${fmt.pct(Number(chg))}</span></div>
        <div><span class="k">成交量</span> ${fmt.money(b.volume)}股</div>
        <div><span class="k">昨收</span> ${fmt.price(data.prevClose)}</div>`;
      tip.hidden = false;
      const tw = tip.offsetWidth || 160;
      const left = px + 18 + tw > rect.width ? px - tw - 14 : px + 18;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${Math.min(Math.max(6, py - 60), rect.height - 120)}px`;
      return;
    }
    const layout = state.stock.layout;
    const series = state.stock.series;
    if (!layout || !series) return;
    const idx = layout.indexFromX(px);
    state.stock.layout = drawKline(klineCanvas, series, { showMacd: true, showChan: state.stock.period === 'day', hoverIndex: idx, mouseY: py });
    const b = series.bars[idx];
    if (!b) return;
    const prev = series.bars[idx - 1]?.close ?? b.open;
    const chg = ((b.close / prev - 1) * 100).toFixed(2);
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
    if (state.stock.period === 'min' && state.stock.intraday) {
      state.stock.intradayLayout = drawIntraday(klineCanvas, state.stock.intraday);
    } else if (state.stock.series) {
      state.stock.layout = drawKline(klineCanvas, state.stock.series, { showMacd: true, showChan: state.stock.period === 'day' });
    }
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
      if (state.stock.period === 'min' && state.stock.intraday) {
        state.stock.intradayLayout = drawIntraday($('#klineCanvas'), state.stock.intraday);
      } else if (state.stock.series) {
        state.stock.layout = drawKline($('#klineCanvas'), state.stock.series, { showMacd: true, showChan: state.stock.period === 'day' });
      }
      if (state.stock.btCurve) drawEquity($('#equityCanvas'), state.stock.btCurve);
      if (state.overview) renderIndexCards(state.overview);
    }, 160);
  });
}

/* ------------------------------ 启动 ------------------------------ */

async function boot() {
  startClock();
  state.trade.account = loadAccount();
  loadHoldings();
  renderAccount();
  renderOrders();
  renderPfSummary();
  renderPfEditor();
  renderPfDiagnosis();
  bindEvents();
  syncPicksFilterInputs();
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

  // 先渲染视图骨架，再异步加载数据，避免首屏空白
  $('#indexGrid').innerHTML = ['上证指数', '深证成指', '创业板指', '沪深300']
    .map((n) => `<div class="index-card"><div class="idx-name">${n}</div><div class="idx-price">--</div><div class="idx-row">加载中…</div><canvas height="46"></canvas></div>`)
    .join('');
  route();
  loadQuotes();
  renderPositions();
  loadOverview();
  loadPicks();
  initScreenControls();
  setInterval(loadOverview, 60_000);
}

boot();
