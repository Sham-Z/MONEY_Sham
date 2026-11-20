'use strict';

const ds = require('./datasource');
const ind = require('./indicators');
const strategies = require('./strategies');
const chan = require('./chan');
const sector = require('./sector');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Number((Number(v) || 0).toFixed(2));

// 与荐股、回测、个股综合建议使用完全相同的策略 key 与名称。
const WEIGHT = {
  ma_cross: 1.4,
  macd: 1.2,
  momentum: 1.0,
  breakout: 1.3,
  rsi_reversion: 1.2,
  bollinger: 1.2,
  kdj: 1.1,
  volume_price: 1.3,
  chan_theory: 1.3,
};
const NAME = Object.fromEntries(strategies.LIBRARY.map((s) => [s.key, s.name]));

function clockMinutes(time) {
  const [hours, minutes] = String(time || '').split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

/** 分钟快照聚为固定 5 分钟 OHLC；新浪已有 5 分钟线时不再二次聚合。 */
function aggregateFiveMinute(bars) {
  const gaps = [];
  for (let i = 1; i < bars.length; i += 1) {
    const gap = clockMinutes(bars[i].time) - clockMinutes(bars[i - 1].time);
    if (gap > 0 && gap <= 10) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const sourceStep = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1;
  const groupSize = sourceStep <= 2 ? 5 : 1;
  const output = [];
  let current = null;
  let previousMinutes = null;

  bars.forEach((bar, index) => {
    const minutes = clockMinutes(bar.time);
    const sessionChanged = previousMinutes == null || minutes < previousMinutes || minutes - previousMinutes > 10;
    if (!current || sessionChanged || current.count >= groupSize) {
      current = {
        date: bar.time,
        time: bar.time,
        open: bar.price,
        high: bar.price,
        low: bar.price,
        close: bar.price,
        volume: bar.volume || 0,
        endIndex: index,
        count: 1,
      };
      output.push(current);
    } else {
      current.time = bar.time;
      current.date = bar.time;
      current.high = Math.max(current.high, bar.price);
      current.low = Math.min(current.low, bar.price);
      current.close = bar.price;
      current.volume += bar.volume || 0;
      current.endIndex = index;
      current.count += 1;
    }
    previousMinutes = minutes;
  });
  return output;
}

function kdjSeries(bars, closes, period = 9) {
  const ks = new Array(bars.length).fill(null);
  const ds = new Array(bars.length).fill(null);
  let k = 50;
  let d = 50;
  for (let i = 0; i < bars.length; i += 1) {
    const start = Math.max(0, i - period + 1);
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = start; j <= i; j += 1) {
      hh = Math.max(hh, bars[j].price);
      ll = Math.min(ll, bars[j].price);
    }
    const rsv = hh > ll ? ((closes[i] - ll) / (hh - ll)) * 100 : 50;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    ks[i] = k;
    ds[i] = d;
  }
  return { ks, ds };
}

/**
 * 分钟级统一多策略共识信号。
 * 共识规则：
 * 1) 使用与榜单/回测一致的 9 个策略，缠论使用确认的 5 分钟结构；
 * 2) 趋势与突破信号必须得到量能/OBV 配合；
 * 3) 高位急涨、严重偏离 VWAP 时禁止买点，低位急跌时禁止卖点；
 * 4) 至少两个策略同向投票才标注，且买卖点交替、间隔至少 10 分钟；
 * 5) 板块情绪只展示环境状态，不独立制造买卖点或放宽上述约束。
 */
async function analyze(code) {
  const [minute, quoteList, sectorInfo] = await Promise.all([
    ds.intraday(code),
    ds.quotes([code]).catch(() => []),
    sector.analyze(code),
  ]);
  const bars = minute.bars;
  if (!bars || bars.length < 40) throw new Error('分时数据不足，暂无法生成买卖点');

  const closes = bars.map((b) => b.price);
  const avg = bars.map((b) => b.avg);
  const volumes = bars.map((b) => b.volume);
  const ma5 = ind.sma(closes, 5);
  const ma20 = ind.sma(closes, 20);
  const rsi = ind.rsi(closes, 14);
  const macd = ind.macd(closes, 12, 26, 9);
  const volMa = ind.sma(volumes, 20);
  const { ks, ds: kd } = kdjSeries(bars, closes);
  const upper = new Array(bars.length).fill(null);
  const lower = new Array(bars.length).fill(null);
  for (let i = 19; i < bars.length; i += 1) {
    const window = closes.slice(i - 19, i + 1);
    const sd = ind.stdev(window);
    upper[i] = ma20[i] + 2 * sd;
    lower[i] = ma20[i] - 2 * sd;
  }
  const obv = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i += 1) {
    obv[i] = obv[i - 1] + Math.sign(closes[i] - closes[i - 1]) * volumes[i];
  }

  const fiveBars = aggregateFiveMinute(bars);
  const chanResult = chan.analyze(fiveBars, { minStrokeBars: 4 });
  const fiveIndexAtMinute = new Array(bars.length).fill(null);
  fiveBars.forEach((bar, index) => { fiveIndexAtMinute[bar.endIndex] = index; });
  const pointsByConfirmation = new Map();
  for (const point of chanResult.points) {
    if (!pointsByConfirmation.has(point.confirmIndex)) pointsByConfirmation.set(point.confirmIndex, []);
    pointsByConfirmation.get(point.confirmIndex).push(point);
  }

  const markers = [];
  let lastIndex = -99;
  let lastSide = '';
  let blockedBuy = 0;
  let blockedSell = 0;

  for (let i = 20; i < bars.length; i += 1) {
    const price = closes[i];
    const volRatio = volMa[i] > 0 ? volumes[i] / volMa[i] : 1;
    const obvUp = obv[i] >= obv[i - 5];
    const obvDown = obv[i] <= obv[i - 5];
    const evidence = [];
    const add = (key, side, label) => evidence.push({ key, side, name: NAME[key], label, w: WEIGHT[key] });

    if (ma5[i] != null && ma20[i] != null && ma5[i - 1] != null && ma20[i - 1] != null) {
      if (ma5[i - 1] <= ma20[i - 1] && ma5[i] > ma20[i] && (volRatio >= 0.95 || obvUp)) add('ma_cross', 'buy', '分钟均线金叉');
      if (ma5[i - 1] >= ma20[i - 1] && ma5[i] < ma20[i]) add('ma_cross', 'sell', '分钟均线死叉');
    }
    if (macd.hist[i] != null && macd.hist[i - 1] != null) {
      if (macd.hist[i - 1] <= 0 && macd.hist[i] > 0 && (volRatio >= 0.9 || obvUp)) add('macd', 'buy', 'MACD 金叉');
      if (macd.hist[i - 1] >= 0 && macd.hist[i] < 0) add('macd', 'sell', 'MACD 死叉');
    }
    const roc10 = price / closes[i - 10] - 1;
    const roc10Prev = closes[i - 1] / closes[i - 11] - 1;
    if (roc10Prev <= 0 && roc10 > 0 && ma20[i] != null && price > ma20[i] && (volRatio >= 1 || obvUp)) {
      add('momentum', 'buy', '10 分钟动量转正');
    }
    if (roc10Prev >= 0 && roc10 < 0 && ma20[i] != null && price < ma20[i]) add('momentum', 'sell', '10 分钟动量转负');

    const prevHigh = Math.max(...closes.slice(i - 20, i));
    const prevLow = Math.min(...closes.slice(i - 20, i));
    if (price > prevHigh && closes[i - 1] <= prevHigh && volRatio > 1.3 && obvUp) add('breakout', 'buy', '放量突破 20 分钟高点');
    if (price < prevLow && closes[i - 1] >= prevLow && volRatio > 1.3) add('breakout', 'sell', '放量跌破 20 分钟低点');

    if (rsi[i] != null && rsi[i - 1] != null) {
      if (rsi[i - 1] <= 30 && rsi[i] > 30) add('rsi_reversion', 'buy', 'RSI 超卖回升');
      if (rsi[i - 1] >= 70 && rsi[i] < 70) add('rsi_reversion', 'sell', 'RSI 超买回落');
    }
    if (lower[i] != null && lower[i - 1] != null) {
      if (closes[i - 1] < lower[i - 1] && price >= lower[i]) add('bollinger', 'buy', '收回布林下轨');
      if (closes[i - 1] > upper[i - 1] && price <= upper[i]) add('bollinger', 'sell', '收回布林上轨');
    }
    if (ks[i] != null && kd[i] != null && ks[i - 1] != null && kd[i - 1] != null) {
      if (ks[i] < 25 && ks[i - 1] <= kd[i - 1] && ks[i] > kd[i]) add('kdj', 'buy', 'KDJ 低位金叉');
      if (ks[i] > 75 && ks[i - 1] >= kd[i - 1] && ks[i] < kd[i]) add('kdj', 'sell', 'KDJ 高位死叉');
    }
    const obvSlope = obv[i] - obv[i - 5];
    const obvSlopePrev = obv[i - 1] - obv[i - 6];
    if (obvSlopePrev <= 0 && obvSlope > 0 && avg[i] != null && price > avg[i] && volRatio > 1.15) {
      add('volume_price', 'buy', 'OBV 转强且放量');
    }
    if (obvSlopePrev >= 0 && obvSlope < 0 && avg[i] != null && price < avg[i] && volRatio > 1.15) {
      add('volume_price', 'sell', 'OBV 转弱且放量');
    }
    const fiveIndex = fiveIndexAtMinute[i];
    const chanPoint = fiveIndex == null ? null : pointsByConfirmation.get(fiveIndex)?.at(-1);
    if (chanPoint) add('chan_theory', chanPoint.side, `${chanPoint.type} 右侧确认`);

    if (!evidence.length) continue;
    const buyScore = evidence.filter((e) => e.side === 'buy').reduce((a, e) => a + e.w, 0);
    const sellScore = evidence.filter((e) => e.side === 'sell').reduce((a, e) => a + e.w, 0);
    const side = buyScore >= sellScore ? 'buy' : 'sell';
    const strong = Math.max(buyScore, sellScore);
    const weak = Math.min(buyScore, sellScore);
    if (strong < 2.2 || strong < weak * 1.2) continue;

    const names = evidence.filter((e) => e.side === side);
    if (names.length < 2) continue;

    // 防追涨杀跌：已经急涨/远离均价时不追买，已经急跌/远离均价时不杀跌。
    const ret5 = price / closes[i - 5] - 1;
    const devVwap = avg[i] > 0 ? (price - avg[i]) / avg[i] : 0;
    const dayHighSoFar = Math.max(...closes.slice(0, i + 1));
    const dayLowSoFar = Math.min(...closes.slice(0, i + 1));
    const recentWindow = closes.slice(i - 20, i + 1);
    const recentHigh = Math.max(...recentWindow);
    const recentLow = Math.min(...recentWindow);
    const rangePos = recentHigh > recentLow ? (price - recentLow) / (recentHigh - recentLow) : 0.5;
    const rsiNow = rsi[i] == null ? 50 : rsi[i];
    if (side === 'buy') {
      const nearRecentHigh = rangePos >= 0.85 && ret5 > 0.002;
      const extended = rsiNow > 70 || ret5 > 0.015 || devVwap > 0.018 || (price >= dayHighSoFar * 0.998 && ret5 > 0.004);
      const elevated = ret5 > 0.008 || devVwap > 0.01;
      if (extended || ((nearRecentHigh || elevated) && (strong < 3.2 || names.length < 3))) {
        blockedBuy += 1;
        continue;
      }
    } else {
      const nearRecentLow = rangePos <= 0.2 && ret5 < 0;
      const nearDayLow = price <= dayLowSoFar * 1.002;
      const extended = rsiNow < 32 || ret5 < -0.012 || devVwap < -0.012 || nearDayLow || nearRecentLow;
      const depressed = (rangePos <= 0.35 && ret5 < 0) || ret5 < -0.006 || devVwap < -0.008;
      if (extended || (depressed && (strong < 3.2 || names.length < 3))) {
        blockedSell += 1;
        continue;
      }
    }

    if (side === lastSide) continue;
    if (i - lastIndex < 10) continue;
    markers.push({
      index: i,
      time: bars[i].time,
      price: round2(price),
      side,
      label: side === 'buy' ? '买点' : '卖点',
      score: Number(strong.toFixed(2)),
      count: names.length,
      strategies: names.map((e) => e.key),
      reasons: names.slice(0, 3).map((e) => `${e.name}·${e.label}`),
    });
    lastIndex = i;
    lastSide = side;
  }

  const i = bars.length - 1;
  const price = closes[i];
  const prevClose = minute.prevClose || closes[0];
  const changePct = prevClose ? ((price / prevClose - 1) * 100) : 0;
  const volRatioNow = volMa[i] > 0 ? volumes[i] / volMa[i] : 1;
  const obvStrength = volMa[i] > 0 ? clamp((obv[i] - obv[i - 5]) / (volMa[i] * 5), -1, 1) : 0;
  let score = 0;
  score += price > avg[i] ? 1 : -1;
  if (ma5[i] != null && ma20[i] != null) score += ma5[i] > ma20[i] ? 1 : -1;
  if (macd.hist[i] != null) score += macd.hist[i] > 0 ? 0.8 : -0.8;
  if (rsi[i] != null) {
    if (rsi[i] > 75) score -= 1;
    else if (rsi[i] < 30) score += 0.6;
  }
  score += price > prevClose ? 0.5 : -0.5;
  score += obvStrength > 0 ? 0.5 : -0.5;
  if (volRatioNow > 1.5) score += price >= avg[i] ? 0.3 : -0.3;

  const stance = score >= 1.6 ? '偏多' : score <= -1.6 ? '偏空' : '震荡';
  const recent = markers.filter((m) => bars.length - m.index <= 30);
  const lastMarker = markers.at(-1) || null;
  const dayHigh = Math.max(...closes);
  const dayLow = Math.min(...closes);
  const latestPoint = chanResult.summary.latestPoint;
  const chanSummary = {
    trend: chanResult.summary.trend,
    position: chanResult.summary.position,
    latestPoint: latestPoint
      ? { ...latestPoint, confirmTime: fiveBars[latestPoint.confirmIndex]?.time || latestPoint.confirmDate }
      : null,
    descriptions: chanResult.descriptions,
    fiveMinuteBars: fiveBars.length,
  };

  return {
    ok: true,
    code,
    name: quoteList[0]?.name || '',
    date: minute.date,
    source: minute.source,
    dataTime: `${minute.date} ${bars.at(-1).time}`,
    prevClose: round2(prevClose),
    price: round2(price),
    changePct: round2(changePct),
    high: round2(dayHigh),
    low: round2(dayLow),
    vwap: round2(avg[i]),
    volume: volumes.reduce((a, v) => a + v, 0),
    bars: bars.map((b) => ({ time: b.time, price: round2(b.price), avg: round2(b.avg), volume: b.volume })),
    markers,
    chan: chanSummary,
    sector: sectorInfo,
    strategyUniverse: strategies.list().map((s) => ({ key: s.key, name: s.name })),
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
      obvStrength: round2(obvStrength),
      blockedBuy,
      blockedSell,
    },
    live: {
      mode: '分钟快照轮询',
      autoRefreshSeconds: 4,
      realtime: false,
      note: '非逐笔推送；页面每 4 秒重新拉取最新分钟快照并重算买卖点，行情可能存在延迟，历史标记通常保持稳定，新信号随快照更新。',
    },
    updatedAt: new Date().toISOString(),
    disclaimer: '分时买卖点由统一 9 策略投票生成，其中缠论使用右侧确认的 5 分钟结构；板块情绪仅作环境展示，不独立触发交易。含高位禁买/低位禁卖约束；仅供研究参考，不构成投资建议。',
  };
}

module.exports = { analyze };
