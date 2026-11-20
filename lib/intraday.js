'use strict';

const ds = require('./datasource');
const ind = require('./indicators');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Number((Number(v) || 0).toFixed(2));

const WEIGHT = {
  vwap: 1.1,
  ma: 1.6,
  macd: 1.2,
  rsi: 1.0,
  breakout: 1.5,
};

/**
 * 在分钟序列上同时运行 VWAP、分钟均线、MACD、RSI 与量价突破五类规则，
 * 用加权投票生成买卖点，并给出当前分时多空结论。
 */
async function analyze(code) {
  const [minute, quoteList] = await Promise.all([
    ds.intraday(code),
    ds.quotes([code]).catch(() => []),
  ]);
  const bars = minute.bars;
  if (!bars || bars.length < 30) throw new Error('分时数据不足，暂无法生成买卖点');

  const closes = bars.map((b) => b.price);
  const avg = bars.map((b) => b.avg);
  const volumes = bars.map((b) => b.volume);
  const ma5 = ind.sma(closes, 5);
  const ma20 = ind.sma(closes, 20);
  const rsi = ind.rsi(closes, 14);
  const macd = ind.macd(closes, 12, 26, 9);
  const volMa = ind.sma(volumes, 20);

  const markers = [];
  let lastIndex = -99;
  let lastSide = '';

  for (let i = 1; i < bars.length; i += 1) {
    const evidence = [];
    if (avg[i] != null && avg[i - 1] != null) {
      if (closes[i - 1] <= avg[i - 1] && closes[i] > avg[i]) evidence.push({ side: 'buy', name: 'VWAP 上穿', w: WEIGHT.vwap });
      if (closes[i - 1] >= avg[i - 1] && closes[i] < avg[i]) evidence.push({ side: 'sell', name: 'VWAP 下破', w: WEIGHT.vwap });
    }
    if (ma5[i] != null && ma20[i] != null && ma5[i - 1] != null && ma20[i - 1] != null) {
      if (ma5[i - 1] <= ma20[i - 1] && ma5[i] > ma20[i]) evidence.push({ side: 'buy', name: '分钟均线金叉', w: WEIGHT.ma });
      if (ma5[i - 1] >= ma20[i - 1] && ma5[i] < ma20[i]) evidence.push({ side: 'sell', name: '分钟均线死叉', w: WEIGHT.ma });
    }
    if (macd.hist[i] != null && macd.hist[i - 1] != null) {
      if (macd.hist[i - 1] <= 0 && macd.hist[i] > 0) evidence.push({ side: 'buy', name: 'MACD 金叉', w: WEIGHT.macd });
      if (macd.hist[i - 1] >= 0 && macd.hist[i] < 0) evidence.push({ side: 'sell', name: 'MACD 死叉', w: WEIGHT.macd });
    }
    if (rsi[i] != null && rsi[i - 1] != null) {
      if (rsi[i - 1] <= 30 && rsi[i] > 30) evidence.push({ side: 'buy', name: 'RSI 超卖回升', w: WEIGHT.rsi });
      if (rsi[i - 1] >= 70 && rsi[i] < 70) evidence.push({ side: 'sell', name: 'RSI 超买回落', w: WEIGHT.rsi });
    }
    if (i >= 20) {
      const prevHigh = Math.max(...closes.slice(i - 20, i));
      const prevLow = Math.min(...closes.slice(i - 20, i));
      const volRatio = volMa[i] > 0 ? volumes[i] / volMa[i] : 1;
      if (closes[i] > prevHigh && closes[i - 1] <= prevHigh && volRatio > 1.3) evidence.push({ side: 'buy', name: '放量突破', w: WEIGHT.breakout });
      if (closes[i] < prevLow && closes[i - 1] >= prevLow && volRatio > 1.3) evidence.push({ side: 'sell', name: '放量跌破', w: WEIGHT.breakout });
    }

    if (!evidence.length) continue;
    const buyScore = evidence.filter((e) => e.side === 'buy').reduce((a, e) => a + e.w, 0);
    const sellScore = evidence.filter((e) => e.side === 'sell').reduce((a, e) => a + e.w, 0);
    const side = buyScore >= sellScore ? 'buy' : 'sell';
    const strong = Math.max(buyScore, sellScore);
    const weak = Math.min(buyScore, sellScore);
    if (strong < 1.5 || strong < weak * 1.15) continue;
    if (side === lastSide) continue;
    if (i - lastIndex < 10) continue;

    const names = evidence.filter((e) => e.side === side).map((e) => e.name);
    markers.push({
      index: i,
      time: bars[i].time,
      price: round2(closes[i]),
      side,
      label: side === 'buy' ? '买点' : '卖点',
      score: Number(strong.toFixed(2)),
      count: names.length,
      reasons: names.slice(0, 3),
    });
    lastIndex = i;
    lastSide = side;
  }

  const i = bars.length - 1;
  const price = closes[i];
  const prevClose = minute.prevClose || closes[0];
  const changePct = prevClose ? ((price / prevClose - 1) * 100) : 0;
  const volRatioNow = volMa[i] > 0 ? volumes[i] / volMa[i] : 1;
  let score = 0;
  if (price > avg[i]) score += 1;
  else score -= 1;
  if (ma5[i] != null && ma20[i] != null) score += ma5[i] > ma20[i] ? 1 : -1;
  if (macd.hist[i] != null) score += macd.hist[i] > 0 ? 0.8 : -0.8;
  if (rsi[i] != null) {
    if (rsi[i] > 75) score -= 1;
    else if (rsi[i] < 30) score += 0.6;
  }
  score += price > prevClose ? 0.5 : -0.5;
  if (volRatioNow > 1.5) score += price >= avg[i] ? 0.4 : -0.4;

  const stance = score >= 1.6 ? '偏多' : score <= -1.6 ? '偏空' : '震荡';
  const recent = markers.filter((m) => bars.length - m.index <= 30);
  const lastMarker = markers.at(-1) || null;
  const dayHigh = Math.max(...closes);
  const dayLow = Math.min(...closes);

  return {
    ok: true,
    code,
    name: quoteList[0]?.name || '',
    date: minute.date,
    source: minute.source,
    prevClose: round2(prevClose),
    price: round2(price),
    changePct: round2(changePct),
    high: round2(dayHigh),
    low: round2(dayLow),
    vwap: round2(avg[i]),
    volume: volumes.reduce((a, v) => a + v, 0),
    bars: bars.map((b) => ({
      time: b.time,
      price: round2(b.price),
      avg: round2(b.avg),
      volume: b.volume,
    })),
    markers,
    summary: {
      stance,
      score: round2(score),
      buyCount: markers.filter((m) => m.side === 'buy').length,
      sellCount: markers.filter((m) => m.side === 'sell').length,
      recent,
      lastMarker,
      aboveVwap: price > avg[i],
      rsi: rsi[i] != null ? round2(rsi[i]) : null,
      ma5: ma5[i] != null ? round2(ma5[i]) : null,
      ma20: ma20[i] != null ? round2(ma20[i]) : null,
      volRatio: round2(volRatioNow),
    },
    updatedAt: new Date().toISOString(),
    disclaimer: '分时买卖点由分钟级多策略规则自动生成，仅供研究参考，不构成投资建议。',
  };
}

module.exports = { analyze };
