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
    assert.equal(result.boardName, '测试板块');
    assert.equal(result.industryName, '测试行业');
    assert.match(result.descriptions[0], /已识别所属行业/);
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
    assert.equal(result.weights.filter((row) => row.weight > 0).length, 3);
    assert.equal(result.weights.find((row) => row.key === 'chan_theory').weight, 0);
    assert.equal(result.composite.cooldownDays, 5);
    assert.match(result.composite.entryRule, /新买入信号/);
    assert.match(result.composite.exitRule, /全部空仓/);
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

test('marketOf 正确识别北交所旧代码与 920 新代码', () => {
  assert.equal(datasource.marketOf('430047'), 'bj');
  assert.equal(datasource.marketOf('830799'), 'bj');
  assert.equal(datasource.marketOf('920002'), 'bj');
  assert.equal(datasource.marketOf('900901'), 'sh');
});

test('stockIndustry 主链路失败时回退 F10 并按行业排名选择 NEW_BOARD_CODE', async () => {
  const originalFetch = global.fetch;
  const urls = [];
  try {
    global.fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (!url.includes('datacenter.eastmoney.com')) throw new Error('push2 确定性离线');
      return new Response(JSON.stringify({
        result: {
          data: [
            { BOARD_TYPE: '概念', BOARD_RANK: '1', NEW_BOARD_CODE: 'BK9999', NEW_BOARD_NAME: '错误概念' },
            { BOARD_TYPE: '行业', BOARD_RANK: '2', BOARD_CODE: 'BK0001', NEW_BOARD_CODE: 'BK9998', NEW_BOARD_NAME: '次级行业' },
            { BOARD_TYPE: '行业', BOARD_RANK: '1', BOARD_CODE: 'BK0002', NEW_BOARD_CODE: 'BK0438', NEW_BOARD_NAME: '食品饮料' },
          ],
        },
      }), { status: 200 });
    };
    const result = await datasource.stockIndustry('600519');
    assert.deepEqual(result, {
      stockCode: '600519',
      industryName: '食品饮料',
      boardCode: 'BK0438',
      boardName: '食品饮料',
      source: '东方财富 F10',
    });
    const f10Url = urls.find((url) => url.includes('reportName=RPT_F10_CORETHEME_BOARDTYPE'));
    assert.ok(f10Url);
    assert.equal(new URL(f10Url).searchParams.get('filter'), '(SECUCODE="600519.SH")');
  } finally {
    global.fetch = originalFetch;
  }
});

test('stockIndustry 双源失败时明确报错且不伪造行业', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => {
      throw new Error('双源确定性离线');
    };
    await assert.rejects(() => datasource.stockIndustry('000002'), /F10 回退失败/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('quotes 三秒 TTL 内复用结果并合并并发请求', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  try {
    global.fetch = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const fields = Array(60).fill('0');
      fields[0] = '0';
      fields[1] = '浦发银行';
      fields[2] = '600000';
      fields[3] = '10.10';
      fields[30] = '20261121100000';
      fields[36] = '100';
      fields[37] = '200';
      fields[44] = '100';
      fields[45] = '200';
      return new Response(`v_sh600000="${fields.join('~')}";`, { status: 200 });
    };
    const [first, second] = await Promise.all([
      datasource.quotes(['600000']),
      datasource.quotes(['sh600000']),
    ]);
    assert.equal(calls, 1);
    assert.equal(first[0].price, 10.1);
    assert.deepEqual(second, first);
    await datasource.quotes(['600000']);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('picks 同参数并发只扫描一次，缓存 key 完整且失败保留上一榜单', async () => {
  const names = ['sinaUniverse', 'fundamentals', 'kline'];
  const originals = Object.fromEntries(names.map((name) => [name, datasource[name]]));
  let universeCalls = 0;
  let failUniverse = false;
  const stock = {
    code: '600000', symbol: 'sh600000', name: '浦发银行', price: 100, changePct: 1,
    turnoverRate: 2, pe: 10, pb: 1, amount: 1e9, floatCap: 1e11, totalCap: 2e11,
  };
  const options = {
    limit: 20,
    scanCount: 200,
    candidates: 30,
    filters: { minPrice: 2, maxPrice: 800, minFloatCap: 20, maxFloatCap: 8000, minMarketCap: 0, maxMarketCap: 100000 },
  };
  try {
    datasource.sinaUniverse = async () => {
      universeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (failUniverse) throw new Error('榜单确定性离线');
      return [stock];
    };
    datasource.fundamentals = async () => ({ reportDate: null, map: {}, count: 0 });
    datasource.kline = async () => bars;

    const [first, second] = await Promise.all([quant.picks(options), quant.picks(options)]);
    assert.equal(universeCalls, 1);
    assert.equal(first.items.length, 1);
    assert.deepEqual(second.items, first.items);

    await quant.picks(options);
    assert.equal(universeCalls, 1);

    failUniverse = true;
    const stale = await quant.picks({ ...options, force: true });
    assert.equal(universeCalls, 2);
    assert.equal(stale.stale, true);
    assert.equal(stale.meta.stale, true);
    assert.deepEqual(stale.items, first.items);

    failUniverse = false;
    await quant.picks({ ...options, scanCount: 201 });
    assert.equal(universeCalls, 3);
  } finally {
    for (const name of names) datasource[name] = originals[name];
  }
});

test('compositeFromBars 严格执行 60–119 日回测并拒绝非法天数', () => {
  const results = new Map();
  for (const days of [60, 80, 119]) {
    const result = quant.compositeFromBars(bars, bars, { days, scoreAt: sector.scoreAt });
    results.set(days, result);
    assert.equal(result.daily.length, days);
    assert.equal(result.walkForward.requestedDays, days);
    assert.equal(result.walkForward.actualTestDays, days);
    assert.equal(result.walkForward.rebalanceCount, Math.ceil(days / 20));
    assert.equal(result.range.start, bars[bars.length - days].date);
  }
  assert.notEqual(results.get(60).range.start, results.get(80).range.start);
  assert.notEqual(results.get(80).range.start, results.get(119).range.start);

  for (const days of [0, 59, 801, 60.5, 'abc']) {
    assert.throws(() => quant.compositeFromBars(bars, bars, { days }), /回测交易日需为 60–800 的整数/);
  }
});

test('60 日放量突破默认参数与策略库文案保持一致', () => {
  const meta = quant.STRATEGIES.find((strategy) => strategy.key === 'breakout');
  assert.equal(meta.name, '60 日放量突破');
  assert.deepEqual(meta.params, { entry: 60, exit: 20 });

  const closes = bars.map((bar) => bar.close);
  const signal = quant.buildSignals('breakout', meta.params, closes, bars);
  assert.equal(signal.length, bars.length);
  assert.ok(signal.every((value) => value === 0 || value === 1));
});
