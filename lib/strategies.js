'use strict';

/**
 * 统一策略库：荐股榜单、个股综合建议、分时买卖点、策略回测共用同一组 key。
 *
 * 思路来源为 GitHub 高星量化框架中反复出现的公开策略范式：
 * - mementum/backtrader：双均线、MACD、RSI、布林带、KDJ 等经典指标策略
 * - vnpy/vnpy：海龟通道突破、ATR 与趋势过滤
 * - microsoft/qlib：动量、量价、OBV 等 Alpha 因子思路
 * - freqtrade/freqtrade：指标组合、量能确认与超买超卖保护
 *
 * 评分只使用日线技术面 + 量能，不再纳入低波动防守策略；基本面仍在页面展示，
 * 但不参与跨模块策略评分，保证四个模块可以互相验证。
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

function obvScore(t) {
  return scale(num(t.obvStrength), -0.55, 0.55);
}

function volumeReasons(t, reasons) {
  if (t.volRatio > 1.25) reasons.push(`量能放大 ${t.volRatio.toFixed(2)} 倍`);
  if (t.obvStrength > 0.12) reasons.push('OBV 资金流入');
  if (t.obvStrength < -0.12) reasons.push('OBV 资金流出');
}

const LIBRARY = [
  {
    key: 'ma_cross',
    name: '双均线趋势',
    tag: '趋势',
    source: 'mementum/backtrader',
    desc: 'MA5/MA20 金叉且 MA20 位于 MA60 上方时视为趋势启动，要求量能与 OBV 同向确认。',
    params: { fast: 5, slow: 20 },
    minScore: 58,
    score(item) {
      const t = item.technical;
      let score = 0;
      if (t.goldCrossDays != null && t.goldCrossDays <= 5) score += 26;
      else if (t.goldCrossDays != null && t.goldCrossDays <= 12) score += 13;
      if (t.ma5 && t.ma20 && t.ma5 > t.ma20) score += 16;
      if (t.ma20 && t.ma60 && t.ma20 > t.ma60) score += 16;
      score += clamp(t.trendScore * 0.16, 0, 16);
      if (t.macdHist > 0) score += 8;
      score += pct(item.factors.volume) * 0.1;
      score += obvScore(t) * 0.08;
      if (t.rsi14 > 78) score -= 12;
      const reasons = [];
      if (t.goldCrossDays != null && t.goldCrossDays <= 5) reasons.push('MA5/MA20 近期金叉');
      if (t.ma5 && t.ma20 && t.ma5 > t.ma20) reasons.push('短期均线在上');
      if (t.ma20 && t.ma60 && t.ma20 > t.ma60) reasons.push('MA20 位于 MA60 上方');
      volumeReasons(t, reasons);
      return { score, reasons, warnings: t.rsi14 > 78 ? ['短线超买，等待回踩'] : [] };
    },
  },
  {
    key: 'macd',
    name: 'MACD 趋势',
    tag: '趋势',
    source: 'mementum/backtrader',
    desc: 'DIF/DEA 金叉与红柱放大确认中期趋势，叠加 OBV 方向过滤无量假突破。',
    params: { fast: 12, slow: 26, signal: 9 },
    minScore: 56,
    score(item) {
      const t = item.technical;
      let score = 18;
      if (t.macdHist > 0) score += 24;
      if (t.macdHist > 0 && t.macdHist > t.macdHistPrev) score += 16;
      if (t.macdHist <= 0 && t.macdHist > t.macdHistPrev) score += 8;
      if (t.ma20 && t.price > t.ma20) score += 12;
      if (t.ma20 && t.ma60 && t.ma20 > t.ma60) score += 10;
      score += pct(item.factors.volume) * 0.12;
      score += obvScore(t) * 0.08;
      if (t.rsi14 > 80) score -= 12;
      const reasons = [];
      if (t.macdHist > 0 && t.macdHistPrev <= 0) reasons.push('MACD 刚金叉');
      else if (t.macdHist > 0) reasons.push('MACD 红柱');
      if (t.macdHist > t.macdHistPrev) reasons.push('红柱放大');
      volumeReasons(t, reasons);
      return { score, reasons, warnings: t.macdHist < 0 ? ['MACD 仍在零轴下方'] : [] };
    },
  },
  {
    key: 'momentum',
    name: '动量轮动',
    tag: '动量',
    source: 'microsoft/qlib',
    desc: '以 20/60 日收益与相对强度选择强势股，但对 RSI 过高、短期涨幅透支和放量滞涨主动降分。',
    params: { period: 20 },
    minScore: 58,
    score(item) {
      const t = item.technical;
      let score =
        0.3 * pct(item.factors.momentum) +
        0.2 * scale(t.mom60 * 100, -20, 45) +
        0.16 * pct(item.factors.trend) +
        0.12 * clamp(t.rangePos * 100, 0, 100) +
        0.12 * pct(item.factors.volume) +
        0.1 * obvScore(t);
      if (t.rsi14 > 78) score -= 18;
      if (t.ret5 > 0.16) score -= 14;
      if (t.rangePos > 0.92 && t.volRatio > 1.8 && t.changePct < 1) score -= 12;
      const reasons = [];
      if (t.mom20 > 0.08) reasons.push(`20日 +${(t.mom20 * 100).toFixed(1)}%`);
      if (t.mom60 > 0.15) reasons.push(`60日 +${(t.mom60 * 100).toFixed(1)}%`);
      if (t.price > t.ma20) reasons.push('站上 MA20');
      volumeReasons(t, reasons);
      const warnings = [];
      if (t.rsi14 > 78) warnings.push('RSI 偏高，不追高');
      if (t.ret5 > 0.16) warnings.push('5 日涨幅透支');
      return { score, reasons, warnings };
    },
  },
  {
    key: 'breakout',
    name: '20 日放量突破',
    tag: '突破',
    source: 'vnpy/vnpy · 海龟交易法则',
    desc: '突破 20 日通道必须有成交量与 OBV 配合；RSI 过高或 5 日涨幅过大时视为追高风险并降分。',
    params: { entry: 20, exit: 10 },
    minScore: 62,
    score(item, params) {
      const t = item.technical;
      const span = Number(params.entry) >= 55 ? 60 : 20;
      const channelHigh = span === 60 ? t.high60 : t.high20;
      const breakout = channelHigh > 0 && t.price >= channelHigh * 0.985;
      const dist = channelHigh > 0 ? t.price / channelHigh - 1 : 0;
      let score = breakout ? 28 : 8;
      score += clamp(t.trendScore * 0.2, 0, 20);
      score += pct(item.factors.momentum) * 0.12;
      score += pct(item.factors.volume) * 0.16;
      score += obvScore(t) * 0.14;
      score += t.mom60 > 0 ? 6 : 0;
      score += t.macdHist > 0 ? 4 : 0;
      if (t.rsi14 > 80) score -= 20;
      if (t.ret5 > 0.18) score -= 16;
      const reasons = [];
      if (breakout) reasons.push(`突破${span}日高点`);
      else if (dist > -0.05) reasons.push(`距${span}日高点 ${(dist * 100).toFixed(1)}%`);
      if (t.ma20 && t.ma60 && t.ma20 > t.ma60) reasons.push('中期趋势向上');
      volumeReasons(t, reasons);
      const warnings = [];
      if (!breakout) warnings.push('尚未有效突破通道上沿');
      if (t.rsi14 > 80 || t.ret5 > 0.18) warnings.push('突破位置过高，等待回踩确认');
      return { score, reasons, warnings };
    },
  },
  {
    key: 'rsi_reversion',
    name: 'RSI 超跌反转',
    tag: '反转',
    source: 'mementum/backtrader',
    desc: 'RSI 进入超卖区并回升时做均值回归，结合缩量回踩或放量止跌，避免在下跌中继接刀。',
    params: { period: 14, low: 32, high: 70 },
    minScore: 56,
    score(item, params) {
      const t = item.technical;
      const low = Number(params.low) || 32;
      const rsi = t.rsi14 == null ? 50 : t.rsi14;
      let score = 78 - Math.abs(rsi - (low - 2)) * 2.3;
      if (t.rsiPrev != null && rsi > t.rsiPrev) score += 9;
      if (t.rangePos < 0.35) score += 8;
      if (t.price < t.ma60) score -= 12;
      if (t.changePct > 0) score += 4;
      if (t.volRatio < 0.85 && t.rangePos < 0.4) score += 5;
      if (t.obvStrength > 0) score += 6;
      if (t.obvStrength < -0.25) score -= 8;
      const reasons = [`RSI ${rsi.toFixed(1)}`];
      if (t.rsiPrev != null && rsi > t.rsiPrev) reasons.push('RSI 低位回升');
      if (t.rangePos < 0.35) reasons.push('接近 20 日区间下沿');
      if (t.volRatio < 0.85) reasons.push('缩量回踩');
      volumeReasons(t, reasons);
      return { score, reasons, warnings: t.price < t.ma60 ? ['位于 MA60 下方，趋势偏弱'] : [] };
    },
  },
  {
    key: 'bollinger',
    name: '布林带回归',
    tag: '反转',
    source: 'mementum/backtrader',
    desc: '价格接近布林下轨并出现企稳时低吸，回到中轨/上轨逐步兑现；OBV 持续流出时降分。',
    params: { period: 20, mult: 2 },
    minScore: 56,
    score(item) {
      const t = item.technical;
      const mid = t.ma20 || t.price;
      const width = Math.max(0.001, (t.atrPct || 0.02) * 2);
      const z = (t.price - mid) / (mid * width);
      let score = 70 - Math.abs(z + 1.2) * 18;
      if (t.changePct > 0) score += 7;
      if (t.rsiPrev != null && t.rsi14 > t.rsiPrev) score += 6;
      if (t.ma60 && t.price > t.ma60) score += 8;
      score += pct(item.factors.volume) * 0.08;
      score += obvScore(t) * 0.12;
      if (z > 1.2) score -= 22;
      const reasons = [];
      if (z < -0.8) reasons.push('接近布林下轨');
      if (t.changePct > 0) reasons.push('当日企稳回升');
      if (t.ma60 && t.price > t.ma60) reasons.push('中期趋势未破坏');
      volumeReasons(t, reasons);
      return { score, reasons, warnings: z > 1.2 ? ['已接近布林上轨，不追高'] : [] };
    },
  },
  {
    key: 'kdj',
    name: 'KDJ 超跌',
    tag: '反转',
    source: 'freqtrade/freqtrade 指标组合',
    desc: 'K 值低位上穿 D 值捕捉超跌反弹，高位死叉提示兑现；用量能确认反弹有效性。',
    params: { period: 9, low: 20, high: 80 },
    minScore: 56,
    score(item) {
      const t = item.technical;
      const k = num(t.kdjK, 50);
      const d = num(t.kdjD, 50);
      let score = 62 - Math.abs(k - 18) * 1.4;
      if (k > d) score += 14;
      if (t.kdjGoldDays != null && t.kdjGoldDays <= 3) score += 16;
      if (t.rsiPrev != null && t.rsi14 > t.rsiPrev) score += 5;
      if (t.obvStrength > 0) score += 7;
      if (k > 82) score -= 24;
      const reasons = [`K/D ${k.toFixed(1)}/${d.toFixed(1)}`];
      if (t.kdjGoldDays != null && t.kdjGoldDays <= 3) reasons.push('KDJ 低位金叉');
      if (k < 20) reasons.push('K 值超卖');
      volumeReasons(t, reasons);
      return { score, reasons, warnings: k > 82 ? ['KDJ 高位，注意兑现'] : [] };
    },
  },
  {
    key: 'volume_price',
    name: '量价共振',
    tag: '量能',
    source: 'microsoft/qlib · OBV 量价因子',
    desc: 'OBV 与价格同向、放量上涨或缩量回踩得分更高；放量滞涨、OBV 背离与缩量上涨会被降分。',
    params: { period: 20 },
    minScore: 58,
    score(item) {
      const t = item.technical;
      let score =
        0.34 * obvScore(t) +
        0.26 * pct(item.factors.volume) +
        0.16 * (t.price > t.ma20 ? 100 : 25) +
        0.12 * scale(t.mom20 * 100, -12, 25) +
        0.12 * (t.macdHist > 0 ? 100 : 25);
      if (t.volRatio > 1.8 && t.changePct < 0.5) score -= 18;
      if (t.volRatio < 0.7 && t.mom20 > 0.08) score -= 10;
      if (t.rsi14 > 80) score -= 12;
      const reasons = [];
      if (t.obvStrength > 0.12) reasons.push('OBV 与价格同向向上');
      if (t.volRatio > 1.25 && t.changePct > 0) reasons.push('放量上涨');
      if (t.volRatio < 0.85 && t.rangePos < 0.45) reasons.push('缩量回踩');
      if (t.price > t.ma20) reasons.push('价格位于 MA20 上方');
      const warnings = [];
      if (t.volRatio > 1.8 && t.changePct < 0.5) warnings.push('放量滞涨，警惕分歧');
      if (t.obvStrength < -0.15) warnings.push('OBV 资金流出');
      return { score, reasons, warnings };
    },
  },
  {
    key: 'chan_theory',
    name: '缠论结构',
    tag: '结构',
    source: '公开缠论规则 · 工程化近似',
    desc: '包含处理、右侧确认分型、笔与三笔重叠中枢，结合 MACD DIF 背驰近似 1/2/3 类买卖点；仅在后续结构确认后生效。',
    params: { minStrokeBars: 4 },
    minScore: 56,
    score(item) {
      const t = item.technical;
      const c = t.chan || {};
      const point = c.latestPoint;
      const stroke = c.latestStroke;
      let score = 50;
      if (point) {
        const freshness = clamp(1 - num(c.pointAge, 120) / 60, 0.15, 1);
        score += (point.side === 'buy' ? 24 : -24) * freshness;
        if (c.pointAge <= 12) score += point.side === 'buy' ? 10 : -10;
      }
      if (stroke) score += stroke.direction === 'up' ? 12 : -12;
      if (c.position === '中枢上方') score += 8;
      else if (c.position === '中枢下方') score -= 8;
      if (c.signal === 1) score += 5;
      const reasons = [];
      const warnings = [];
      if (point) reasons.push(`${point.type} 于 ${point.confirmDate} 右侧确认`);
      if (stroke) reasons.push(`最近确认${stroke.direction === 'up' ? '上升笔' : '下降笔'}`);
      if (c.position && c.position !== '暂无中枢') reasons.push(`价格位于${c.position}`);
      if (point?.side === 'sell') warnings.push(`${point.type} 已确认，注意结构转弱`);
      if (!point) warnings.push('尚无确认的缠论买卖点');
      return { score, reasons, warnings };
    },
  },
];

const MAP = new Map(LIBRARY.map((s) => [s.key, s]));
const DEFAULT_STRATEGY = 'volume_price';

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
