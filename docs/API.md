# API 文档

所有接口均为同源 JSON，成功返回包含 `ok` 字段（`/api/backtest`、`/api/stock` 返回业务对象）。失败返回 `{ "ok": false, "error": "..." }`，状态码 400（参数错误）或 502（上游数据源异常）。

## GET /api/health

服务健康检查。

```json
{ "ok": true, "uptime": 12.3, "node": "v20.11.0" }
```

## GET /api/overview

行情总览：指数快照、近 60 日指数收盘序列、四类榜单。缓存 20 秒。

```json
{
  "ok": true,
  "updatedAt": "2026-11-20T13:01:44.841Z",
  "indices": [{ "symbol": "sh000001", "name": "上证指数", "price": 3533.79, "changePct": -1.23, "amount": 702573850000 }],
  "sparks": [{ "symbol": "sh000001", "points": [3500.1, 3512.4] }],
  "turnoverTotal": 1422200420000,
  "boards": { "gainers": [], "losers": [], "actives": [], "turnover": [] }
}
```

## GET /api/quotes

两种模式：

| 参数 | 说明 |
| --- | --- |
| `codes` | 逗号分隔的代码列表（最多 40 只），返回腾讯实时快照 |
| `page` / `size` / `sort` / `asc` | 新浪全市场分页，`sort` ∈ `changepercent` `amount` `turnoverratio` `mktcap` `per` |

```json
{
  "ok": true,
  "items": [{
    "code": "600519", "name": "贵州茅台", "price": 1485.75, "changePct": 1.75,
    "open": 1450.89, "high": 1489.09, "low": 1423.9, "prevClose": 1460.21,
    "volume": 6722900, "amount": 9796311852, "turnoverRate": 0.54,
    "pe": 22.61, "pb": 6.85, "floatCap": 1857309000000, "totalCap": 1857309000000,
    "limitUp": 1606.23, "limitDown": 1314.19, "time": "20261120161447"
  }]
}
```

## GET /api/kline

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `code` | 必填 | 6 位代码 |
| `period` | `day` | `day` / `week` / `month` |
| `count` | 250 | 最多 520 根 |

返回 `series`：`dates`、`bars`、`ma{ma5,ma10,ma20,ma60}`、`rsi`、`macd{dif,dea,hist}`、`chan`。其中 `chan` 包含已确认 `fractals`、`strokes`、`pivots`、`points`、因果 `signals`、摘要与文字说明；买卖点同时给出 `sourceIndex` 和 `confirmIndex`，页面只在确认位置绘制信号。

## GET /api/stock

个股聚合数据，参数 `code`、`period`、`count`。

```json
{
  "ok": true,
  "code": "600519",
  "name": "贵州茅台",
  "quote": { "price": 1485.75, "pe": 22.61, "pb": 6.85 },
  "fundamentals": { "reportDate": "2026-09-30", "revenue": 133283652508, "netProfit": 64467425981, "eps": 51.53, "roe": 24.47, "revenueYoY": 1.82, "profitYoY": -0.25 },
  "series": { "dates": [], "bars": [], "ma": {}, "rsi": [], "macd": {} },
  "technical": { "ma20": 1424.26, "rsi14": 68.1, "macdHist": 0.793, "mom20": 0.1129, "vol20": 0.264, "volRatio": 0.94, "signals": ["均线多头排列"] },
  "strategies": [{ "key": "ma_cross", "name": "双均线趋势", "params": { "fast": 5, "slow": 20 } }]
}
```

## GET /api/search

参数 `q`，返回 `items: [{ code, name, market }]`。

## GET /api/fundamentals

全市场最新财报，参数 `page`、`size`（≤100）、`sort`（`roe` `profitYoY` 等）。

## GET /api/screen/meta

返回因子定义、板块列表、默认过滤参数，以及策略库（`strategies`、`defaultStrategy`），用于渲染选股控制面板与策略卡片。

## GET /api/strategies

返回原 8 策略与 `chan_theory` 共 9 个选股策略的 `key`、名称、标签、参考来源、说明、参数与入选阈值。该接口用于选股；对外回测不提供策略选择。

```json
{
  "ok": true,
  "defaultStrategy": "volume_price",
  "items": [{
    "key": "volume_price", "name": "量价共振", "tag": "量能",
    "source": "microsoft/qlib · OBV 量价因子", "desc": "OBV 与价格同向、放量上涨或缩量回踩得分更高…",
    "params": { "period": 20 }, "minScore": 58
  }]
}
```

## POST /api/recommend

按指定策略扫描全市场并返回荐股列表。

```json
{
  "strategy": "volume_price",
  "params": {},
  "scanCount": 800,
  "candidates": 100,
  "limit": 12,
  "filters": {
    "minPrice": 2, "maxPrice": 50, "minFloatCap": 20, "maxFloatCap": 200,
    "minMarketCap": 0, "maxMarketCap": 200,
    "minTurnover": 0.5, "maxTurnover": 30, "peMax": 150,
    "boards": ["main", "gem", "star"], "excludeST": true
  }
}
```

返回在 `/api/screen` 结构基础上增加：

```json
{
  "ok": true,
  "strategy": "volume_price",
  "items": [{
    "code": "601939", "name": "建设银行", "price": 12.76, "changePct": 1.2,
    "score": 79.4, "grade": "A",
    "reasons": ["20日动量 +12.9%", "60日趋势 +20.6%", "均线多头排列"],
    "warnings": [],
    "factors": { "momentum": 91, "trend": 100, "volume": 42, "volatility": 88, "valuation": 96, "growth": 40 },
    "technical": { "ma20": 12.1, "rsi14": 64.3, "atrPct": 0.023, "rangePos": 0.86 }
  }],
  "meta": {
    "scanned": 800, "filtered": 512, "evaluated": 99, "qualified": 23,
    "strategy": { "key": "volume_price", "name": "量价共振", "minScore": 58 },
    "market": { "up": 320, "down": 480, "breadth": 40, "regime": "震荡" },
    "elapsedMs": 1450
  },
  "disclaimer": "策略结果由公开行情与财报数据计算，仅供研究参考，不构成投资建议。"
}
```

## POST /api/portfolio/diagnose

请求体为当前持仓（最多 30 只），返回每只股票的实时信号与组合汇总。

```json
{
  "holdings": [
    { "code": "600519", "shares": 100, "cost": 1500 },
    { "code": "000001", "shares": 1000, "cost": 11.5 }
  ]
}
```

返回：

```json
{
  "ok": true,
  "items": [{
    "code": "600519", "name": "贵州茅台", "price": 1485.75, "changePct": 1.75,
    "shares": 100, "cost": 1500, "marketValue": 148575, "pnl": -1425, "pnlPct": -0.95,
    "action": "add", "actionLabel": "加仓", "tone": "up",
    "confidence": 88, "score": 4.8, "riskLevel": "低",
    "reasons": ["站上 MA20", "MA20 高于 MA60", "短中期多头排列", "MACD 红柱"],
    "warnings": ["注意仓位控制，分批执行"],
    "levels": { "support": 1424.26, "resistance": 1489.09, "stopLoss": 1337.17, "takeProfit": 1489.09, "riskPct": 10 },
    "technical": { "ma20": 1424.26, "ma60": 1332.61, "rsi14": 68.1, "macdHist": 0.79, "volRatio": 0.94 }
  }],
  "summary": {
    "count": 2, "marketValue": 160795, "costValue": 161500, "pnl": -705,
    "pnlPct": -0.44, "dayPnl": 900,
    "actionCounts": { "add": 1, "hold": 1 },
    "riskAlerts": ["贵州茅台 占组合 92.4%，集中度偏高"]
  },
  "updatedAt": "2026-11-20T14:01:35.000Z"
}
```

`action` 取值：`buy` 买入、`add` 加仓、`hold` 持有、`watch` 观望、`reduce` 减仓、`exit` 清仓。

## GET /api/picks

多策略综合荐股榜单。对同一候选池同时运行统一 9 个技术策略，按 `0.72 × 平均得分 + 0.28 × 达标策略占比 × 100` 聚合，完整排名缓存 60 秒；筛选条件、`scanCount` 与 `candidates` 均参与缓存 key，同参数进行中请求会复用。重排失败且存在上一成功结果时返回 `stale:true` 并保留旧榜单。前端通过 `/api/quotes` 每 4 秒更新榜单行情，每 60 秒重算完整排名。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `limit` | 20 | 返回条数（5–40） |
| `scanCount` | 600 | 快照扫描数量（200–1200） |
| `candidates` | 90 | 技术评估候选数（30–120） |
| `minPrice` / `maxPrice` | 2 / 50 | 股价区间，单位为元 |
| `minMarketCap` / `maxMarketCap` | 0 / 200 | 总市值区间，单位为亿元 |
| `refresh` | - | `1` 时强制重新扫描 |

```json
{
  "ok": true,
  "items": [{
    "code": "600919", "name": "江苏银行", "price": 13.66, "changePct": 0.74,
    "consensus": 75.2, "score": 75.2, "grade": "A", "label": "强烈推荐",
    "qualified": 6, "qualifiedNames": ["量价共振", "60 日放量突破"],
    "bestStrategy": { "key": "volume_price", "name": "量价共振", "score": 83.1 },
    "strategyHits": [{ "key": "volume_price", "name": "量价共振", "score": 83.1, "passed": true }],
    "reasons": ["OBV 与价格同向向上", "放量上涨"]
  }],
  "strategyStats": [{ "key": "volume_price", "name": "量价共振", "avgScore": 57.5, "passCount": 12, "passRate": 20 }],
  "meta": {
    "strategyCount": 9, "candidates": 60, "scanned": 600, "filtered": 402,
    "evaluated": 90, "market": { "regime": "震荡", "breadth": 46 },
    "filters": { "minPrice": 5, "maxPrice": 80, "minMarketCap": 100, "maxMarketCap": 3000 },
    "asOf": "2026-11-20T15:01:00.000Z", "elapsedMs": 1380
  }
}
```

## GET /api/stock/advice

个股多策略综合建议。对同一只股票运行统一 9 个回测策略，用「胜率 × 盈利质量 × 盈亏比」归一化得到权重，再把各策略当前持仓/空仓信号加权。板块情绪仅作 ±4 分环境修正，最终映射为「买入 / 持有 / 卖出」；行业映射优先使用 push2，失败时回退东财 F10。行业映射失败按中性 50 分、修正 0 降级；行业成功但板块行情失败时保留行业字段，仅情绪降级，不影响九策略原始信号。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `code` | 必填 | 6 位代码 |
| `days` | 400 | 回测交易日数（160–800） |

```json
{
  "ok": true,
  "code": "600519", "name": "贵州茅台",
  "action": "hold", "actionLabel": "持有", "tone": "warn",
  "score": 51.7, "baseScore": 49.7, "sectorAdjustment": 2, "confidence": 77,
  "sector": {
    "available": true, "boardCode": "BK0475", "boardName": "酿酒行业",
    "score": 75, "state": "活跃", "adjustment": 2,
    "breadth": { "upCount": 20, "downCount": 10 },
    "currentConstituent": true
  },
  "consensus": {
    "total": 9, "longCount": 4, "flatCount": 5,
    "bullWeightPct": 36.6, "bearWeightPct": 63.4, "label": "策略分歧，等待确认"
  },
  "topStrategy": { "key": "bollinger", "name": "布林带回归", "weight": 30.5 },
  "reasons": ["4/9 个策略当前持仓，多头权重 36.6%", "板块情绪活跃 75 分，综合分 49.7 → 51.7（环境 +2）"],
  "warnings": ["策略信号分歧：4/9 个策略当前持仓"],
  "strategies": [{
    "key": "ma_cross", "name": "双均线趋势", "weight": 7.5,
    "signal": "long", "signalLabel": "持仓", "fresh": false,
    "metrics": {
      "winRate": 60, "totalReturn": 38.2, "annualized": 21.4,
      "maxDrawdown": -18.6, "sharpe": 1.1, "profitFactor": 2.3,
      "closedTrades": 10, "tradeCount": 21, "exposure": 63.4, "benchmarkReturn": 25.1
    }
  }],
  "updatedAt": "2026-11-20T15:02:00.000Z"
}
```

`action` 取值：`buy` 买入、`hold` 持有、`sell` 卖出。权重按回测质量前 3 策略等权分配（8 个可交易策略参与排名，缠论不参与），其余策略权重为 0；前 3 策略中任一策略当天出现新买入信号且该策略训练胜率 ≥ 50% 时返回 `buy`，前 3 全部空仓时返回 `sell` 并冷却 5 个交易日；RSI14 > 75 或 10 日涨幅 > 15% 时触发过热锁定并强制 `sell`，RSI14 < 50 且 10 日涨幅 < 5% 后解除，`overheat` 字段返回当前锁定状态、RSI 与 10 日涨幅。`score` 为加权综合分，仅用于展示强弱。

## GET /api/intraday

当日分时数据与统一 9 策略的分钟级买卖点。分钟线聚合为 5 分钟 OHLC 后复用缠论分析，已确认买卖点作为第 9 票映射回确认分钟；板块情绪仅展示，不独立触发交易。数据优先取腾讯当日分时，失败时回退新浪 5 分钟线。后端分钟数据缓存 3 秒，前端每 4 秒静默轮询并重算买卖点；标签页隐藏或离开分时视图时暂停，恢复可见后立即补刷新。这是分钟快照自动更新，不是逐笔实时推送，公开行情也可能延迟。

| 参数 | 说明 |
| --- | --- |
| `code` | 6 位代码 |

```json
{
  "ok": true,
  "code": "600519", "name": "贵州茅台", "date": "2026-11-20",
  "dataTime": "2026-11-20 15:00", "source": "腾讯财经分时",
  "prevClose": 1460.21, "price": 1485.75, "changePct": 1.75,
  "high": 1488, "low": 1426, "vwap": 1457.15,
  "bars": [{ "time": "09:30", "price": 1450.89, "avg": 1450.89, "volume": 23500 }],
  "markers": [{
    "index": 211, "time": "14:21", "price": 1445.5, "side": "buy", "label": "买点",
    "score": 2.7, "count": 2, "strategies": ["ma_cross", "volume_price"],
    "reasons": ["双均线趋势·分钟均线金叉", "量价共振·OBV 转强且放量"]
  }],
  "strategyUniverse": [{ "key": "volume_price", "name": "量价共振" }, { "key": "chan_theory", "name": "缠论结构" }],
  "chan": {
    "trend": "上升笔", "position": "中枢上方", "fiveMinuteBars": 49,
    "latestPoint": { "type": "2B", "side": "buy", "confirmIndex": 40, "confirmTime": "14:20" }
  },
  "sector": { "available": true, "boardName": "酿酒行业", "score": 75, "state": "活跃", "adjustment": 2 },
  "summary": {
    "stance": "偏多", "score": 2.1, "buyCount": 2, "sellCount": 2,
    "aboveVwap": true, "rsi": 63.2, "ma5": 1481.4, "ma20": 1470.8,
    "volRatio": 1.2, "obvStrength": 0.18, "blockedBuy": 3, "blockedSell": 5,
    "lastMarker": { "time": "14:36", "side": "sell", "price": 1456.03 }
  },
  "live": {
    "mode": "分钟快照轮询", "autoRefreshSeconds": 4, "realtime": false,
    "note": "非逐笔推送；页面每 4 秒重新拉取最新分钟快照并重算买卖点，行情可能存在延迟。"
  },
  "updatedAt": "2026-11-20T15:05:00.000Z"
}
```

至少两个策略同向投票，方向强度须不低于 2.2 且达到反向强度的 1.2 倍；买卖点交替并至少间隔 10 分钟。趋势和突破买点需要量比或 OBV 确认；高位急涨、严重偏离 VWAP 时拦截买点，当日低点、低位急跌或 RSI 过低时拦截卖点。历史标记基于已获取的整段分钟快照计算，可能因数据源修正而变化，不代表可成交或盈利保证。

## POST /api/screen

```json
{
  "weights": { "momentum": 22, "trend": 20, "volume": 15, "volatility": 13, "valuation": 15, "growth": 15 },
  "filters": {
    "scanCount": 600, "minPrice": 2, "maxPrice": 50,
    "minFloatCap": 20, "maxFloatCap": 200,
    "minMarketCap": 0, "maxMarketCap": 200,
    "minTurnover": 0.5, "maxTurnover": 30,
    "peMax": 150, "boards": ["main", "gem", "star"],
    "candidates": 70, "limit": 24, "excludeST": true
  }
}
```

返回：

```json
{
  "items": [{
    "code": "000001", "name": "平安银行", "price": 12.22, "changePct": 1.5,
    "score": 77.56,
    "factors": { "momentum": 87, "trend": 100, "volume": 43, "volatility": 90, "valuation": 98, "growth": 33 },
    "signals": ["均线多头排列"],
    "technical": { "ma20": 11.9, "mom20": 0.05, "rsi14": 61.2, "volRatio": 1.1 }
  }],
  "meta": { "scanned": 600, "filtered": 387, "evaluated": 69, "reportDate": "2026-09-30", "elapsedMs": 1258 }
}
```

## GET /api/backtest

只运行“多策略综合建议”的 walk-forward 组合回测，不再提供单策略或指标参数选择。每 20 个交易日调权，每次仅使用调权日前一交易日及以前最多 400 日数据，从 8 个可交易策略中按回测质量选取前 3 策略等权（各 1/3），其余策略权重为 0，缠论不参与。不再做多数派投票：前 3 策略中任一策略当天出现新买入信号且该策略训练胜率 ≥ 50% 时入场，前 3 全部空仓时离场并冷却 5 个交易日；RSI14 > 75 或 10 日涨幅 > 15% 时触发过热止盈并锁定，RSI14 < 50 且 10 日涨幅 < 5% 后解除并冷却。综合分与板块 ±4 修正仅用于展示强弱。收盘确认信号，下一交易日开盘成交。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `code` | 必填 | 6 位股票代码 |
| `days` | 500 | 回测区间交易日数，仅接受 60–800 的整数；其他值返回 HTTP 400，不再静默钳制 |
| `capital` | 1000000 | 初始资金 |

旧 `strategy`、`fast`、`slow`、`period` 等参数即使传入也会被忽略。返回 `strategy: "composite"`、指标、交易、曲线、最新权重、板块摘要与滚动训练元数据：

```json
{
  "strategy": "composite", "strategyName": "多策略综合建议",
  "metrics": {
    "totalReturn": 12.4, "annualized": 6.3, "maxDrawdown": -15.2, "sharpe": 0.8,
    "winRate": 55.6, "tradeCount": 18, "closedTrades": 9, "profitFactor": 1.6,
    "benchmarkReturn": 8.1, "finalEquity": 1124000
  },
  "current": { "signal": 1, "label": "持仓", "date": "2026-11-20" },
  "weights": [{ "key": "chan_theory", "name": "缠论结构", "weight": 12.4 }],
  "sector": { "available": true, "boardName": "酿酒行业", "score": 75, "state": "活跃", "adjustment": 2 },
  "walkForward": { "requestedDays": 500, "actualTestDays": 500, "rebalanceEvery": 20, "trainingDays": 400, "rebalanceCount": 25 },
  "curve": [{ "date": "2024-12-02", "equity": 1.0, "benchmark": 1.0 }],
  "trades": [{ "signalDate": "2025-01-03", "date": "2025-01-06", "side": "buy", "price": 1485.7, "shares": 600 }]
}
```

## 错误码

| 状态 | 场景 |
| --- | --- |
| 400 | 代码非 6 位、请求体过大、不支持的市场 |
| 404 | 接口或静态资源不存在 |
| 502 | 上游行情 / 财报接口不可用 |
