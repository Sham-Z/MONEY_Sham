'use strict';

const ds = require('./datasource');
const quant = require('./quant');

const ACTIONS = {
  buy: { label: '买入', tone: 'up', rank: 6 },
  add: { label: '加仓', tone: 'up', rank: 5 },
  hold: { label: '持有', tone: 'warn', rank: 4 },
  watch: { label: '观望', tone: 'info', rank: 3 },
  reduce: { label: '减仓', tone: 'down', rank: 2 },
  exit: { label: '清仓', tone: 'down', rank: 1 },
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Number(v.toFixed(2));

function normalizeHolding(raw) {
  const code = String(raw?.code || '').replace(/\D/g, '').slice(0, 6);
  if (code.length !== 6) return null;
  return {
    code,
    name: String(raw?.name || '').slice(0, 20),
    shares: clamp(Math.floor(num(raw?.shares)), 0, 1e9),
    cost: clamp(num(raw?.cost), 0, 1e6),
  };
}

function buildLevels(tech, price) {
  const support = tech.ma20 || tech.low20 || price * 0.95;
  const midSupport = tech.ma60 && tech.ma60 < price ? tech.ma60 : tech.low20;
  const stopLoss = tech.ma60 && price > tech.ma60 ? Math.max(tech.ma60 * 0.99, price * 0.9) : Math.min(tech.low20 * 0.97, price * 0.94);
  const resistance = tech.high20 > price ? tech.high20 : tech.high60;
  const takeProfit = resistance > price ? resistance : price * (1 + Math.max(0.06, tech.atrPct * 3));
  return {
    support: round2(Math.min(support, price)),
    midSupport: round2(Math.min(midSupport || support, price)),
    resistance: round2(resistance || price * 1.08),
    stopLoss: round2(Math.min(stopLoss, price * 0.99)),
    takeProfit: round2(takeProfit),
    riskPct: round2(((price - stopLoss) / price) * 100),
  };
}

/** 综合趋势、动量、量能、超买超卖与持仓盈亏，给出可执行信号 */
function judge({ price, holding, tech, changePct }) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  if (tech) {
    if (tech.price > tech.ma20) {
      score += 1;
      reasons.push('站上 MA20');
    } else {
      score -= 1;
      warnings.push('跌破 MA20');
    }
    if (tech.ma20 && tech.ma60 && tech.ma20 > tech.ma60) {
      score += 1;
      reasons.push('MA20 高于 MA60');
    } else {
      score -= 1;
      warnings.push('中期均线走弱');
    }
    if (tech.ma5 && tech.ma10 && tech.ma20 && tech.ma5 > tech.ma10 && tech.ma10 > tech.ma20) {
      score += 0.8;
      reasons.push('短中期多头排列');
    }
    if (tech.macdHist > 0) {
      score += 1;
      reasons.push('MACD 红柱');
    } else {
      score -= 0.8;
    }
    if (tech.goldCrossDays != null && tech.goldCrossDays <= 3) {
      score += 0.8;
      reasons.push('MA5/MA20 金叉');
    }
    if (tech.deadCrossDays != null && tech.deadCrossDays <= 3) {
      score -= 1.4;
      warnings.push('MA5/MA20 死叉');
    }
    if (tech.rsi14 >= 78) {
      score -= 2;
      warnings.push(`RSI ${tech.rsi14.toFixed(1)} 超买`);
    } else if (tech.rsi14 != null && tech.rsi14 <= 32) {
      score += 0.6;
      reasons.push(`RSI ${tech.rsi14.toFixed(1)} 超卖`);
    }
    if (tech.volRatio > 1.5 && changePct > 0) {
      score += 1;
      reasons.push('放量上涨');
    }
    if (tech.volRatio > 2 && changePct < -2) {
      score -= 1.5;
      warnings.push('放量下跌');
    }
    if (tech.rangePos > 0.85) {
      score += 0.5;
      reasons.push('接近 20 日新高');
    }
    if (tech.mom20 > 0.05) {
      score += 0.5;
      reasons.push(`20日动量 +${(tech.mom20 * 100).toFixed(1)}%`);
    }
    if (tech.mom60 < 0) {
      score -= 0.6;
      warnings.push('60日趋势偏弱');
    }
    if (tech.ret5 != null && tech.ret5 < -0.06) {
      score -= 1;
      warnings.push('5 日快速回撤');
    }
  } else {
    warnings.push('历史行情不足，暂无法给出可靠信号');
  }

  const pnlPct = holding.cost > 0 && holding.shares > 0 ? (price / holding.cost - 1) * 100 : 0;
  if (holding.shares > 0) {
    if (pnlPct < -8) {
      score -= 1;
      warnings.push(`持仓浮亏 ${pnlPct.toFixed(1)}%`);
    }
    if (pnlPct < -15) score -= 1;
    if (pnlPct > 25 && tech?.rsi14 > 70) {
      score -= 1;
      warnings.push('浮盈较大且 RSI 偏高');
    }
    if (pnlPct > 10) reasons.push(`浮盈 ${pnlPct.toFixed(1)}%`);
  }

  if (tech && tech.price < tech.ma60 && tech.mom60 < -0.08) {
    score -= 1;
    warnings.push('价格与中期趋势同时走弱');
  }

  let action;
  if (holding.shares <= 0) {
    action = score >= 3 ? 'buy' : 'watch';
  } else if (score >= 3.5) {
    action = 'add';
  } else if (score >= 0.5) {
    action = 'hold';
  } else if (score >= -2) {
    action = 'reduce';
  } else {
    action = 'exit';
  }
  if (holding.shares > 0 && pnlPct < -12 && tech && tech.price < tech.ma60) action = 'exit';

  if (!reasons.length) reasons.push('暂未出现明确的多头信号');
  if (!warnings.length && (action === 'add' || action === 'buy')) warnings.push('注意仓位控制，分批执行');

  const confidence = Math.round(clamp(54 + Math.abs(score) * 7, 55, 95));
  const riskLevel = !tech ? '未知' : tech.vol20 > 0.55 || tech.atrPct > 0.06 ? '高' : tech.vol20 > 0.35 ? '中' : '低';

  return {
    action,
    actionLabel: ACTIONS[action].label,
    tone: ACTIONS[action].tone,
    confidence,
    score: round2(score),
    reasons: reasons.slice(0, 4),
    warnings: warnings.slice(0, 3),
    riskLevel,
    pnlPct: holding.shares > 0 ? round2(pnlPct) : null,
    levels: tech ? buildLevels(tech, price) : null,
  };
}

async function diagnose(rawHoldings) {
  const holdings = (Array.isArray(rawHoldings) ? rawHoldings : [])
    .slice(0, 30)
    .map(normalizeHolding)
    .filter(Boolean);

  if (!holdings.length) {
    return {
      ok: true,
      items: [],
      summary: { count: 0, marketValue: 0, costValue: 0, pnl: 0, pnlPct: 0, actionCounts: {} },
      updatedAt: new Date().toISOString(),
    };
  }

  const codes = holdings.map((h) => h.code);
  const quoteList = await ds.quotes(codes).catch(() => []);
  const quoteMap = new Map(quoteList.map((q) => [q.code, q]));

  const barsMap = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < holdings.length) {
      const idx = cursor;
      cursor += 1;
      const code = holdings[idx].code;
      try {
        barsMap.set(code, await ds.kline(code, { period: 'day', count: 150 }));
      } catch {
        /* 单只失败不影响其他持仓 */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, holdings.length) }, worker));

  const items = holdings.map((h) => {
    const q = quoteMap.get(h.code);
    const bars = barsMap.get(h.code) || [];
    const tech = bars.length >= 70 ? quant.technicalProfile(bars.slice(-150)) : null;
    const lastBar = bars.at(-1);
    const price = q?.price || lastBar?.close || 0;
    const prevClose = q?.prevClose || (bars.length > 1 ? bars.at(-2).close : price);
    const changePct = q?.changePct ?? (prevClose ? (price / prevClose - 1) * 100 : 0);
    const name = q?.name || h.name || h.code;
    const marketValue = price * h.shares;
    const costValue = h.cost * h.shares;
    const pnl = marketValue - costValue;
    const judgment = judge({ price, holding: h, tech, changePct });

    return {
      code: h.code,
      name,
      shares: h.shares,
      cost: h.cost,
      price,
      prevClose,
      changePct: round2(changePct),
      marketValue: round2(marketValue),
      costValue: round2(costValue),
      pnl: round2(pnl),
      pnlPct: h.shares > 0 && h.cost > 0 ? round2((price / h.cost - 1) * 100) : 0,
      dayPnl: round2((price - prevClose) * h.shares),
      ...judgment,
      technical: tech
        ? {
            ma5: tech.ma5,
            ma10: tech.ma10,
            ma20: tech.ma20,
            ma60: tech.ma60,
            rsi14: tech.rsi14,
            macdHist: tech.macdHist,
            volRatio: tech.volRatio,
            mom20: tech.mom20,
            mom60: tech.mom60,
            vol20: tech.vol20,
            atrPct: tech.atrPct,
            rangePos: tech.rangePos,
            signals: tech.signals.slice(0, 4),
          }
        : null,
    };
  });

  items.sort((a, b) => ACTIONS[a.action].rank - ACTIONS[b.action].rank || b.marketValue - a.marketValue);

  const marketValue = items.reduce((a, b) => a + b.marketValue, 0);
  const costValue = items.reduce((a, b) => a + b.costValue, 0);
  const pnl = marketValue - costValue;
  const dayPnl = items.reduce((a, b) => a + b.dayPnl, 0);
  const actionCounts = {};
  for (const item of items) actionCounts[item.action] = (actionCounts[item.action] || 0) + 1;

  const riskAlerts = [];
  const top = [...items].sort((a, b) => b.marketValue - a.marketValue)[0];
  if (top && marketValue > 0 && top.marketValue / marketValue > 0.4) {
    riskAlerts.push(`${top.name} 占组合 ${((top.marketValue / marketValue) * 100).toFixed(1)}%，集中度偏高`);
  }
  for (const item of items) {
    if (item.shares > 0 && item.pnlPct < -10) riskAlerts.push(`${item.name} 浮亏 ${item.pnlPct.toFixed(1)}%，建议检查止损`);
  }
  if (pnl / Math.max(1, costValue) < -0.08) riskAlerts.push('组合整体浮亏超过 8%，注意控制总仓位');

  return {
    ok: true,
    items,
    summary: {
      count: items.length,
      marketValue: round2(marketValue),
      costValue: round2(costValue),
      pnl: round2(pnl),
      pnlPct: costValue > 0 ? round2((pnl / costValue) * 100) : 0,
      dayPnl: round2(dayPnl),
      actionCounts,
      riskAlerts: riskAlerts.slice(0, 4),
    },
    updatedAt: new Date().toISOString(),
    disclaimer: '持仓信号由实时行情与量化规则自动生成，仅供研究参考，不构成投资建议。',
  };
}

module.exports = { diagnose, ACTIONS };
