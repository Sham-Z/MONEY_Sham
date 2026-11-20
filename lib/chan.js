'use strict';

const ind = require('./indicators');

/**
 * 缠论的固定规则工程化近似。
 *
 * 只保留可回测的包含处理、确认分型、笔、三笔重叠中枢和买卖点。
 * 分型、笔和中枢一经确认不回溯改写；signal 在 confirmIndex 才生效。
 * 这不是对所有缠论流派、线段及多级别递归的完整复刻。
 */

const round = (v) => (Number.isFinite(v) ? Number(v.toFixed(4)) : null);

function normalizeBars(bars) {
  return (Array.isArray(bars) ? bars : [])
    .map((b, index) => ({
      date: b.date || b.time || String(index),
      open: Number(b.open ?? b.price ?? b.close),
      high: Number(b.high ?? b.price ?? b.close),
      low: Number(b.low ?? b.price ?? b.close),
      close: Number(b.close ?? b.price),
      volume: Number(b.volume) || 0,
      index,
    }))
    .filter((b) => b.high > 0 && b.low > 0 && b.close > 0 && b.high >= b.low);
}

/** 方向包含处理。后续 K 线可更新尚未确认的合并 K 线，但不会删除已确认分型。 */
function mergeContainment(bars, onStep) {
  const merged = [];
  for (const b of bars) {
    const item = {
      ...b,
      startIndex: b.index,
      endIndex: b.index,
      direction: 0,
    };
    if (!merged.length) {
      merged.push(item);
      onStep?.(merged);
      continue;
    }
    const last = merged.at(-1);
    const contained =
      (item.high <= last.high && item.low >= last.low) ||
      (item.high >= last.high && item.low <= last.low);
    if (!contained) {
      item.direction = item.high > last.high && item.low > last.low ? 1 : item.high < last.high && item.low < last.low ? -1 : last.direction;
      merged.push(item);
      onStep?.(merged);
      continue;
    }
    const prev = merged.at(-2);
    const direction =
      last.direction ||
      (prev ? (last.high >= prev.high ? 1 : -1) : item.close >= last.close ? 1 : -1);
    last.high = direction > 0 ? Math.max(last.high, item.high) : Math.min(last.high, item.high);
    last.low = direction > 0 ? Math.max(last.low, item.low) : Math.min(last.low, item.low);
    last.close = item.close;
    last.volume += item.volume;
    last.endIndex = item.index;
    last.date = item.date;
    last.direction = direction;
    onStep?.(merged);
  }
  return merged;
}

/** 每加入一根原始 K 线，只尝试确认当前倒数第二根合并 K 线。 */
function confirmFractals(bars) {
  const candidates = [];
  const seen = new Set();
  mergeContainment(bars, (merged) => {
    if (merged.length < 3) return;
    const i = merged.length - 2;
    const left = merged[i - 1];
    const mid = merged[i];
    const right = merged[i + 1];
    const top = mid.high > left.high && mid.high > right.high && mid.low > left.low && mid.low > right.low;
    const bottom = mid.low < left.low && mid.low < right.low && mid.high < left.high && mid.high < right.high;
    if (!top && !bottom) return;
    const type = top ? 'top' : 'bottom';
    const key = `${mid.startIndex}:${mid.endIndex}:${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      type,
      mIndex: i,
      sourceIndex: mid.endIndex,
      confirmIndex: right.endIndex,
      date: mid.date,
      confirmDate: right.date,
      price: top ? mid.high : mid.low,
      high: mid.high,
      low: mid.low,
    });
  });
  return candidates;
}

/**
 * 最后一个锚点允许被同向更极端分型替换；只有被后续反向锚点确认的笔才输出。
 * 因而新增历史不会改写此前已经输出的笔。
 */
function buildAnchors(candidates, minStrokeBars) {
  const anchors = [];
  for (const f of candidates) {
    const last = anchors.at(-1);
    if (!last) {
      anchors.push({ ...f });
      continue;
    }
    if (f.type === last.type) {
      const moreExtreme = f.type === 'top' ? f.price >= last.price : f.price <= last.price;
      if (moreExtreme) anchors[anchors.length - 1] = { ...f };
      continue;
    }
    if (f.mIndex - last.mIndex < minStrokeBars) continue;
    if (f.type === 'top' && f.price <= last.price) continue;
    if (f.type === 'bottom' && f.price >= last.price) continue;
    anchors.push({ ...f });
  }
  return anchors;
}

function buildStrokes(anchors) {
  const strokes = [];
  // 最后一笔仍需一个后续反向锚点确认，不在图上事后补画未完成笔。
  for (let i = 0; i + 2 < anchors.length; i += 1) {
    const start = anchors[i];
    const end = anchors[i + 1];
    const confirmedBy = anchors[i + 2];
    strokes.push({
      startIndex: start.sourceIndex,
      endIndex: end.sourceIndex,
      confirmIndex: confirmedBy.confirmIndex,
      startDate: start.date,
      endDate: end.date,
      startPrice: start.price,
      endPrice: end.price,
      direction: end.type === 'top' ? 'up' : 'down',
      high: Math.max(start.price, end.price),
      low: Math.min(start.price, end.price),
    });
  }
  return strokes;
}

function buildPivots(strokes) {
  const pivots = [];
  for (let i = 0; i + 2 < strokes.length; i += 1) {
    const trio = strokes.slice(i, i + 3);
    const low = Math.max(...trio.map((s) => s.low));
    const high = Math.min(...trio.map((s) => s.high));
    if (low > high) continue;
    pivots.push({
      startIndex: trio[0].startIndex,
      endIndex: trio[2].endIndex,
      confirmIndex: trio[2].confirmIndex,
      startDate: trio[0].startDate,
      endDate: trio[2].endDate,
      low,
      high,
      mid: (low + high) / 2,
      strokeStart: i,
    });
  }
  return pivots;
}

function buildPoints(anchors, pivots, dif) {
  const points = [];
  const byAnchor = new Map();
  // 极值锚点必须等后续反向锚点出现才锁定，买卖点也在该右侧确认日生效。
  for (let i = 2; i < anchors.length - 1; i += 1) {
    const current = anchors[i];
    const confirmedBy = anchors[i + 1];
    const previousSame = anchors[i - 2];
    const previousOpposite = anchors[i - 1];
    const side = current.type === 'bottom' ? 'buy' : 'sell';
    const currentDif = dif[current.sourceIndex];
    const previousDif = dif[previousSame.sourceIndex];
    let type = null;
    let reason = '';

    const pivot = pivots
      .filter(
        (p) =>
          p.confirmIndex <= confirmedBy.confirmIndex &&
          p.endIndex < previousOpposite.sourceIndex &&
          (side === 'buy' ? previousOpposite.price > p.high : previousOpposite.price < p.low),
      )
      .at(-1);
    if (pivot && (side === 'buy' ? current.price > pivot.high : current.price < pivot.low)) {
      type = side === 'buy' ? '3B' : '3S';
      reason = side === 'buy' ? '向上突破中枢后，回踩未重新进入中枢' : '向下跌破中枢后，回抽未重新进入中枢';
    } else {
      const previousPoint = byAnchor.get(i - 2);
      const secondBuy = previousPoint?.type === '1B' && current.price > previousSame.price;
      const secondSell = previousPoint?.type === '1S' && current.price < previousSame.price;
      if (secondBuy || secondSell) {
        type = side === 'buy' ? '2B' : '2S';
        reason = side === 'buy' ? '一类买点后的回踩未创新低' : '一类卖点后的回抽未创新高';
      } else if (Number.isFinite(currentDif) && Number.isFinite(previousDif)) {
        const divergence =
          side === 'buy'
            ? current.price < previousSame.price && currentDif > previousDif
            : current.price > previousSame.price && currentDif < previousDif;
        if (divergence) {
          type = side === 'buy' ? '1B' : '1S';
          reason = side === 'buy' ? '价格创新低但 MACD DIF 未创新低，底背驰近似' : '价格创新高但 MACD DIF 未创新高，顶背驰近似';
        }
      }
    }
    if (!type) continue;
    const point = {
      type,
      side,
      sourceIndex: current.sourceIndex,
      confirmIndex: confirmedBy.confirmIndex,
      date: current.date,
      confirmDate: confirmedBy.confirmDate,
      price: current.price,
      reason,
    };
    points.push(point);
    byAnchor.set(i, point);
  }
  return points;
}

function buildSignalSeries(length, points) {
  const signals = new Array(length).fill(0);
  const byDate = new Map();
  for (const p of points) {
    if (!byDate.has(p.confirmIndex)) byDate.set(p.confirmIndex, []);
    byDate.get(p.confirmIndex).push(p);
  }
  let holding = 0;
  for (let i = 0; i < length; i += 1) {
    for (const p of byDate.get(i) || []) holding = p.side === 'buy' ? 1 : 0;
    signals[i] = holding;
  }
  return signals;
}

function analyze(inputBars, options = {}) {
  const bars = normalizeBars(inputBars);
  const minStrokeBars = Math.max(3, Math.floor(Number(options.minStrokeBars) || 4));
  const empty = {
    fractals: [],
    strokes: [],
    pivots: [],
    points: [],
    signals: new Array(bars.length).fill(0),
    summary: { trend: '震荡', position: '暂无中枢', latestStroke: null, latestPivot: null, latestPoint: null },
    descriptions: ['历史结构不足，暂未形成可确认的缠论笔与中枢'],
    method: '包含处理 + 确认分型 + 交替笔 + 三笔重叠中枢的工程化近似',
    minStrokeBars,
  };
  if (bars.length < 12) return empty;

  const candidates = confirmFractals(bars);
  const anchors = buildAnchors(candidates, minStrokeBars);
  const strokes = buildStrokes(anchors);
  const pivots = buildPivots(strokes);
  const closes = bars.map((b) => b.close);
  const { dif } = ind.macd(closes);
  const points = buildPoints(anchors, pivots, dif);
  const signals = buildSignalSeries(bars.length, points);
  const latestStroke = strokes.at(-1) || null;
  const latestPivot = pivots.at(-1) || null;
  const latestPoint = points.at(-1) || null;
  const lastClose = closes.at(-1);
  const trend = latestStroke ? (latestStroke.direction === 'up' ? '上升笔' : '下降笔') : '震荡';
  const position = latestPivot
    ? lastClose > latestPivot.high
      ? '中枢上方'
      : lastClose < latestPivot.low
        ? '中枢下方'
        : '中枢内部'
    : '暂无中枢';
  const descriptions = [];
  if (latestStroke) {
    descriptions.push(
      `最近确认${latestStroke.direction === 'up' ? '上升笔' : '下降笔'}：${latestStroke.startDate} 至 ${latestStroke.endDate}，${round(latestStroke.startPrice)} → ${round(latestStroke.endPrice)}。`,
    );
  }
  if (latestPivot) {
    descriptions.push(`最近中枢区间 ${round(latestPivot.low)}–${round(latestPivot.high)}，当前价格位于${position}。`);
  }
  if (latestPoint) {
    descriptions.push(`最近确认信号 ${latestPoint.type}（${latestPoint.confirmDate}）：${latestPoint.reason}。`);
  } else if (strokes.length) {
    descriptions.push('当前尚无满足固定条件的 1/2/3 类买卖点，继续等待确认。');
  }
  if (!descriptions.length) descriptions.push('历史结构不足，暂未形成可确认的缠论笔与中枢');

  const serializeFractal = (f) => ({ ...f, price: round(f.price), high: round(f.high), low: round(f.low) });
  return {
    fractals: candidates.map(serializeFractal),
    strokes: strokes.map((s) => ({ ...s, startPrice: round(s.startPrice), endPrice: round(s.endPrice), high: round(s.high), low: round(s.low) })),
    pivots: pivots.map((p) => ({ ...p, low: round(p.low), high: round(p.high), mid: round(p.mid) })),
    points: points.map((p) => ({ ...p, price: round(p.price) })),
    signals,
    summary: { trend, position, latestStroke, latestPivot, latestPoint },
    descriptions,
    method: empty.method,
    minStrokeBars,
  };
}

module.exports = { analyze, mergeContainment, buildSignalSeries };
