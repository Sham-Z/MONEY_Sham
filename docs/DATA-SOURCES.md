# 数据源说明

平台只使用公开、无需鉴权的行情与财报接口，全部由服务端代理请求并归一化，浏览器不直接访问上游。

## 1. 腾讯财经 —— 实时快照

```
GET https://qt.gtimg.cn/q=sh600519,sz000001,sh000001
```

- 返回 GBK 编码的 `v_symbol="..."` 文本，字段以 `~` 分隔。
- 代码前缀：沪市 `sh`、深市 `sz`（`6xxxxx` → sh，`0/3xxxxx` → sz）。
- 解析的关键字段（从 0 开始计数）：

| 索引 | 含义 | 索引 | 含义 |
| --- | --- | --- | --- |
| 1 | 名称 | 32 | 涨跌幅 % |
| 2 | 代码 | 33 / 34 | 最高 / 最低 |
| 3 | 当前价 | 36 | 成交量（手） |
| 4 | 昨收 | 37 | 成交额（万元） |
| 5 | 今开 | 38 | 换手率 % |
| 31 | 涨跌额 | 39 / 46 | 市盈率 / 市净率 |
| 44 / 45 | 流通市值 / 总市值（亿元） | 49 | 量比 |

指数（`sh000001` 等）使用同一接口，`成交量/成交额` 字段为指数成交数据。

## 2. 腾讯财经 —— K 线

```
GET https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,320,qfq
```

- `param` 格式：`代码,周期,起始,结束,数量,复权`；周期 `day/week/month`，复权 `qfq`（前复权）或留空。
- 返回 `data.<symbol>.qfqday`（或 `day`）数组，每根 K 线为：
  `[日期, 开, 收, 高, 低, 成交量(手), ...]`。
- `web.ifzq.gtimg.cn` 域名在部分网络下会触发风控（HTTP 501），因此代码依次尝试
  `ifzq.gtimg.cn` → `web.ifzq.gtimg.cn`，最后回退到新浪 K 线。

## 3. 新浪财经 —— 全市场行情

```
GET https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData
    ?page=1&num=100&sort=amount&asc=0&node=hs_a&symbol=
```

- `node=hs_a` 覆盖沪深京 A 股约 5500 只，`num` 最大 100，支持按 `changepercent`、`amount`、`turnoverratio`、`mktcap`、`per` 等字段排序。
- 需带 `Referer: https://finance.sina.com.cn/`。
- 返回字段：`symbol/code/name/trade/pricechange/changepercent/open/high/low/settlement/volume/amount/turnoverratio/per/pb/mktcap/nmc`。
- `mktcap`、`nmc` 单位为万元，服务端统一换算为元。

### 备用 K 线

```
GET https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData
    ?symbol=sh600519&scale=240&ma=no&datalen=320
```

`scale`：240 日线、1200 周线、7200 月线。该接口不复权，仅在前两个 K 线源均失败时使用。

## 4. 东方财富 —— 定期报告

```
GET https://datacenter-web.eastmoney.com/api/data/v1/get
    ?reportName=RPT_LICO_FN_CPD
    &columns=SECURITY_CODE,SECURITY_NAME_ABBR,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT,BASIC_EPS,WEIGHTAVG_ROE,YSTZ,SJLTZ
    &pageSize=500&pageNumber=1&sortColumns=SECURITY_CODE&sortTypes=1
    &filter=(REPORTDATE='2026-09-30')
```

- 报告期按「季度结束后 35 天」推断最新可得报告（如 11 月取三季报）。
- 字段：营业收入、归母净利润、每股收益、加权 ROE、营收同比 `YSTZ`、净利同比 `SJLTZ`。
- 全量约 2900 条，按 500 条/页并发抓取，缓存 1 小时。

## 5. 东方财富 —— 搜索

```
GET https://searchapi.eastmoney.com/api/suggest/get?input=茅台&type=14&token=...&count=12
```

返回 `QuotationCodeTable.Data`，过滤 `Classify=AStock` 后用于代码 / 名称联想。

## 缓存与降级策略

| 数据 | 缓存时长 |
| --- | --- |
| 行情榜单、快照 | 25 秒 |
| 指数总览（含 60 日走势） | 20 秒 |
| 个股 K 线 | 5 分钟 |
| 全市场财报 | 1 小时 |
| 搜索联想 | 10 分钟 |

- 同一 key 的并发请求会合并为一次上游调用。
- 上游失败时返回上一次成功结果（标记为陈旧），避免页面白屏。
- 单只股票 K 线失败不会中断整轮选股。
