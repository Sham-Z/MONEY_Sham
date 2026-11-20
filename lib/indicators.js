'use strict';

/** 基础技术指标计算，全部为纯函数，输入输出均为数组（前导空位用 null 表示）。 */

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1 && Number.isFinite(sum)) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (prev == null) {
      // 首个有效值用起始简单均值近似，保证曲线连续
      if (i >= period - 1) {
        let s = 0;
        for (let j = i - period + 1; j <= i; j += 1) s += values[j] || 0;
        prev = s / period;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    const up = Math.max(diff, 0);
    const down = Math.max(-diff, 0);
    if (i <= period) {
      gain += up;
      loss += down;
      if (i === period) {
        gain /= period;
        loss /= period;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (period - 1) + up) / period;
      loss = (loss * (period - 1) + down) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const dif = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const valid = dif.map((v) => (v == null ? 0 : v));
  const dea = ema(valid, signal);
  const hist = dif.map((v, i) => (v != null && dea[i] != null ? (v - dea[i]) * 2 : null));
  return { dif, dea, hist };
}

function stdev(values) {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

/** 年化波动率（按日频 252 交易日） */
function annualVolatility(closes, period = 20) {
  const window = closes.slice(-period - 1);
  if (window.length < 5) return 0;
  const rets = [];
  for (let i = 1; i < window.length; i += 1) {
    if (window[i - 1] > 0) rets.push(window[i] / window[i - 1] - 1);
  }
  return stdev(rets) * Math.sqrt(252);
}

function maxDrawdown(series) {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.min(mdd, v / peak - 1);
  }
  return mdd;
}

function atr(bars, period = 14) {
  if (bars.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i += 1) {
    const b = bars[i];
    const pc = bars[i - 1].close;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  const window = trs.slice(-period);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

function pctChange(closes, days) {
  if (closes.length <= days) return null;
  const cur = closes[closes.length - 1];
  const base = closes[closes.length - 1 - days];
  if (!base) return null;
  return cur / base - 1;
}

module.exports = { sma, ema, rsi, macd, stdev, annualVolatility, maxDrawdown, atr, pctChange };
