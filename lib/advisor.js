'use strict';

const ds = require('./datasource');
const quant = require('./quant');
const sector = require('./sector');
const ind = require('./indicators');

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

/* ------------------------------------------------------------------ */
/* 个股多策略综合建议                                                   */
/* ------------------------------------------------------------------ */

const VERDICT = {
  buy: { label: '买入', tone: 'up' },
  hold: { label: '持有', tone: 'warn' },
  sell: { label: '卖出', tone: 'down' },
};

/**
 * 与综合回测一致的过热锁定：RSI14 > 75 或 10 日涨幅 > 15% 触发，
 * RSI14 < 50 且 10 日涨幅 < 5% 后解除；重放近期日线得到当前状态。
 */
function overheatState(bars) {
  if (!Array.isArray(bars) || bars.length < 15) return { locked: false, rsi: null, ret10: 0 };
  const closes = bars.map((b) => b.close);
  const rsi = ind.rsi(closes, 14);
  let locked = false;
  for (let i = 0; i < bars.length; i += 1) {
    const r = rsi[i];
    const ret10 = i >= 10 ? closes[i] / closes[i - 10] - 1 : 0;
    if (!locked && ((r != null && r > 75) || ret10 > 0.15)) locked = true;
    if (locked && (r == null || r < 50) && ret10 < 0.05) locked = false;
  }
  const last = closes.length - 1;
  return {
    locked,
    rsi: rsi.at(-1),
    ret10: last >= 10 ? closes[last] / closes[last - 10] - 1 : 0,
  };
}

/**
 * 对同一只股票运行全部回测策略，用「胜率 × 盈利质量」分配权重，
 * 再把各策略当前持仓/空仓信号加权成最终建议。
 */
async function strategyAdvice(codeRaw, options = {}) {
  const code = String(codeRaw || '').replace(/\D/g, '').slice(0, 6);
  if (code.length !== 6) throw new Error('股票代码需为 6 位数字');
  const days = clamp(Number(options.days) || 400, 160, 800);

  const [quoteList, results, sectorInfo, heatBars] = await Promise.all([
    ds.quotes([code]).catch(() => []),
    Promise.all(
      quant.STRATEGIES.map((s) =>
        quant
          .backtest(code, { strategy: s.key, params: s.params, days })
          .then((r) => ({ def: s, result: r }))
          .catch(() => null),
      ),
    ),
    sector.analyze(code),
    ds.kline(code, { period: 'day', count: 160 }).catch(() => []),
  ]);

  const valid = results.filter(Boolean);
  if (!valid.length) throw new Error('历史行情不足，暂无法生成多策略建议');

  const rows = valid.map(({ def, result }) => {
    const m = result.metrics;
    const winPart = clamp(m.winRate / 100, 0.02, 1);
    const profitPart = clamp(1 + m.totalReturn / 100, 0.1, 4);
    const pfPart = clamp(m.profitFactor || 0.1, 0.2, 3);
    let quality = winPart * profitPart * pfPart;
    if (m.closedTrades < 2) quality *= 0.15;
    else if (m.closedTrades < 4) quality *= 0.6;
    let signalScore = result.current.signal === 1 ? 82 : 30;
    if (result.current.daysSinceChange <= 2) signalScore += result.current.signal === 1 ? 10 : -8;
    const fresh = result.current.daysSinceChange <= 2;
    return {
      key: def.key,
      name: def.name,
      desc: def.desc,
      weight: 0,
      quality: Number(quality.toFixed(4)),
      signal: result.current.signal === 1 ? 'long' : 'flat',
      signalLabel: result.current.signal === 1 ? '持仓' : '空仓',
      fresh,
      signalScore,
      metrics: {
        winRate: m.winRate,
        totalReturn: m.totalReturn,
        annualized: m.annualized,
        maxDrawdown: m.maxDrawdown,
        sharpe: m.sharpe,
        profitFactor: m.profitFactor,
        closedTrades: m.closedTrades,
        tradeCount: m.tradeCount,
        exposure: m.exposure,
        benchmarkReturn: m.benchmarkReturn,
      },
      range: result.range,
    };
  });

  // 与综合回测一致：质量最高的前 3 个策略等权，避免强策略被等权混合稀释。
  const rankedByQuality = [...rows].sort((a, b) => b.quality - a.quality);
  const topKeys = new Set(rankedByQuality.slice(0, 3).map((r) => r.key));
  for (const r of rows) r.weight = topKeys.has(r.key) ? 100 / Math.min(3, rows.length) : 0;
  const weightSum = rows.reduce((a, r) => a + r.weight, 0) || 1;
  for (const r of rows) r.weight = Number(((r.weight / weightSum) * 100).toFixed(2));

  const baseComposite = Number(
    (rows.reduce((a, r) => a + (r.weight / 100) * r.signalScore, 0)).toFixed(1),
  );
  const sectorAdjustment = clamp(num(sectorInfo.adjustment), -4, 4);
  const composite = Number(clamp(baseComposite + sectorAdjustment, 0, 100).toFixed(1));
  const heat = overheatState(heatBars);
  let action = composite >= 56 ? 'buy' : composite > 44 ? 'hold' : 'sell';
  if (heat.locked) action = 'sell';
  const bullWeight = rows.filter((r) => r.signal === 'long').reduce((a, r) => a + r.weight, 0);
  const bearWeight = 100 - bullWeight;
  let confidence;
  if (action === 'buy') confidence = 50 + bullWeight * 0.45;
  else if (action === 'sell') confidence = 50 + bearWeight * 0.45;
  else confidence = 55 + (1 - Math.abs(bullWeight - bearWeight) / 100) * 30;
  const confidenceDirection = action === 'buy' ? 1 : action === 'sell' ? -1 : 0;
  const confidenceAdjustment = confidenceDirection
    ? sectorAdjustment * confidenceDirection
    : -Math.abs(sectorAdjustment) * 0.5;
  confidence = Math.round(clamp(confidence + confidenceAdjustment, 55, 95));

  const ranked = [...rows].sort((a, b) => b.weight - a.weight);
  const longs = rows.filter((r) => r.signal === 'long').length;
  const reasons = [
    `${longs}/${rows.length} 个策略当前持仓，多头权重 ${bullWeight.toFixed(1)}%`,
    ...ranked.slice(0, 3).map(
      (r) =>
        `${r.name}：胜率 ${r.metrics.winRate}% · 区间收益 ${r.metrics.totalReturn}% · 当前${r.signalLabel}`,
    ),
  ];
  if (heat.locked) {
    reasons.unshift(
      `过热止盈锁定：RSI14 ${heat.rsi == null ? '—' : heat.rsi.toFixed(1)}、10 日涨幅 ${(heat.ret10 * 100).toFixed(1)}%，等待 RSI 回到 50 以下且短期涨幅收敛`,
    );
  }
  if (Math.abs(sectorAdjustment) >= 0.05) {
    reasons.splice(1, 0, `板块情绪${sectorInfo.state} ${sectorInfo.score} 分，综合分 ${baseComposite} → ${composite}（环境 ${sectorAdjustment > 0 ? '+' : ''}${sectorAdjustment}）`);
  }
  const warnings = [];
  if (!sectorInfo.available) warnings.push('板块情绪暂不可用，已按中性 50 分降级，不影响九策略原始信号');
  for (const r of ranked) {
    if (r.metrics.totalReturn < 0) warnings.push(`${r.name} 回测区间收益为 ${r.metrics.totalReturn}%`);
    else if (r.metrics.winRate < 40 && r.metrics.closedTrades >= 3) warnings.push(`${r.name} 胜率仅 ${r.metrics.winRate}%`);
  }
  if (longs > 0 && longs < rows.length) {
    warnings.push(`策略信号分歧：${longs}/${rows.length} 个策略当前持仓`);
  }
  if (!warnings.length) warnings.push('建议结合仓位与止损分批执行');

  const top = ranked[0];
  return {
    ok: true,
    code,
    name: quoteList[0]?.name || '',
    quote: quoteList[0] || null,
    days,
    action,
    actionLabel: VERDICT[action].label,
    tone: VERDICT[action].tone,
    score: composite,
    baseScore: baseComposite,
    overheat: heat,
    sectorAdjustment,
    sector: sectorInfo,
    confidence,
    consensus: {
      total: rows.length,
      longCount: longs,
      flatCount: rows.length - longs,
      bullWeightPct: Number(bullWeight.toFixed(1)),
      bearWeightPct: Number(bearWeight.toFixed(1)),
      label: action === 'buy' ? '策略共振偏多' : action === 'sell' ? '策略共振偏空' : '策略分歧，等待确认',
    },
    topStrategy: { key: top.key, name: top.name, weight: top.weight },
    reasons,
    warnings: warnings.slice(0, 4),
    strategies: ranked,
    updatedAt: new Date().toISOString(),
    disclaimer:
      '九策略权重由历史回测的胜率、区间收益与盈亏比归一化得到；板块情绪仅作 ±4 分环境修正，行业归属采用当前口径，历史表现不代表未来。仅供研究参考，不构成投资建议。',
  };
}

module.exports = { diagnose, strategyAdvice, ACTIONS, VERDICT };
