'use strict';

const datasource = require('./datasource');

const MIN_BARS = 25;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Number(value.toFixed(2));
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stateOf(score) {
  if (score >= 80) return '火热';
  if (score >= 60) return '活跃';
  if (score >= 40) return '中性';
  if (score >= 20) return '退潮';
  return '冰点';
}

function neutral(description) {
  return {
    score: 50,
    state: '中性',
    adjustment: 0,
    components: { trend: 50, momentum: 50, volume: 50 },
    descriptions: [description],
  };
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/** 仅使用 endIndex 及之前的日 K；实时涨跌家数不属于本函数的输入。 */
function scoreAt(bars, endIndex = bars.length - 1) {
  const end = Math.min(bars.length - 1, Math.trunc(endIndex));
  if (!Number.isInteger(end) || end < MIN_BARS - 1) {
    return neutral('有效日 K 不足 25 根，无法完整计算趋势、20 日动量与量能，按中性 50 分处理，环境修正为 0。');
  }

  const start = end - MIN_BARS + 1;
  const closes = new Array(MIN_BARS);
  const volumes = new Array(MIN_BARS);
  for (let i = 0; i < MIN_BARS; i += 1) {
    const bar = bars[start + i];
    if (!bar || !Number.isFinite(bar.close) || bar.close <= 0 || !Number.isFinite(bar.volume) || bar.volume < 0) {
      return neutral('最近 25 根日 K 包含无效收盘价或成交量，按中性 50 分处理，环境修正为 0。');
    }
    closes[i] = bar.close;
    volumes[i] = bar.volume;
  }

  const close = closes[MIN_BARS - 1];
  const ma5 = average(closes.slice(20));
  const ma20 = average(closes.slice(5));
  const previousMa20 = average(closes.slice(0, 20));
  const structure = clamp(50 + 300 * (ma5 / ma20 - 1) + 200 * (close / ma20 - 1), 0, 100);
  const slope = clamp(50 + 500 * (ma20 / previousMa20 - 1), 0, 100);
  const trend = structure * 0.7 + slope * 0.3;

  const return5 = close / closes[19] - 1;
  const return20 = close / closes[4] - 1;
  const momentum5 = clamp(50 + 500 * return5, 0, 100);
  const momentum20 = clamp(50 + 250 * return20, 0, 100);
  const momentum = (momentum5 + momentum20) / 2;

  const recentVolume = average(volumes.slice(20));
  const previousVolume = average(volumes.slice(0, 20));
  const volume =
    previousVolume > 0
      ? clamp(50 + 100 * (recentVolume / previousVolume - 1), 0, 100)
      : recentVolume > 0
        ? 100
        : 50;

  const score = round(trend * 0.4 + momentum * 0.35 + volume * 0.25);
  const adjustment = clamp((score - 50) * 0.08, -4, 4);
  const volumeDescription =
    previousVolume > 0
      ? `近 5 日均量较前 20 日变化 ${pct(recentVolume / previousVolume - 1)}`
      : '前 20 日均量为零，量能按边界规则计分';
  return {
    score,
    state: stateOf(score),
    adjustment,
    components: { trend: round(trend), momentum: round(momentum), volume: round(volume) },
    descriptions: [
      `趋势得分 ${round(trend)}：MA5/MA20 结构占七成，MA20 近 5 日斜率占三成。`,
      `动量得分 ${round(momentum)}：5 日涨跌 ${pct(return5)}，20 日涨跌 ${pct(return20)}，等权合成。`,
      `量能得分 ${round(volume)}：${volumeDescription}。`,
    ],
  };
}

function degraded(stockCode, mapping, error) {
  const message = String(error?.message || error || '未知错误').replace(/\s+/g, ' ').slice(0, 180);
  return {
    available: false,
    stockCode,
    boardCode: mapping?.boardCode || null,
    boardName: mapping?.boardName || null,
    industryName: mapping?.industryName || null,
    score: 50,
    state: '中性',
    adjustment: 0,
    components: { trend: 50, momentum: 50, volume: 50 },
    breadth: null,
    descriptions: [
      mapping
        ? `已识别所属行业“${mapping.boardName || mapping.industryName}”，但板块行情获取失败（${message}）；行业信息正常保留，情绪按中性 50 分降级，环境修正为 0。`
        : `行业映射失败（${message}），板块情绪按中性 50 分降级，环境修正为 0。`,
      'currentConstituent 仅表示当前行业归属口径，不代表严格的历史成份。',
    ],
    source: '东方财富',
    asOf: new Date().toISOString(),
    currentConstituent: true,
  };
}

async function analyze(code) {
  const stockCode = String(code ?? '')
    .trim()
    .replace(/^(sh|sz|bj)/i, '');
  let mapping = null;
  try {
    mapping = await datasource.stockIndustry(stockCode);
    const [bars, snapshot] = await Promise.all([
      datasource.sectorKline(mapping.boardCode, { count: 500 }),
      datasource.sectorSnapshot(mapping.boardCode),
    ]);
    const result = scoreAt(bars);
    return {
      available: true,
      stockCode: mapping.stockCode,
      industryName: mapping.industryName,
      boardCode: mapping.boardCode,
      boardName: mapping.boardName,
      ...result,
      breadth: {
        changePct: snapshot.changePct,
        upCount: snapshot.upCount,
        downCount: snapshot.downCount,
        time: snapshot.time,
      },
      descriptions: [
        ...result.descriptions,
        `实时板块涨跌 ${pct(snapshot.changePct / 100)}，上涨 ${snapshot.upCount} 家、下跌 ${snapshot.downCount} 家；仅作展示，不参与评分。`,
        'currentConstituent 仅表示当前行业归属口径，不代表严格的历史成份。',
      ],
      source: '东方财富',
      asOf: snapshot.time || new Date().toISOString(),
      currentConstituent: true,
    };
  } catch (error) {
    return degraded(stockCode, mapping, error);
  }
}

module.exports = { scoreAt, analyze };
