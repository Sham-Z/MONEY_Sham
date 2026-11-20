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

返回 `series`：`dates`、`bars`、`ma{ma5,ma10,ma20,ma60}`、`rsi`、`macd{dif,dea,hist}`。

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
  "strategies": [{ "key": "ma_cross", "name": "双均线金叉", "params": { "fast": 5, "slow": 20 } }]
}
```

## GET /api/search

参数 `q`，返回 `items: [{ code, name, market }]`。

## GET /api/fundamentals

全市场最新财报，参数 `page`、`size`（≤100）、`sort`（`roe` `profitYoY` 等）。

## GET /api/screen/meta

返回因子定义、板块列表、默认过滤参数，以及策略库（`strategies`、`defaultStrategy`），用于渲染选股控制面板与策略卡片。

## GET /api/strategies

返回 8 个可选策略的 `key`、名称、标签、参考来源、说明、参数与入选阈值。

```json
{
  "ok": true,
  "defaultStrategy": "alpha158",
  "items": [{
    "key": "turtle", "name": "海龟通道突破", "tag": "趋势",
    "source": "海龟交易法则 · vnpy", "desc": "价格站上 20 日高点附近且中期趋势向上时入选…",
    "params": { "entry": 20 }, "minScore": 62
  }]
}
```

## POST /api/recommend

按指定策略扫描全市场并返回荐股列表。

```json
{
  "strategy": "alpha158",
  "params": {},
  "scanCount": 800,
  "candidates": 100,
  "limit": 12,
  "filters": {
    "minPrice": 2, "maxPrice": 800, "minFloatCap": 20, "maxFloatCap": 8000,
    "minTurnover": 0.5, "maxTurnover": 30, "peMax": 150,
    "boards": ["main", "gem", "star"], "excludeST": true
  }
}
```

返回在 `/api/screen` 结构基础上增加：

```json
{
  "ok": true,
  "strategy": "alpha158",
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
    "strategy": { "key": "alpha158", "name": "Alpha158 多因子", "minScore": 58 },
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

实时多策略综合荐股榜单。对同一候选池同时运行 8 个选股策略，按平均得分与命中策略数聚合，缓存 3 分钟。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `limit` | 20 | 返回条数（5–40） |
| `scanCount` | 600 | 快照扫描数量（200–1200） |
| `candidates` | 90 | 技术评估候选数（30–120） |
| `refresh` | - | `1` 时强制重新扫描 |

```json
{
  "ok": true,
  "items": [{
    "code": "600919", "name": "江苏银行", "price": 13.66, "changePct": 0.74,
    "consensus": 75.2, "score": 75.2, "grade": "A", "label": "强烈推荐",
    "qualified": 6, "qualifiedNames": ["低波动价值", "海龟通道突破"],
    "bestStrategy": { "key": "low_vol_value", "name": "低波动价值", "score": 83.1 },
    "strategyHits": [{ "key": "low_vol_value", "name": "低波动价值", "score": 83.1, "passed": true }],
    "reasons": ["20日动量 +8.2%", "低估值 + 低波动"]
  }],
  "strategyStats": [{ "key": "low_vol_value", "name": "低波动价值", "avgScore": 57.5, "passCount": 12, "passRate": 20 }],
  "meta": {
    "strategyCount": 8, "candidates": 60, "scanned": 600, "filtered": 402,
    "evaluated": 90, "market": { "regime": "震荡", "breadth": 46 },
    "asOf": "2026-11-20T15:01:00.000Z", "elapsedMs": 1380
  }
}
```

## GET /api/stock/advice

个股多策略综合建议。对同一只股票运行 7 个回测策略，用「胜率 × 盈利质量 × 盈亏比」归一化得到权重，再把各策略当前持仓/空仓信号加权为「买入 / 持有 / 卖出」。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `code` | 必填 | 6 位代码 |
| `days` | 400 | 回测交易日数（160–800） |

```json
{
  "ok": true,
  "code": "600519", "name": "贵州茅台",
  "action": "hold", "actionLabel": "持有", "tone": "warn",
  "score": 49.7, "confidence": 77,
  "consensus": {
    "total": 7, "longCount": 4, "flatCount": 3,
    "bullWeightPct": 36.6, "bearWeightPct": 63.4, "label": "策略分歧，等待确认"
  },
  "topStrategy": { "key": "bollinger", "name": "布林带回归", "weight": 30.5 },
  "reasons": ["4/7 个策略当前持仓，多头权重 36.6%", "布林带回归：胜率 66.7% · 区间收益 51.2% · 当前空仓"],
  "warnings": ["策略信号分歧：4/7 个策略当前持仓"],
  "strategies": [{
    "key": "ma_cross", "name": "双均线金叉", "weight": 7.5,
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

`action` 取值：`buy` 买入、`hold` 持有、`sell` 卖出。权重经等权混合平滑，避免单一策略过度主导。

## GET /api/intraday

当日分时数据与分钟级多策略买卖点。数据优先取腾讯当日分时，失败时回退新浪 5 分钟线。

| 参数 | 说明 |
| --- | --- |
| `code` | 6 位代码 |

```json
{
  "ok": true,
  "code": "600519", "name": "贵州茅台", "date": "2026-11-20",
  "source": "腾讯财经分时", "prevClose": 1460.21, "price": 1485.75, "changePct": 1.75,
  "high": 1488, "low": 1426, "vwap": 1457.15,
  "bars": [{ "time": "09:30", "price": 1450.89, "avg": 1450.89, "volume": 23500 }],
  "markers": [{
    "index": 211, "time": "14:21", "price": 1445.5, "side": "buy", "label": "买点",
    "score": 2.7, "count": 2, "reasons": ["分钟均线金叉", "放量突破"]
  }],
  "summary": {
    "stance": "偏多", "score": 2.1, "buyCount": 4, "sellCount": 3,
    "aboveVwap": true, "rsi": 63.2, "ma5": 1481.4, "ma20": 1470.8, "volRatio": 1.2,
    "lastMarker": { "time": "14:45", "side": "buy", "price": 1468.88 }
  },
  "updatedAt": "2026-11-20T15:05:00.000Z"
}
```

买卖点由 VWAP 突破、分钟均线、MACD、RSI、量价突破五类规则加权投票生成，综合强度低于 1.5 或方向冲突时不输出。

## POST /api/screen

```json
{
  "weights": { "momentum": 22, "trend": 20, "volume": 15, "volatility": 13, "valuation": 15, "growth": 15 },
  "filters": {
    "scanCount": 600, "minPrice": 2, "maxPrice": 800,
    "minFloatCap": 20, "maxFloatCap": 8000,
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

| 参数 | 说明 |
| --- | --- |
| `code` | 股票代码 |
| `strategy` | `ma_cross` / `momentum` / `rsi_reversion` / `breakout` / `macd` / `bollinger` / `kdj` |
| `days` | 回测区间交易日数（120–800） |
| `fast` `slow` `signal` `period` `mult` `low` `high` `entry` `exit` | 策略参数 |

```json
{
  "metrics": {
    "totalReturn": -0.09, "annualized": -0.05, "maxDrawdown": -20.41, "sharpe": 0.06,
    "winRate": 33.3, "tradeCount": 30, "closedTrades": 15, "profitFactor": 1.42,
    "avgWinPct": 4.1, "avgLossPct": -2.8, "exposure": 58.2,
    "benchmarkReturn": 4.31, "finalEquity": 999087.88
  },
  "current": { "signal": 0, "label": "空仓", "daysSinceChange": 6, "date": "2026-11-20" },
  "curve": [{ "date": "2024-12-02", "equity": 1.0, "benchmark": 1.0 }],
  "trades": [{ "date": "2025-01-06", "side": "buy", "price": 1485.7, "shares": 600, "amount": 891420, "pnl": null }]
}
```

## 错误码

| 状态 | 场景 |
| --- | --- |
| 400 | 代码非 6 位、请求体过大、不支持的市场 |
| 404 | 接口或静态资源不存在 |
| 502 | 上游行情 / 财报接口不可用 |
