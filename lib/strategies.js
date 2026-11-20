'use strict';

/**
 * 策略库：参考 GitHub 高星量化项目中公开的经典思路，转写为可直接在
 * 日线 + 快照 + 财报数据上运行的评分规则。
 *
 * - microsoft/qlib 的 Alpha158 量价因子体系（多因子分位加权）
 * - vnpy / 海龟交易法则的通道突破与 ATR 波动度量
 * - backtrader 社区常用的双均线、动量、RSI 均值回归
 * - 神奇公式（ROE + 低估值）与 CANSLIM（成长 + 动量 + 量能）
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const pct = (v) => clamp(num(v, 50), 0, 100);
const round = (v) => Number(clamp(v, 0, 100).toFixed(1));

function scale(v, lo, hi) {
  if (!Number.isFinite(v)) return 50;
  return clamp(((v - lo) / (hi - lo)) * 100, 0, 100);
}

function grade(score) {
  if (score >= 78) return 'A';
  if (score >= 66) return 'B';
  return 'C';
}

const LIBRARY = [
  {
    key: 'alpha158',
    name: 'Alpha158 多因子',
    tag: 'Qlib',
    source: 'microsoft/qlib',
    desc: '借鉴 Qlib Alpha158 量价因子体系，把动量、均线、量能、波动、估值、成长六类因子分位加权，兼顾趋势与安全边际。',
    params: {},
    minScore: 58,
    score(item) {
      const t = item.technical;
      const f = item.factors;
      const score =
        0.2 * pct(f.momentum) +
        0.16 * pct(f.trend) +
        0.12 * pct(f.volume) +
        0.12 * pct(f.volatility) +
        0.13 * pct(f.valuation) +
        0.12 * pct(f.growth) +
        0.09 * clamp(t.rangePos * 100, 0, 100) +
        0.06 * scale(t.mom60 * 100, -20, 40);
      const reasons = [];
      if (t.mom20 > 0.05) reasons.push(`20日动量 +${(t.mom20 * 100).toFixed(1)}%`);
      if (t.mom60 > 0.12) reasons.push(`60日趋势 +${(t.mom60 * 100).toFixed(1)}%`);
      if (t.ma5 && t.ma20 && t.ma60 && t.ma5 > t.ma20 && t.ma20 > t.ma60) reasons.push('均线多头排列');
      if (f.volume > 65) reasons.push(`量能分位 ${Math.round(f.volume)}`);
      if (f.valuation > 65) reasons.push(`估值分位 ${Math.round(f.valuation)}`);
      if (f.growth > 65) reasons.push(`成长分位 ${Math.round(f.growth)}`);
      return { score, reasons, warnings: [] };
    },
  },
  {
    key: 'turtle',
    name: '海龟通道突破',
    tag: '趋势',
    source: '海龟交易法则 · vnpy',
    desc: '价格站上 20 日高点附近且中期趋势向上时入选；用 ATR 衡量波动，避免追高过度透支的标的。',
    params: { entry: 20 },
    minScore: 62,
    score(item, params) {
      const t = item.technical;
      const span = Number(params.entry) >= 55 ? 60 : 20;
      const channelHigh = span === 60 ? t.high60 : t.high20;
      const breakout = channelHigh > 0 && t.price >= channelHigh * 0.985;
      const dist = channelHigh > 0 ? t.price / channelHigh - 1 : 0;
      let score = breakout ? 34 : 10;
      score += clamp(t.trendScore * 0.26, 0, 26);
      score += pct(item.factors.momentum) * 0.16;
      score += t.mom60 > 0 ? 9 : 0;
      score += t.atrPct >= 0.01 && t.atrPct <= 0.06 ? 11 : 3;
      score += t.volRatio > 1.1 ? 6 : 0;
      score += t.macdHist > 0 ? 4 : 0;
      const reasons = [];
      if (breakout) reasons.push(`突破${span}日高点`);
      else if (dist > -0.05) reasons.push(`距${span}日高点 ${(dist * 100).toFixed(1)}%`);
      if (t.ma20 && t.ma60 && t.ma20 > t.ma60) reasons.push('中期趋势向上');
      if (t.mom60 > 0.1) reasons.push(`60日涨幅 +${(t.mom60 * 100).toFixed(1)}%`);
      reasons.push(`ATR ${(t.atrPct * 100).toFixed(1)}%`);
      return { score, reasons, warnings: breakout ? [] : ['尚未有效突破通道上沿'] };
    },
  },
  {
    key: 'ma_trend',
    name: '双均线趋势',
    tag: '趋势',
    source: 'backtrader 社区策略',
    desc: 'MA5 上穿 MA20 且 MA20 位于 MA60 上方时视为趋势启动，配合 MACD 红柱与动量确认。',
    params: {},
    minScore: 58,
    score(item) {
      const t = item.technical;
      let score = 0;
      if (t.goldCrossDays != null && t.goldCrossDays <= 5) score += 30;
      else if (t.goldCrossDays != null && t.goldCrossDays <= 12) score += 16;
      if (t.ma5 && t.ma20 && t.ma5 > t.ma20) score += 16;
      if (t.ma20 && t.ma60 && t.ma20 > t.ma60) score += 16;
      score += clamp(t.trendScore * 0.18, 0, 18);
      if (t.mom20 > 0) score += 10;
      if (t.macdHist > 0) score += 10;
      const reasons = [];
      if (t.goldCrossDays != null && t.goldCrossDays <= 5) reasons.push('MA5/MA20 近期金叉');
      if (t.ma5 && t.ma20 && t.ma5 > t.ma20) reasons.push('短期均线在上');
      if (t.ma20 && t.ma60 && t.ma20 > t.ma60) reasons.push('MA20 位于 MA60 上方');
      if (t.macdHist > 0) reasons.push('MACD 红柱');
      if (t.mom20 > 0) reasons.push(`20日涨幅 +${(t.mom20 * 100).toFixed(1)}%`);
      return { score, reasons, warnings: t.deadCrossDays != null && t.deadCrossDays <= 3 ? ['近期出现死叉'] : [] };
    },
  },
  {
    key: 'momentum',
    name: '动量轮动',
    tag: '动量',
    source: '量化社区动量因子',
    desc: '以 20/60 日收益与区间位置衡量相对强度，优先选择趋势延续、接近阶段高点的股票。',
    params: {},
    minScore: 58,
    score(item) {
      const t = item.technical;
      const score =
        0.34 * pct(item.factors.momentum) +
        0.22 * scale(t.mom60 * 100, -20, 45) +
        0.18 * pct(item.factors.trend) +
        0.14 * clamp(t.rangePos * 100, 0, 100) +
        0.12 * (t.price > t.ma20 ? 100 : 12);
      const reasons = [];
      if (t.mom20 > 0.08) reasons.push(`20日 +${(t.mom20 * 100).toFixed(1)}%`);
      if (t.mom60 > 0.15) reasons.push(`60日 +${(t.mom60 * 100).toFixed(1)}%`);
      if (t.rangePos > 0.7) reasons.push('处于区间高位');
      if (t.price > t.ma20) reasons.push('站上 MA20');
      return { score, reasons, warnings: t.rsi14 > 78 ? ['RSI 偏高，注意追涨风险'] : [] };
    },
  },
  {
    key: 'rsi_reversion',
    name: 'RSI 超跌反转',
    tag: '反转',
    source: 'backtrader / 量化社区',
    desc: 'RSI(14) 进入超卖区并出现企稳迹象时入选，适合震荡市做均值回归，趋势破坏时自动降分。',
    params: { low: 32 },
    minScore: 56,
    score(item, params) {
      const t = item.technical;
      const low = Number(params.low) || 32;
      const rsi = t.rsi14 == null ? 50 : t.rsi14;
      let score = 80 - Math.abs(rsi - (low - 2)) * 2.4;
      if (t.rsiPrev != null && rsi > t.rsiPrev) score += 7;
      if (t.rangePos < 0.35) score += 7;
      if (t.price < t.ma60) score -= 12;
      if (t.changePct > 0) score += 4;
      const reasons = [];
      reasons.push(`RSI ${rsi.toFixed(1)}`);
      if (t.rsiPrev != null && rsi > t.rsiPrev) reasons.push('RSI 低位回升');
      if (t.rangePos < 0.35) reasons.push('接近 20 日区间下沿');
      if (t.ma60 && t.price > t.ma60) reasons.push('仍处 MA60 上方');
      const warnings = [];
      if (t.price < t.ma60) warnings.push('位于 MA60 下方，趋势偏弱');
      return { score, reasons, warnings };
    },
  },
  {
    key: 'magic_formula',
    name: '神奇公式',
    tag: '价值',
    source: 'Joel Greenblatt',
    desc: '用 ROE 衡量资本回报、PE/PB 衡量价格，寻找「好公司 + 好价格」的组合，偏中长线。',
    params: { minRoe: 8 },
    minScore: 58,
    score(item, params) {
      const f = item.fundamentals;
      const minRoe = Number(params.minRoe) || 8;
      if (!f) {
        return { score: 32, reasons: [], warnings: ['暂无最新财报数据'] };
      }
      const roe = num(f.roe);
      const score =
        0.46 * scale(roe, 0, 30) +
        0.34 * pct(item.factors.valuation) +
        0.2 * (100 - scale(item.pb, 0, 10));
      const reasons = [];
      reasons.push(`ROE ${roe.toFixed(1)}%`);
      if (item.pe > 0) reasons.push(`PE ${item.pe.toFixed(1)}`);
      if (item.pb > 0) reasons.push(`PB ${item.pb.toFixed(2)}`);
      if (num(f.profitYoY) > 0) reasons.push(`净利同比 +${num(f.profitYoY).toFixed(1)}%`);
      const warnings = [];
      if (roe < minRoe) warnings.push(`ROE 低于 ${minRoe}% 门槛`);
      return { score, reasons, warnings };
    },
  },
  {
    key: 'canslim',
    name: 'CANSLIM 成长动量',
    tag: '成长',
    source: 'William O\u2019Neil',
    desc: '欧奈尔 CANSLIM 精简版：要求盈利与营收双增长，同时价格相对强度高、量能配合，偏好领涨成长股。',
    params: { minGrowth: 10 },
    minScore: 58,
    score(item, params) {
      const f = item.fundamentals;
      const minGrowth = Number(params.minGrowth) || 10;
      const t = item.technical;
      if (!f) {
        return { score: 34, reasons: [], warnings: ['暂无最新财报数据'] };
      }
      const profitYoY = num(f.profitYoY);
      const score =
        0.28 * scale(profitYoY, -20, 80) +
        0.14 * scale(num(f.revenueYoY), -10, 50) +
        0.24 * pct(item.factors.momentum) +
        0.16 * clamp(t.rangePos * 100, 0, 100) +
        0.1 * pct(item.factors.volume) +
        0.08 * (t.price >= t.high20 * 0.98 ? 100 : 30);
      const reasons = [];
      if (profitYoY > 0) reasons.push(`净利同比 +${profitYoY.toFixed(1)}%`);
      if (num(f.revenueYoY) > 0) reasons.push(`营收同比 +${num(f.revenueYoY).toFixed(1)}%`);
      if (t.mom60 > 0.1) reasons.push(`60日相对强度 +${(t.mom60 * 100).toFixed(1)}%`);
      if (t.volRatio > 1.2) reasons.push('量能配合');
      const warnings = [];
      if (profitYoY < minGrowth) warnings.push(`净利增速低于 ${minGrowth}%`);
      return { score, reasons, warnings };
    },
  },
  {
    key: 'low_vol_value',
    name: '低波动价值',
    tag: '防守',
    source: '量化社区低波因子',
    desc: '选择波动率低、估值便宜且仍站在 MA60 上方的股票，追求回撤可控的稳健组合。',
    params: {},
    minScore: 58,
    score(item) {
      const t = item.technical;
      const score =
        0.34 * pct(item.factors.volatility) +
        0.26 * pct(item.factors.valuation) +
        0.14 * (100 - scale(item.pb, 0, 10)) +
        0.14 * (t.ma60 && t.price > t.ma60 ? 100 : 25) +
        0.12 * (t.mom20 > 0 ? 100 : 40);
      const reasons = [];
      reasons.push(`年化波动 ${(t.vol20 * 100).toFixed(1)}%`);
      if (item.pe > 0) reasons.push(`PE ${item.pe.toFixed(1)}`);
      if (t.ma60 && t.price > t.ma60) reasons.push('站上 MA60');
      if (t.mom20 > 0) reasons.push('近 20 日正收益');
      return { score, reasons, warnings: [] };
    },
  },
];

const MAP = new Map(LIBRARY.map((s) => [s.key, s]));
const DEFAULT_STRATEGY = 'alpha158';

function metaOf(def) {
  return {
    key: def.key,
    name: def.name,
    tag: def.tag,
    source: def.source,
    desc: def.desc,
    params: def.params,
    minScore: def.minScore,
  };
}

function list() {
  return LIBRARY.map(metaOf);
}

function get(key) {
  return MAP.get(key) || MAP.get(DEFAULT_STRATEGY);
}

/** 对已计算好因子的候选池应用指定策略，返回覆盖得分后的列表 */
function scorePool(items, key, params = {}) {
  const def = get(key);
  const merged = { ...def.params, ...params };
  const scored = items.map((item) => {
    const out = def.score(item, merged);
    const score = round(out.score);
    return {
      ...item,
      score,
      strategyScore: score,
      grade: grade(score),
      reasons: (out.reasons || []).slice(0, 4),
      warnings: (out.warnings || []).slice(0, 2),
    };
  });
  scored.sort((a, b) => b.score - a.score || (b.technical?.mom20 || 0) - (a.technical?.mom20 || 0));
  return {
    items: scored,
    qualified: scored.filter((s) => s.score >= def.minScore).length,
    strategy: metaOf(def),
  };
}

module.exports = {
  LIBRARY,
  DEFAULT_STRATEGY,
  list,
  get,
  metaOf,
  scorePool,
};
