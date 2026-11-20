'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const chan = require('../lib/chan');
const sector = require('../lib/sector');
const quant = require('../lib/quant');
const datasource = require('../lib/datasource');

function makeBars(count) {
  const bars = [];
  let previous = 100;
  for (let i = 0; i < count; i += 1) {
    const close = 100 + 14 * Math.sin((i * Math.PI) / 18) + 5 * Math.sin((i * Math.PI) / 7) + 8 * Math.sin((i * Math.PI) / 75);
    const open = previous;
    bars.push({
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      open,
      high: Math.max(open, close) + 0.8 + (i % 3) * 0.11,
      low: Math.min(open, close) - 0.8 - (i % 4) * 0.09,
      close,
      volume: 1_000_000 + (i % 17) * 17_000,
    });
    previous = close;
  }
  return bars;
}

function expectedSignals(length, points) {
  const signals = new Array(length).fill(0);
  let holding = 0;
  for (let i = 0; i < length; i += 1) {
    for (const point of points) {
      if (point.confirmIndex === i) holding = point.side === 'buy' ? 1 : 0;
    }
    signals[i] = holding;
  }
  return signals;
}

function assertPointTiming(result, bars) {
  for (const point of result.points) {
    assert.ok(point.confirmIndex >= point.sourceIndex);
    assert.equal(point.date, bars[point.sourceIndex].date);
    assert.equal(point.confirmDate, bars[point.confirmIndex].date);
  }
  assert.deepEqual(result.signals, expectedSignals(bars.length, result.points));
}

const bars = makeBars(360);

test('缠论追加未来 K 线不改写已确认结构和历史信号', () => {
  const full = chan.analyze(bars);
  assert.ok(full.fractals.length > 0 && full.strokes.length > 0);
  assert.ok(full.pivots.length > 0 && full.points.length > 0);
  assertPointTiming(full, bars);

  for (const length of [80, 120, 180, 240, 300]) {
    const prefixBars = bars.slice(0, length);
    const prefix = chan.analyze(prefixBars);
    for (const key of ['fractals', 'strokes', 'pivots', 'points']) {
      assert.deepEqual(
        prefix[key],
        full[key].filter((item) => item.confirmIndex < length),
        `${key} 在 ${length} 根前缀被未来数据改写`,
      );
    }
    assert.deepEqual(prefix.signals, full.signals.slice(0, length));
    assertPointTiming(prefix, prefixBars);
  }
});

test('sector.scoreAt 只使用 endIndex 及以前的数据且修正限制在 ±4', () => {
  for (let endIndex = 0; endIndex < bars.length; endIndex += 1) {
    const result = sector.scoreAt(bars, endIndex);
    assert.deepEqual(result, sector.scoreAt(bars.slice(0, endIndex + 1)));
    assert.ok(Number.isFinite(result.adjustment));
    assert.ok(result.adjustment >= -4 && result.adjustment <= 4);
  }
});

test('sector.analyze 数据失败时中性降级并恢复 monkeypatch', async () => {
  const names = ['stockIndustry', 'sectorKline', 'sectorSnapshot'];
  const originals = Object.fromEntries(names.map((name) => [name, datasource[name]]));
  try {
    datasource.stockIndustry = async (stockCode) => ({
      stockCode,
      boardCode: 'BK_TEST',
      boardName: '测试板块',
      industryName: '测试行业',
    });
    datasource.sectorKline = async () => {
      throw new Error('确定性离线失败');
    };
    datasource.sectorSnapshot = async () => ({ changePct: 0, upCount: 0, downCount: 0, time: null });

    const result = await sector.analyze('sh600000');
    assert.equal(result.available, false);
    assert.equal(result.score, 50);
    assert.equal(result.adjustment, 0);
    assert.equal(result.stockCode, '600000');
    assert.match(result.descriptions[0], /确定性离线失败/);
  } finally {
    for (const name of names) datasource[name] = originals[name];
  }
});

test('executeSignals 次日开盘整手成交，费用滑点方向正确且期末强平', () => {
  const windowBars = [
    { date: 'D0000', open: 10, close: 10 },
    { date: 'D0001', open: 11, close: 12 },
    { date: 'D0002', open: 20, close: 21 },
    { date: 'D0003', open: 30, close: 29 },
    { date: 'D0004', open: 20, close: 24 },
  ];
  const result = quant.executeSignals(windowBars, [0, 1, 0, 1, 1], 100_000);
  const trades = result.trades.slice().reverse();
  assert.deepEqual(trades.map((trade) => trade.side), ['buy', 'sell', 'buy', 'sell']);

  const feeBuy = 0.00026;
  const slip = 0.0005;
  const expectedShares = Math.floor(100_000 / (20 * (1 + slip) * (1 + feeBuy)) / 100) * 100;
  assert.equal(trades[0].shares, expectedShares);
  assert.equal(trades[0].price, Number((20 * (1 + slip)).toFixed(2)));
  assert.equal(trades[0].amount, Number((expectedShares * 20 * (1 + slip) * (1 + feeBuy)).toFixed(2)));
  assert.ok(trades[0].amount > trades[0].shares * 20 * (1 + slip));
  assert.ok(trades[1].price < windowBars[3].open);
  assert.ok(trades[2].price > windowBars[4].open);
  assert.ok(trades[1].pnl < trades[1].amount - trades[0].amount);
  assert.ok(trades[3].pnl < trades[3].amount - trades[2].amount);

  for (const trade of trades) {
    assert.ok(trade.shares > 0 && trade.shares % 100 === 0);
    if (!trade.forced) {
      const index = Number(trade.date.slice(1));
      assert.equal(trade.signalDate, windowBars[index - 1].date);
      assert.ok(trade.signalDate < trade.date);
    }
  }
  assert.equal(trades[3].forced, true);
  assert.equal(trades[3].date, 'D0004');
  assert.equal(trades[3].price, 24);
  assert.equal(result.metrics.closedTrades, 2);
});

test('compositeFromBars 相同测试起点下保持 daily 历史及滚动训练边界', () => {
  const common = { capital: 1_000_000, scoreAt: sector.scoreAt };
  const full = quant.compositeFromBars(bars, bars, { ...common, days: 300 });
  const prefixBars = bars.slice(0, 240);
  const prefix = quant.compositeFromBars(prefixBars, prefixBars, { ...common, days: 180 });

  assert.equal(full.range.start, bars[60].date);
  assert.equal(prefix.range.start, bars[60].date);
  assert.equal(full.daily.length, 300);
  assert.equal(prefix.daily.length, 180);
  assert.deepEqual(full.daily.slice(0, 180), prefix.daily);

  const dateIndex = new Map(bars.map((bar, index) => [bar.date, index]));
  for (const [result, input, days] of [[full, bars, 300], [prefix, prefixBars, 180]]) {
    assert.equal(result.weights.length, 9);
    const weightSum = result.weights.reduce((sum, row) => sum + row.weight, 0);
    assert.ok(Math.abs(weightSum - 100) < 0.001);
    assert.equal(result.walkForward.rebalanceEvery, 20);
    assert.equal(result.walkForward.rebalanceCount, Math.ceil(days / 20));

    const lastRebalance = 60 + (result.walkForward.rebalanceCount - 1) * 20;
    const trainingStart = Math.max(0, lastRebalance - 400);
    assert.deepEqual(result.walkForward.lastTraining, {
      start: input[trainingStart].date,
      end: input[lastRebalance - 1].date,
      bars: lastRebalance - trainingStart,
    });

    const ordinaryTrades = result.trades.filter((trade) => !trade.forced);
    assert.ok(ordinaryTrades.length > 0);
    for (const trade of ordinaryTrades) {
      assert.ok(trade.signalDate < trade.date);
      assert.equal(dateIndex.get(trade.date), dateIndex.get(trade.signalDate) + 1);
    }
  }
});
