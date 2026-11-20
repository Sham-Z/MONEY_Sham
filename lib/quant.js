'use strict';

const ds = require('./datasource');
const ind = require('./indicators');
const strategies = require('./strategies');

/* ------------------------------------------------------------------ */
/* 因子定义                                                            */
/* ------------------------------------------------------------------ */

const FACTORS = [
  { key: 'momentum', label: '动量趋势', desc: '20/60 日涨幅加权，捕捉价格延续性', default: 22 },
  { key: 'trend', label: '均线结构', desc: '价格与 MA5/10/20/60 的多头排列程度', default: 20 },
  { key: 'volume', label: '量能异动', desc: '5 日均量相对 20 日均量的放大倍数', default: 15 },
  { key: 'volatility', label: '波动控制', desc: '20 日年化波动率越低得分越高', default: 13 },
  { key: 'valuation', label: '估值水平', desc: '基于市盈率 PE 的高低分位打分', default: 15 },
  { key: 'growth', label: '业绩成长', desc: '最新财报净利润与营收同比增速', default: 15 },
];

const BOARDS = [
  { key: 'main', label: '沪深主板' },
  { key: 'gem', label: '创业板' },
  { key: 'star', label: '科创板' },
];

const DEFAULT_FILTERS = {
  scanCount: 600,
  minPrice: 2,
  maxPrice: 800,
  minFloatCap: 20,
  maxFloatCap: 8000,
  minTurnover: 0.5,
  maxTurnover: 30,
  minChange: -8,
  maxChange: 9.8,
  peMax: 150,
  boards: ['main', 'gem', 'star'],
  candidates: 70,
  limit: 24,
  excludeST: true,
};

function boardOf(code) {
  if (/^(688|689)/.test(code)) return 'star';
  if (/^(300|301)/.test(code)) return 'gem';
  if (/^(60|00|001|002|003)/.test(code)) return 'main';
  if (/^[48]/.test(code)) return 'bj';
  return 'main';
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function scale(v, lo, hi) {
  if (!Number.isFinite(v)) return 50;
  return clamp(((v - lo) / (hi - lo)) * 100, 0, 100);
}

function pctileRank(values, v) {
  if (!values.length) return 50;
  let below = 0;
  for (const x of values) if (x < v) below += 1;
  return (below / values.length) * 100;
}

/* ------------------------------------------------------------------ */
/* 第一阶段：快照粗筛                                                   */
/* ------------------------------------------------------------------ */

function prefilter(rows, filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const boards = Array.isArray(f.boards) && f.boards.length ? f.boards : DEFAULT_FILTERS.boards;
  return rows.filter((r) => {
    if (!r.code || !r.name) return false;
    if (r.price <= 0) return false;
    if (/ST|退/i.test(r.name) && f.excludeST) return false;
    if (!boards.includes(boardOf(r.code))) return false;
    if (r.price < f.minPrice || r.price > f.maxPrice) return false;
    const floatCapYi = r.floatCap / 1e8;
    if (floatCapYi < f.minFloatCap || floatCapYi > f.maxFloatCap) return false;
    if (r.turnoverRate < f.minTurnover || r.turnoverRate > f.maxTurnover) return false;
    if (r.changePct < f.minChange || r.changePct > f.maxChange) return false;
    if (r.pe > f.peMax) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* 单只股票技术面计算                                                   */
/* ------------------------------------------------------------------ */

function daysSinceCross(fast, slow, type, lookback = 20) {
  for (let i = fast.length - 1; i > 0 && fast.length - i <= lookback; i -= 1) {
    const f0 = fast[i - 1];
    const s0 = slow[i - 1];
    const f1 = fast[i];
    const s1 = slow[i];
    if (f0 == null || s0 == null || f1 == null || s1 == null) continue;
    if (type === 'gold' && f0 <= s0 && f1 > s1) return fast.length - 1 - i;
    if (type === 'dead' && f0 >= s0 && f1 < s1) return fast.length - 1 - i;
  }
  return null;
}

function technicalProfile(bars) {
  if (bars.length < 70) return null;
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const last = closes[closes.length - 1];

  const ma5Series = ind.sma(closes, 5);
  const ma20Series = ind.sma(closes, 20);
  const ma5 = ma5Series.at(-1);
  const ma10 = ind.sma(closes, 10).at(-1);
  const ma20 = ma20Series.at(-1);
  const ma60 = ind.sma(closes, 60).at(-1);
  const mom20 = ind.pctChange(closes, 20);
  const mom60 = ind.pctChange(closes, 60);
  const ret5 = ind.pctChange(closes, 5);
  const ret10 = ind.pctChange(closes, 10);
  const vol20 = ind.annualVolatility(closes, 20);
  const rsiSeries = ind.rsi(closes, 14);
  const rsi14 = rsiSeries.at(-1);
  const rsiPrev = rsiSeries.at(-2);
  const { dif, dea, hist } = ind.macd(closes);
  const histLast = hist.at(-1);
  const histPrev = hist.at(-2);
  const volAvg5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const volAvg20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = volAvg20 > 0 ? volAvg5 / volAvg20 : 1;

  let trendScore = 0;
  if (ma20 && last > ma20) trendScore += 34;
  if (ma5 && ma10 && ma5 > ma10) trendScore += 14;
  if (ma10 && ma20 && ma10 > ma20) trendScore += 18;
  if (ma20 && ma60 && ma20 > ma60) trendScore += 22;
  if (ma5 && last > ma5) trendScore += 12;

  const recent20 = bars.slice(-20);
  const high20 = Math.max(...recent20.map((b) => b.high));
  const low20 = Math.min(...recent20.map((b) => b.low));
  const rangePos = high20 > low20 ? (last - low20) / (high20 - low20) : 0.5;
  const recent60 = bars.slice(-60);
  const high60 = Math.max(...recent60.map((b) => b.high));
  const low60 = Math.min(...recent60.map((b) => b.low));
  const atrPct = last > 0 ? ind.atr(bars, 14) / last : 0;
  const goldCrossDays = daysSinceCross(ma5Series, ma20Series, 'gold');
  const deadCrossDays = daysSinceCross(ma5Series, ma20Series, 'dead');

  const signals = [];
  if (histLast > 0 && histPrev <= 0) signals.push('MACD 金叉');
  if (histLast > 0 && histLast > histPrev) signals.push('MACD 红柱放大');
  if (goldCrossDays != null && goldCrossDays <= 5) signals.push('MA5/MA20 金叉');
  if (ma5 && ma10 && ma20 && last > ma5 && ma5 > ma10 && ma10 > ma20) signals.push('均线多头排列');
  if (volRatio > 1.5 && last > (ma20 || last)) signals.push('放量突破');
  if (rsi14 != null && rsi14 < 32) signals.push('RSI 超卖');
  if (rsi14 != null && rsi14 > 72) signals.push('RSI 超买');
  if (last >= high20 * 0.995) signals.push('创 20 日新高');
  if (momentumOf(mom20, mom60) > 0.1) signals.push('动量强劲');

  return {
    price: last,
    ma5,
    ma10,
    ma20,
    ma60,
    mom20,
    mom60,
    ret5,
    ret10,
    vol20,
    rsi14,
    rsiPrev,
    macdHist: histLast,
    macdHistPrev: histPrev,
    volRatio,
    trendScore: clamp(trendScore, 0, 100),
    rangePos,
    high20,
    low20,
    high60,
    low60,
    atrPct,
    goldCrossDays,
    deadCrossDays,
    signals,
  };
}

function momentumOf(mom20, mom60) {
  return (mom20 || 0) * 0.6 + (mom60 || 0) * 0.4;
}

/* ------------------------------------------------------------------ */
/* 选股主流程                                                           */
/* ------------------------------------------------------------------ */

async function screen(options = {}) {
  const started = Date.now();
  const filters = { ...DEFAULT_FILTERS, ...(options.filters || {}) };
  const weightsIn = options.weights || {};
  const weights = {};
  let weightSum = 0;
  for (const factor of FACTORS) {
    const w = clamp(Number(weightsIn[factor.key] ?? factor.default), 0, 100);
    weights[factor.key] = w;
    weightSum += w;
  }
  if (weightSum <= 0) {
    for (const factor of FACTORS) weights[factor.key] = factor.default;
    weightSum = FACTORS.reduce((a, b) => a + b.default, 0);
  }

  const scanCount = clamp(Number(filters.scanCount) || 600, 100, 1200);
  const limit = clamp(Number(filters.limit) || 24, 5, 60);
  const candidates = clamp(Number(filters.candidates) || 70, 20, 120);

  const [universe, fund] = await Promise.all([
    ds.sinaUniverse(scanCount),
    ds.fundamentals().catch(() => ({ reportDate: null, map: {}, count: 0 })),
  ]);

  const filtered = prefilter(universe, filters);
  if (!filtered.length) {
    return {
      items: [],
      meta: {
        scanned: universe.length,
        filtered: 0,
        evaluated: 0,
        reportDate: fund.reportDate,
        elapsedMs: Date.now() - started,
        weights,
        filters,
      },
    };
  }

  const pool = filtered.slice(0, candidates);
  const barsMap = new Map();
  const concurrency = 10;
  let cursor = 0;

  async function worker() {
    while (cursor < pool.length) {
      const idx = cursor;
      cursor += 1;
      const stock = pool[idx];
      try {
        barsMap.set(stock.code, await ds.kline(stock.code, { period: 'day', count: 150 }));
      } catch {
        /* 单只失败不影响整体 */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pool.length) }, worker));

  const evaluated = [];
  for (const stock of pool) {
    const bars = barsMap.get(stock.code);
    if (!bars) continue;
    const tech = technicalProfile(bars);
    if (!tech) continue;
    const f = fund.map[stock.code] || null;
    evaluated.push({ stock, tech, fund: f });
  }

  if (!evaluated.length) {
    return {
      items: [],
      meta: {
        scanned: universe.length,
        filtered: filtered.length,
        evaluated: 0,
        reportDate: fund.reportDate,
        elapsedMs: Date.now() - started,
        weights,
        filters,
      },
    };
  }

  const momValues = evaluated.map((e) => momentumOf(e.tech.mom20, e.tech.mom60));
  const volValues = evaluated.map((e) => e.tech.vol20);
  const peValues = evaluated.map((e) => e.stock.pe).filter((v) => v > 0);

  const items = evaluated.map((e) => {
    const { stock, tech, fund: f } = e;
    const scores = {
      momentum: clamp(0.65 * pctileRank(momValues, momentumOf(tech.mom20, tech.mom60)) + 0.35 * tech.rangePos * 100, 0, 100),
      trend: tech.trendScore,
      volume: scale(tech.volRatio, 0.55, 1.9),
      volatility: clamp(100 - scale(tech.vol20, 0.12, 0.85) * 0.9, 0, 100),
      valuation:
        stock.pe > 0
          ? clamp(100 - pctileRank(peValues, stock.pe) * 0.85 - (stock.pb > 8 ? 15 : 0), 0, 100)
          : 20,
      growth: f
        ? clamp(scale(0.7 * clamp(f.profitYoY, -60, 120) + 0.3 * clamp(f.revenueYoY, -60, 120), -40, 90), 0, 100)
        : 50,
    };
    let total = 0;
    for (const factor of FACTORS) total += (scores[factor.key] * weights[factor.key]) / weightSum;

    return {
      code: stock.code,
      symbol: stock.symbol,
      name: stock.name,
      price: stock.price,
      changePct: stock.changePct,
      turnoverRate: stock.turnoverRate,
      pe: stock.pe,
      pb: stock.pb,
      amount: stock.amount,
      floatCap: stock.floatCap,
      totalCap: stock.totalCap,
      board: boardOf(stock.code),
      fundamentals: f,
      technical: {
        price: tech.price,
        ma5: tech.ma5,
        ma10: tech.ma10,
        ma20: tech.ma20,
        ma60: tech.ma60,
        mom20: tech.mom20,
        mom60: tech.mom60,
        ret5: tech.ret5,
        ret10: tech.ret10,
        rsi14: tech.rsi14,
        rsiPrev: tech.rsiPrev,
        vol20: tech.vol20,
        volRatio: tech.volRatio,
        macdHist: tech.macdHist,
        macdHistPrev: tech.macdHistPrev,
        trendScore: tech.trendScore,
        rangePos: tech.rangePos,
        high20: tech.high20,
        low20: tech.low20,
        high60: tech.high60,
        low60: tech.low60,
        atrPct: tech.atrPct,
        goldCrossDays: tech.goldCrossDays,
        deadCrossDays: tech.deadCrossDays,
      },
      factors: scores,
      score: Number(total.toFixed(2)),
      signals: tech.signals,
    };
  });

  items.sort((a, b) => b.score - a.score);

  const breadthUp = universe.filter((r) => r.changePct > 0).length;
  const breadthDown = universe.filter((r) => r.changePct < 0).length;
  const breadth = breadthUp + breadthDown > 0 ? breadthUp / (breadthUp + breadthDown) : 0.5;
  const market = {
    up: breadthUp,
    down: breadthDown,
    breadth: Number((breadth * 100).toFixed(1)),
    regime: breadth >= 0.6 ? '偏强' : breadth <= 0.4 ? '偏弱' : '震荡',
  };

  const strategyKey = options.strategy && options.strategy !== 'custom' ? options.strategy : null;
  let resultItems = items;
  let qualified = items.length;
  let strategyMeta = null;
  if (strategyKey) {
    const applied = strategies.scorePool(items, strategyKey, options.params || {});
    resultItems = applied.items;
    qualified = applied.qualified;
    strategyMeta = applied.strategy;
  }

  return {
    items: resultItems.slice(0, limit),
    meta: {
      scanned: universe.length,
      filtered: filtered.length,
      evaluated: items.length,
      qualified,
      reportDate: fund.reportDate,
      elapsedMs: Date.now() - started,
      weights: strategyKey ? null : weights,
      filters,
      strategy: strategyMeta,
      market,
      asOf: new Date().toISOString(),
    },
  };
}

/** 策略荐股：用更大的股票池运行指定策略，返回可解释的推荐列表 */
async function recommend(options = {}) {
  const strategy = options.strategy && options.strategy !== 'custom' ? options.strategy : strategies.DEFAULT_STRATEGY;
  const result = await screen({
    ...options,
    strategy,
    params: options.params || {},
    filters: {
      ...(options.filters || {}),
      scanCount: clamp(Number(options.scanCount) || 800, 200, 1200),
      candidates: clamp(Number(options.candidates) || 100, 30, 120),
      limit: clamp(Number(options.limit) || 12, 5, 30),
    },
  });
  return {
    ...result,
    ok: true,
    strategy,
    disclaimer: '策略结果由公开行情与财报数据计算，仅供研究参考，不构成投资建议。',
  };
}

/* ------------------------------------------------------------------ */
/* 个股技术面 + 指标序列                                                */
/* ------------------------------------------------------------------ */

function buildSeries(bars) {
  const closes = bars.map((b) => b.close);
  const ma = {
    ma5: ind.sma(closes, 5),
    ma10: ind.sma(closes, 10),
    ma20: ind.sma(closes, 20),
    ma60: ind.sma(closes, 60),
  };
  const rsi = ind.rsi(closes, 14);
  const macd = ind.macd(closes);
  return {
    dates: bars.map((b) => b.date),
    bars,
    ma,
    rsi: rsi.map((v) => (v == null ? null : Number(v.toFixed(2)))),
    macd: {
      dif: macd.dif.map((v) => (v == null ? null : Number(v.toFixed(3)))),
      dea: macd.dea.map((v) => (v == null ? null : Number(v.toFixed(3)))),
      hist: macd.hist.map((v) => (v == null ? null : Number(v.toFixed(3)))),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 策略回测                                                             */
/* ------------------------------------------------------------------ */

const STRATEGIES = [
  {
    key: 'ma_cross',
    name: '双均线金叉',
    desc: 'MA(快) 上穿 MA(慢) 买入，下穿卖出，经典趋势跟随。',
    params: { fast: 5, slow: 20 },
  },
  {
    key: 'momentum',
    name: '动量轮动',
    desc: '收盘价站上 MA20 且 20 日收益为正时持有，否则空仓。',
    params: { period: 20 },
  },
  {
    key: 'rsi_reversion',
    name: 'RSI 均值回归',
    desc: 'RSI(14) 低于 32 买入，高于 68 卖出，捕捉超跌反弹。',
    params: { low: 32, high: 68 },
  },
  {
    key: 'breakout',
    name: '20 日突破',
    desc: '收盘突破前 20 日最高价买入，跌破前 10 日最低价卖出。',
    params: { entry: 20, exit: 10 },
  },
];

function buildSignals(strategy, params, closes, bars) {
  const n = closes.length;
  const signal = new Array(n).fill(0);
  if (strategy === 'ma_cross') {
    const fast = ind.sma(closes, Math.max(2, Number(params.fast) || 5));
    const slow = ind.sma(closes, Math.max(3, Number(params.slow) || 20));
    let hold = 0;
    for (let i = 1; i < n; i += 1) {
      if (fast[i] == null || slow[i] == null) {
        signal[i] = 0;
        continue;
      }
      const prevFast = fast[i - 1];
      const prevSlow = slow[i - 1];
      if (prevFast != null && prevSlow != null) {
        if (prevFast <= prevSlow && fast[i] > slow[i]) hold = 1;
        else if (prevFast >= prevSlow && fast[i] < slow[i]) hold = 0;
      }
      signal[i] = hold;
    }
    return signal;
  }
  if (strategy === 'momentum') {
    const period = Math.max(5, Number(params.period) || 20);
    const ma = ind.sma(closes, period);
    for (let i = 0; i < n; i += 1) {
      const ret = i >= period ? closes[i] / closes[i - period] - 1 : null;
      signal[i] = ret != null && ma[i] != null && closes[i] > ma[i] && ret > 0 ? 1 : 0;
    }
    return signal;
  }
  if (strategy === 'rsi_reversion') {
    const low = Number(params.low) || 32;
    const high = Number(params.high) || 68;
    const r = ind.rsi(closes, 14);
    let hold = 0;
    for (let i = 0; i < n; i += 1) {
      if (r[i] == null) {
        signal[i] = 0;
        continue;
      }
      if (!hold && r[i] < low) hold = 1;
      else if (hold && r[i] > high) hold = 0;
      signal[i] = hold;
    }
    return signal;
  }
  if (strategy === 'breakout') {
    const entry = Math.max(5, Number(params.entry) || 20);
    const exit = Math.max(3, Number(params.exit) || 10);
    let hold = 0;
    for (let i = entry + 1; i < n; i += 1) {
      const highPrev = Math.max(...bars.slice(i - entry, i).map((b) => b.high));
      const lowPrev = Math.min(...bars.slice(i - exit, i).map((b) => b.low));
      if (!hold && closes[i] > highPrev) hold = 1;
      else if (hold && closes[i] < lowPrev) hold = 0;
      signal[i] = hold;
    }
    return signal;
  }
  return signal;
}

async function backtest(code, options = {}) {
  const strategy = options.strategy || 'ma_cross';
  const params = options.params || {};
  const days = clamp(Number(options.days) || 500, 120, 800);
  const capital = clamp(Number(options.capital) || 1_000_000, 100_000, 1e9);
  const feeBuy = 0.00025 + 0.00001;
  const feeSell = 0.00025 + 0.00001 + 0.0005;
  const slip = 0.0005;

  const bars = await ds.kline(code, { period: 'day', count: days + 120 });
  const windowBars = bars.slice(-days);
  const closes = windowBars.map((b) => b.close);
  const signal = buildSignals(strategy, params, closes, windowBars);

  let cash = capital;
  let shares = 0;
  let entryCost = 0;
  const trades = [];
  const equity = new Array(closes.length);
  const benchmark = new Array(closes.length);

  for (let i = 0; i < closes.length; i += 1) {
    const px = closes[i];
    if (signal[i] === 1 && shares === 0) {
      const buyPx = px * (1 + slip);
      const maxShares = Math.floor(cash / (buyPx * (1 + feeBuy)) / 100) * 100;
      if (maxShares > 0) {
        const cost = maxShares * buyPx * (1 + feeBuy);
        cash -= cost;
        shares = maxShares;
        entryCost = cost;
        trades.push({
          date: windowBars[i].date,
          side: 'buy',
          price: Number(buyPx.toFixed(2)),
          shares: maxShares,
          amount: Number(cost.toFixed(2)),
        });
      }
    } else if (signal[i] === 0 && shares > 0 && i > 0) {
      const sellPx = px * (1 - slip);
      const gross = shares * sellPx;
      cash += gross * (1 - feeSell);
      const pnl = gross * (1 - feeSell) - entryCost;
      trades.push({
        date: windowBars[i].date,
        side: 'sell',
        price: Number(sellPx.toFixed(2)),
        shares,
        amount: Number(gross.toFixed(2)),
        pnl: Number(pnl.toFixed(2)),
        pnlPct: Number(((pnl / entryCost) * 100).toFixed(2)),
      });
      shares = 0;
      entryCost = 0;
    }
    equity[i] = cash + shares * px;
    benchmark[i] = (capital / closes[0]) * px;
  }
  if (shares > 0) {
    const lastPx = closes.at(-1);
    trades.push({
      date: windowBars.at(-1).date,
      side: 'sell',
      price: Number(lastPx.toFixed(2)),
      shares,
      amount: Number((shares * lastPx).toFixed(2)),
      pnl: Number((shares * lastPx * (1 - feeSell) - entryCost).toFixed(2)),
      pnlPct: Number((((shares * lastPx * (1 - feeSell) - entryCost) / entryCost) * 100).toFixed(2)),
      forced: true,
    });
    equity[equity.length - 1] = cash + shares * lastPx * (1 - feeSell);
    shares = 0;
  }

  const finalEquity = equity.at(-1);
  const totalReturn = finalEquity / capital - 1;
  const years = closes.length / 252;
  const annualized = years > 0 ? (1 + totalReturn) ** (1 / years) - 1 : 0;
  const dailyRets = [];
  for (let i = 1; i < equity.length; i += 1) dailyRets.push(equity[i] / equity[i - 1] - 1);
  const mean = dailyRets.reduce((a, b) => a + b, 0) / Math.max(1, dailyRets.length);
  const sd = ind.stdev(dailyRets);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  const closed = trades.filter((t) => t.side === 'sell');
  const wins = closed.filter((t) => (t.pnl || 0) > 0);

  const step = Math.max(1, Math.floor(closes.length / 240));
  const curve = [];
  for (let i = 0; i < closes.length; i += step) {
    curve.push({
      date: windowBars[i].date,
      equity: Number((equity[i] / capital).toFixed(4)),
      benchmark: Number((benchmark[i] / capital).toFixed(4)),
    });
  }
  if (curve.at(-1)?.date !== windowBars.at(-1).date) {
    curve.push({
      date: windowBars.at(-1).date,
      equity: Number((equity.at(-1) / capital).toFixed(4)),
      benchmark: Number((benchmark.at(-1) / capital).toFixed(4)),
    });
  }

  return {
    code,
    strategy,
    strategyName: STRATEGIES.find((s) => s.key === strategy)?.name || strategy,
    params,
    range: { start: windowBars[0].date, end: windowBars.at(-1).date, bars: closes.length },
    metrics: {
      totalReturn: Number((totalReturn * 100).toFixed(2)),
      annualized: Number((annualized * 100).toFixed(2)),
      maxDrawdown: Number((ind.maxDrawdown(equity) * 100).toFixed(2)),
      sharpe: Number(sharpe.toFixed(2)),
      winRate: closed.length ? Number(((wins.length / closed.length) * 100).toFixed(1)) : 0,
      tradeCount: trades.length,
      benchmarkReturn: Number(((closes.at(-1) / closes[0] - 1) * 100).toFixed(2)),
      finalEquity: Number(finalEquity.toFixed(2)),
      capital,
    },
    curve,
    trades: trades.slice(-40).reverse(),
  };
}

module.exports = {
  screen,
  recommend,
  backtest,
  buildSeries,
  technicalProfile,
  FACTORS,
  BOARDS,
  STRATEGIES,
  DEFAULT_FILTERS,
  boardOf,
};
