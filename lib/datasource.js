'use strict';

const { TtlCache } = require('./cache');

const cache = new TtlCache();
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const gbk = new TextDecoder('gbk');

async function request(url, { headers = {}, timeout = 9000, decode = 'utf8' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        ...headers,
      },
    });
    if (!res.ok) throw new Error(`upstream ${res.status} ${url.slice(0, 80)}`);
    if (decode === 'gbk') return gbk.decode(await res.arrayBuffer());
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function marketOf(code) {
  if (/^(?:[48]|920)/.test(code)) return 'bj';
  if (/^[69]/.test(code)) return 'sh';
  if (/^[03]/.test(code)) return 'sz';
  return 'sh';
}

function prefixed(code) {
  const c = String(code).trim();
  if (/^(sh|sz|bj)\d{6}$/i.test(c)) return c.toLowerCase();
  return `${marketOf(c)}${c}`;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ------------------------------------------------------------------ */
/* 新浪：全市场 A 股列表（行情快照，支持排序分页）                        */
/* ------------------------------------------------------------------ */

function normalizeSinaRow(row) {
  return {
    code: row.code,
    symbol: row.symbol,
    name: row.name,
    price: num(row.trade),
    change: num(row.pricechange),
    changePct: num(row.changepercent),
    open: num(row.open),
    high: num(row.high),
    low: num(row.low),
    prevClose: num(row.settlement),
    volume: num(row.volume), // 股
    amount: num(row.amount), // 元
    turnoverRate: num(row.turnoverratio),
    pe: num(row.per),
    pb: num(row.pb),
    totalCap: num(row.mktcap) * 1e4, // 元
    floatCap: num(row.nmc) * 1e4, // 元
    time: row.ticktime,
  };
}

async function sinaList({ page = 1, size = 80, sort = 'changepercent', asc = 0, node = 'hs_a' } = {}) {
  const key = `sina:${node}:${page}:${size}:${sort}:${asc}`;
  return cache.get(key, 25_000, async () => {
    const url =
      'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
      `?page=${page}&num=${size}&sort=${encodeURIComponent(sort)}&asc=${asc ? 1 : 0}&node=${node}&symbol=`;
    const text = await request(url, { headers: { Referer: 'https://finance.sina.com.cn/' } });
    const raw = JSON.parse(text);
    if (!Array.isArray(raw)) throw new Error('sina list format error');
    return raw.map(normalizeSinaRow);
  });
}

async function sinaUniverse(count = 600) {
  const pages = Math.ceil(count / 100);
  const tasks = [];
  for (let p = 1; p <= pages; p += 1) {
    tasks.push(sinaList({ page: p, size: 100, sort: 'amount', asc: 0 }).catch(() => []));
  }
  const results = await Promise.all(tasks);
  const seen = new Set();
  const out = [];
  for (const rows of results) {
    for (const r of rows) {
      if (!r.code || seen.has(r.code)) continue;
      seen.add(r.code);
      out.push(r);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 腾讯：实时快照 + K 线                                                */
/* ------------------------------------------------------------------ */

function parseTencentQuote(line) {
  const m = line.match(/v_((?:sh|sz|bj)\d{6})="(.*)"/);
  if (!m) return null;
  const f = m[2].split('~');
  if (f.length < 46) return null;
  return {
    symbol: m[1],
    code: f[2],
    name: f[1],
    price: num(f[3]),
    prevClose: num(f[4]),
    open: num(f[5]),
    change: num(f[31]),
    changePct: num(f[32]),
    high: num(f[33]),
    low: num(f[34]),
    volume: num(f[36]) * 100, // 手 -> 股
    amount: num(f[37]) * 1e4, // 万 -> 元
    turnoverRate: num(f[38]),
    pe: num(f[39]),
    amplitude: num(f[43]),
    floatCap: num(f[44]) * 1e8,
    totalCap: num(f[45]) * 1e8,
    pb: num(f[46]),
    limitUp: num(f[47]),
    limitDown: num(f[48]),
    volumeRatio: num(f[49]),
    avgPrice: num(f[51]),
    time: f[30],
    isIndex: f[0] === '1' || /^(sh000|sz399)/.test(m[1]),
  };
}

async function quotes(codes) {
  const symbols = [...new Set(codes.map(prefixed))];
  if (!symbols.length) return [];
  return cache.get(`tencent:quotes:${symbols.join(',')}`, 3_000, async () => {
    const chunks = [];
    for (let i = 0; i < symbols.length; i += 40) chunks.push(symbols.slice(i, i + 40));
    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const text = await request(`https://qt.gtimg.cn/q=${chunk.join(',')}`, {
          decode: 'gbk',
          headers: { Referer: 'https://gu.qq.com/' },
        });
        return text
          .split(';')
          .map((l) => l.trim())
          .filter(Boolean)
          .map(parseTencentQuote)
          .filter(Boolean);
      }),
    );
    return results.flat();
  });
}

const KLINE_KEY_MAP = { day: 'day', week: 'week', month: 'month' };

const KLINE_HOSTS = ['https://ifzq.gtimg.cn', 'https://web.ifzq.gtimg.cn'];

async function fetchTencentKline(host, symbol, p, count, fq) {
  const url = `${host}/appstock/app/fqkline/get?param=${symbol},${p},,,${count},${fq}`;
  const text = await request(url, { headers: { Referer: 'https://gu.qq.com/' } });
  if (!text.startsWith('{')) throw new Error('kline 响应异常');
  const json = JSON.parse(text);
  const node = json?.data?.[symbol] || {};
  const bars = node[`${fq}${p}`] || node[p] || [];
  if (!Array.isArray(bars) || !bars.length) throw new Error('无 K 线数据');
  return bars.map((b) => ({
    date: b[0],
    open: num(b[1]),
    close: num(b[2]),
    high: num(b[3]),
    low: num(b[4]),
    volume: num(b[5]) * 100, // 手 -> 股
  }));
}

/* ------------------------------------------------------------------ */
/* 分时数据：腾讯当日分时，失败回退新浪 5 分钟线                          */
/* ------------------------------------------------------------------ */

function inTradingSession(hhmm) {
  const m = Number(hhmm);
  return (m >= 930 && m <= 1130) || (m >= 1300 && m <= 1500);
}

function fmtClock(hhmm) {
  return `${String(hhmm).slice(0, 2)}:${String(hhmm).slice(2, 4)}`;
}

function parseMinuteRows(rows) {
  const bars = [];
  let prevVol = 0;
  let prevAmount = 0;
  let lastTime = '';
  for (const row of rows) {
    const fields = String(row).trim().split(/\s+/);
    if (fields.length < 4) continue;
    const hhmm = fields[0];
    if (!inTradingSession(hhmm) || hhmm === lastTime) continue;
    lastTime = hhmm;
    const price = num(fields[1]);
    const cumVolLots = num(fields[2]);
    const cumAmount = num(fields[3]);
    if (price <= 0) continue;
    const volume = Math.max(0, (cumVolLots - prevVol) * 100);
    const amount = Math.max(0, cumAmount - prevAmount);
    prevVol = cumVolLots;
    prevAmount = cumAmount;
    bars.push({
      time: fmtClock(hhmm),
      price,
      avg: cumVolLots > 0 ? Number((cumAmount / (cumVolLots * 100)).toFixed(3)) : price,
      volume,
      amount,
    });
  }
  return bars;
}

/** 分时分析最少需要的分钟根数：MA20 / 布林带需要 20 个样本，信号从第 21 根开始 */
const MIN_INTRADAY_BARS = 21;

async function fetchTencentMinute(symbol) {
  const url = `https://ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`;
  const text = await request(url, { headers: { Referer: 'https://gu.qq.com/' } });
  const json = JSON.parse(text);
  const node = json?.data?.[symbol];
  const rows = node?.data?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('无分时数据');
  const dateRaw = String(node.data.date || '');
  const date = /^\d{8}$/.test(dateRaw)
    ? `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`
    : '';
  const qt = Array.isArray(node.qt?.[symbol]) ? node.qt[symbol] : [];
  const prevClose = num(qt[4]);
  const bars = parseMinuteRows(rows);
  if (!bars.length) throw new Error('无分时数据');
  return { date, prevClose, bars, source: '腾讯财经分时' };
}

/** 新浪分钟线只保留最新交易日（当日），用于实时回退 */
function sinaMinuteBars(rows, source) {
  const date = String(rows.at(-1).day).slice(0, 10);
  const todayRows = rows.filter((r) => String(r.day).slice(0, 10) === date);
  if (!todayRows.length) throw new Error('无分时数据');
  let cumVol = 0;
  let cumAmount = 0;
  const bars = todayRows.map((r) => {
    const volume = num(r.volume);
    const amount = num(r.amount);
    cumVol += volume;
    cumAmount += amount;
    return {
      time: String(r.day).slice(11, 16),
      price: num(r.close),
      avg: cumVol > 0 ? Number((cumAmount / cumVol).toFixed(3)) : num(r.close),
      volume,
      amount,
    };
  });
  const prevRows = rows.filter((r) => String(r.day).slice(0, 10) < date);
  const prevClose = prevRows.length ? num(prevRows.at(-1).close) : num(bars[0].price);
  return { date, prevClose, bars, source };
}

async function fetchSinaMinute(symbol, scale = 1) {
  const url =
    'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData' +
    `?symbol=${symbol}&scale=${scale}&ma=no&datalen=300`;
  const text = await request(url, { headers: { Referer: 'https://finance.sina.com.cn/' } });
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || !rows.length) throw new Error('无分时数据');
  return sinaMinuteBars(rows, scale === 1 ? '新浪财经 1 分钟线' : '新浪财经 5 分钟线');
}

async function intraday(code) {
  const symbol = prefixed(code);
  if (!/^(sh|sz|bj)\d{6}$/.test(symbol)) throw new Error('暂不支持该市场的分时数据');
  const key = `minute:${symbol}`;
  return cache.get(key, 3_000, async () => {
    // 只使用当日分时，保证买卖点与当前交易日一致；腾讯失败时回退新浪 1 分钟 / 5 分钟线
    const attempts = [
      () => fetchTencentMinute(symbol),
      () => fetchSinaMinute(symbol, 1),
      () => fetchSinaMinute(symbol, 5),
    ];
    let best = null;
    let lastError = null;
    for (const attempt of attempts) {
      try {
        const data = await attempt();
        if (!best || data.bars.length > best.bars.length) best = data;
        if (data.bars.length >= MIN_INTRADAY_BARS) return data;
      } catch (err) {
        lastError = lastError || err;
      }
    }
    if (best) return best;
    throw lastError || new Error('分时数据不足');
  });
}

const SINA_SCALE = { day: 240, week: 1200, month: 7200 };

async function fetchSinaKline(symbol, p, count) {
  const scale = SINA_SCALE[p] || 240;
  const url =
    'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData' +
    `?symbol=${symbol}&scale=${scale}&ma=no&datalen=${Math.min(1023, count)}`;
  const text = await request(url, { headers: { Referer: 'https://finance.sina.com.cn/' } });
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || !rows.length) throw new Error('无 K 线数据');
  return rows.map((r) => ({
    date: r.day,
    open: num(r.open),
    close: num(r.close),
    high: num(r.high),
    low: num(r.low),
    volume: num(r.volume),
  }));
}

async function kline(code, { period = 'day', count = 260, adjust = 'qfq' } = {}) {
  const symbol = prefixed(code);
  if (!/^(sh|sz)\d{6}$/.test(symbol)) throw new Error('暂不支持该市场的 K 线数据');
  const p = KLINE_KEY_MAP[period] || 'day';
  const fq = adjust === 'none' ? '' : adjust;
  const key = `kline:${symbol}:${p}:${count}:${fq}`;
  return cache.get(key, 5 * 60_000, async () => {
    let lastErr = null;
    for (const host of KLINE_HOSTS) {
      try {
        return await fetchTencentKline(host, symbol, p, count, fq);
      } catch (err) {
        lastErr = err;
      }
    }
    try {
      return await fetchSinaKline(symbol, p, count);
    } catch {
      throw lastErr || new Error('K 线数据源不可用');
    }
  });
}

/* ------------------------------------------------------------------ */
/* 东方财富：财报数据 + 股票搜索                                         */
/* ------------------------------------------------------------------ */

function latestReportDate(now = new Date()) {
  const quarters = ['12-31', '09-30', '06-30', '03-31'];
  for (let year = now.getFullYear(); year >= now.getFullYear() - 1; year -= 1) {
    for (const q of quarters) {
      const end = new Date(`${year}-${q}T00:00:00+08:00`);
      if (end.getTime() + 35 * 86400_000 <= now.getTime()) return `${year}-${q}`;
    }
  }
  return `${now.getFullYear() - 1}-12-31`;
}

async function fetchFundamentalPage(reportDate, pageNumber, pageSize = 500) {
  const url = new URL('https://datacenter-web.eastmoney.com/api/data/v1/get');
  url.searchParams.set('reportName', 'RPT_LICO_FN_CPD');
  url.searchParams.set(
    'columns',
    'SECURITY_CODE,SECURITY_NAME_ABBR,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT,BASIC_EPS,WEIGHTAVG_ROE,YSTZ,SJLTZ',
  );
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('pageNumber', String(pageNumber));
  url.searchParams.set('sortColumns', 'SECURITY_CODE');
  url.searchParams.set('sortTypes', '1');
  url.searchParams.set('filter', `(REPORTDATE='${reportDate}')`);
  const text = await request(url.toString(), { headers: { Referer: 'https://data.eastmoney.com/' } });
  const json = JSON.parse(text);
  if (!json?.success || !json?.result) return { rows: [], pages: 0 };
  return { rows: json.result.data || [], pages: json.result.pages || 0 };
}

async function fundamentals() {
  const reportDate = latestReportDate();
  return cache.get(`fund:${reportDate}`, 60 * 60_000, async () => {
    const first = await fetchFundamentalPage(reportDate, 1);
    let rows = first.rows;
    const pages = Math.min(first.pages, 12);
    if (pages > 1) {
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, i) =>
          fetchFundamentalPage(reportDate, i + 2)
            .then((r) => r.rows)
            .catch(() => []),
        ),
      );
      rows = rows.concat(...rest);
    }
    const map = {};
    for (const r of rows) {
      map[r.SECURITY_CODE] = {
        reportDate,
        name: r.SECURITY_NAME_ABBR,
        revenue: num(r.TOTAL_OPERATE_INCOME),
        netProfit: num(r.PARENT_NETPROFIT),
        eps: num(r.BASIC_EPS),
        roe: num(r.WEIGHTAVG_ROE),
        revenueYoY: num(r.YSTZ),
        profitYoY: num(r.SJLTZ),
      };
    }
    return { reportDate, map, count: Object.keys(map).length };
  });
}

async function search(keyword) {
  const q = String(keyword || '').trim();
  if (!q) return [];
  return cache.get(`search:${q}`, 10 * 60_000, async () => {
    const url =
      'https://searchapi.eastmoney.com/api/suggest/get?input=' +
      encodeURIComponent(q) +
      '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=12';
    const text = await request(url, { headers: { Referer: 'https://quote.eastmoney.com/' } });
    const json = JSON.parse(text);
    const list = json?.QuotationCodeTable?.Data || [];
    return list
      .filter((d) => d.Classify === 'AStock' || /^[0-9]{6}$/.test(d.Code || ''))
      .slice(0, 10)
      .map((d) => ({ code: d.Code, name: d.Name, market: d.SecurityTypeName || '' }));
  });
}

/* ------------------------------------------------------------------ */
/* 东方财富：当前行业映射 + 板块行情与日 K                              */
/* ------------------------------------------------------------------ */

const INDUSTRY_TTL = 6 * 60 * 60_000;

function normalizedStockCode(code) {
  const stockCode = String(code ?? '')
    .trim()
    .replace(/^(sh|sz|bj)/i, '');
  if (!/^\d{6}$/.test(stockCode)) throw new Error('股票代码格式错误');
  return stockCode;
}

function normalizedBoardCode(boardCode) {
  const code = String(boardCode ?? '').trim().toUpperCase();
  if (!/^(BK\d{4}|881\d{3})$/.test(code)) throw new Error('板块代码格式错误');
  return code;
}

function parseJsonp(text) {
  const m = String(text || '').match(/^[^(]*\((.*)\)\s*$/s);
  if (!m) throw new Error('同花顺返回格式异常');
  return JSON.parse(m[1]);
}

function stripIndustryLevel(name) {
  return String(name || '')
    .trim()
    .replace(/[ⅠⅡⅢIVX]+$/g, '')
    .replace(/\s+/g, '');
}

/** 同花顺行业板块名称 -> 881xxx 代码，用于板块日 K 与实时行情 */
async function thsBoards() {
  return cache.get('ths:industry-boards', INDUSTRY_TTL, async () => {
    const text = await request('https://q.10jqka.com.cn/thshy/', {
      headers: { Referer: 'https://q.10jqka.com.cn/' },
      decode: 'gbk',
      timeout: 12_000,
    });
    const map = new Map();
    const re = /code\/(881\d{3})\/[^>]*>\s*([^<]{2,24}?)\s*<\/a>/g;
    let m;
    while ((m = re.exec(text))) {
      const name = m[2].trim();
      if (name) map.set(name, m[1]);
    }
    if (!map.size) throw new Error('同花顺行业板块列表为空');
    return map;
  });
}

async function industryBoards() {
  return cache.get('eastmoney:industry-boards', INDUSTRY_TTL, async () => {
    const url = new URL('https://push2.eastmoney.com/api/qt/clist/get');
    url.searchParams.set('pn', '1');
    url.searchParams.set('pz', '500');
    url.searchParams.set('po', '1');
    url.searchParams.set('np', '1');
    url.searchParams.set('fltt', '2');
    url.searchParams.set('invt', '2');
    url.searchParams.set('fid', 'f3');
    url.searchParams.set('fs', 'm:90+t:2+f:!50');
    url.searchParams.set('fields', 'f12,f14');
    const text = await request(url.toString(), { headers: { Referer: 'https://quote.eastmoney.com/' } });
    const json = JSON.parse(text);
    const rows = json?.data?.diff;
    if (!Array.isArray(rows) || !rows.length) throw new Error('行业板块列表为空');
    const boards = rows
      .map((r) => ({ code: String(r.f12 || ''), name: String(r.f14 || '').trim() }))
      .filter((r) => /^BK\d{4}$/.test(r.code) && r.name);
    if (!boards.length) throw new Error('行业板块列表格式错误');
    return boards;
  });
}

async function push2Industry(stockCode) {
  const secid = `${marketOf(stockCode) === 'sh' ? 1 : 0}.${stockCode}`;
  const url = new URL('https://push2.eastmoney.com/api/qt/stock/get');
  url.searchParams.set('secid', secid);
  url.searchParams.set('fltt', '2');
  url.searchParams.set('invt', '2');
  url.searchParams.set('fields', 'f57,f58,f127');
  const [text, boards] = await Promise.all([
    request(url.toString(), { headers: { Referer: 'https://quote.eastmoney.com/' } }),
    industryBoards(),
  ]);
  const json = JSON.parse(text);
  const industryName = String(json?.data?.f127 || '').trim();
  if (!industryName || industryName === '-') throw new Error(`未获取到 ${stockCode} 的当前行业`);
  const board = boards.find((b) => b.name === industryName);
  if (!board) throw new Error(`行业“${industryName}”未匹配到东方财富行业板块`);
  return { stockCode, industryName, boardCode: board.code, boardName: board.name };
}

async function f10Industry(stockCode) {
  const secuCode = `${stockCode}.${marketOf(stockCode).toUpperCase()}`;
  const url = new URL('https://datacenter.eastmoney.com/securities/api/data/v1/get');
  url.searchParams.set('reportName', 'RPT_F10_CORETHEME_BOARDTYPE');
  url.searchParams.set('columns', 'ALL');
  url.searchParams.set('filter', `(SECUCODE="${secuCode}")`);
  url.searchParams.set('pageNumber', '1');
  url.searchParams.set('pageSize', '200');
  url.searchParams.set('source', 'HSF10');
  url.searchParams.set('client', 'PC');
  const text = await request(url.toString(), { headers: { Referer: 'https://emweb.securities.eastmoney.com/' } });
  const json = JSON.parse(text);
  const rows = json?.result?.data;
  if (!Array.isArray(rows)) throw new Error(`F10 未返回 ${stockCode} 的行业数据`);
  const board = rows
    .filter((row) => row.BOARD_TYPE === '行业' && /^BK\d{4}$/.test(String(row.NEW_BOARD_CODE || '')))
    .sort((a, b) => num(a.BOARD_RANK, Number.MAX_SAFE_INTEGER) - num(b.BOARD_RANK, Number.MAX_SAFE_INTEGER))[0];
  if (!board) throw new Error(`F10 未匹配到 ${stockCode} 的行业板块`);
  const industryName = String(board.NEW_BOARD_NAME || board.BOARD_NAME || '').trim();
  if (!industryName) throw new Error(`F10 返回的 ${stockCode} 行业名称为空`);
  return {
    stockCode,
    industryName,
    boardCode: String(board.NEW_BOARD_CODE),
    boardName: industryName,
  };
}

async function f10IndustryRows(stockCode) {
  const secuCode = `${stockCode}.${marketOf(stockCode).toUpperCase()}`;
  const url = new URL('https://datacenter.eastmoney.com/securities/api/data/v1/get');
  url.searchParams.set('reportName', 'RPT_F10_CORETHEME_BOARDTYPE');
  url.searchParams.set('columns', 'ALL');
  url.searchParams.set('filter', `(SECUCODE="${secuCode}")`);
  url.searchParams.set('pageNumber', '1');
  url.searchParams.set('pageSize', '200');
  url.searchParams.set('source', 'HSF10');
  url.searchParams.set('client', 'PC');
  const text = await request(url.toString(), {
    headers: { Referer: 'https://emweb.securities.eastmoney.com/' },
  });
  const json = JSON.parse(text);
  const rows = json?.result?.data;
  if (!Array.isArray(rows)) throw new Error(`F10 未返回 ${stockCode} 的行业数据`);
  return rows
    .filter((row) => row.BOARD_TYPE === '行业')
    .map((row) => ({
      name: String(row.NEW_BOARD_NAME || row.BOARD_NAME || '').trim(),
      rank: num(row.BOARD_RANK, 0),
    }))
    .filter((row) => row.name)
    .sort((a, b) => b.rank - a.rank);
}

/** 用东财 F10 的细分行业名称匹配同花顺行业板块 */
async function thsIndustry(stockCode) {
  const [boards, rows] = await Promise.all([thsBoards(), f10IndustryRows(stockCode)]);
  if (!rows.length) throw new Error(`F10 未返回 ${stockCode} 的行业数据`);
  for (const row of rows) {
    const key = stripIndustryLevel(row.name);
    const boardCode = boards.get(key);
    if (boardCode) {
      return { stockCode, industryName: row.name, boardCode, boardName: key, source: '同花顺' };
    }
  }
  for (const row of rows) {
    const key = stripIndustryLevel(row.name);
    let hit = null;
    for (const [name, code] of boards) {
      if (name.length < 3) continue;
      if (!key.startsWith(name) && !name.startsWith(key)) continue;
      if (!hit || name.length > hit.name.length) hit = { name, code };
    }
    if (hit) {
      return {
        stockCode,
        industryName: row.name,
        boardCode: hit.code,
        boardName: hit.name,
        source: '同花顺',
      };
    }
  }
  throw new Error(`未匹配到 ${stockCode} 的同花顺行业板块`);
}

async function stockIndustry(code) {
  const stockCode = normalizedStockCode(code);
  const secid = `${marketOf(stockCode) === 'sh' ? 1 : 0}.${stockCode}`;
  return cache.get(`eastmoney:industry:${secid}`, INDUSTRY_TTL, async () => {
    try {
      return await thsIndustry(stockCode);
    } catch (thsError) {
      try {
        return { ...(await push2Industry(stockCode)), source: '东方财富' };
      } catch (primaryError) {
        try {
          return { ...(await f10Industry(stockCode)), source: '东方财富 F10' };
        } catch (fallbackError) {
          throw new Error(
            `同花顺匹配失败：${thsError.message}；东财主链路失败：${primaryError.message}；F10 回退失败：${fallbackError.message}`,
          );
        }
      }
    }
  });
}

async function sectorSnapshot(boardCode) {
  const code = normalizedBoardCode(boardCode);
  if (/^881\d{3}$/.test(code)) {
    return cache.get(`ths:sector-snapshot:${code}`, 30_000, async () => {
      const text = await request(`https://d.10jqka.com.cn/v6/realhead/bk_${code}/last.js`, {
        headers: { Referer: 'https://stockpage.10jqka.com.cn/' },
        timeout: 12_000,
      });
      const items = parseJsonp(text)?.items;
      if (!items || !items.name) throw new Error(`无 ${code} 板块快照`);
      const changePct = num(items['199112'], NaN);
      if (!Number.isFinite(changePct)) throw new Error(`${code} 板块涨跌幅缺失`);
      const rawTime = String(items.updateTime || '').trim();
      const time = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(rawTime)
        ? new Date(`${rawTime.replace(' ', 'T')}+08:00`).toISOString()
        : new Date().toISOString();
      return {
        code,
        name: String(items.name),
        changePct,
        upCount: num(items['37']),
        downCount: num(items['38']),
        time,
      };
    });
  }
  return cache.get(`eastmoney:sector-snapshot:${code}`, 30_000, async () => {
    const url = new URL('https://push2.eastmoney.com/api/qt/stock/get');
    url.searchParams.set('secid', `90.${code}`);
    url.searchParams.set('fltt', '2');
    url.searchParams.set('invt', '2');
    url.searchParams.set('fields', 'f57,f58,f170,f104,f105,f124');
    const text = await request(url.toString(), { headers: { Referer: 'https://quote.eastmoney.com/' } });
    const json = JSON.parse(text);
    const data = json?.data;
    if (!data || !data.f57 || !data.f58) throw new Error(`无 ${code} 板块快照`);
    const fields = [data.f170, data.f104, data.f105];
    if (fields.some((v) => v == null || v === '-' || !Number.isFinite(Number(v)))) {
      throw new Error(`${code} 板块快照字段缺失`);
    }
    const timestamp = Number(data.f124);
    return {
      code: String(data.f57),
      name: String(data.f58),
      changePct: num(data.f170),
      upCount: num(data.f104),
      downCount: num(data.f105),
      time:
        Number.isFinite(timestamp) && timestamp > 0
          ? new Date(timestamp * 1000).toISOString()
          : new Date().toISOString(),
    };
  });
}

async function sectorKline(boardCode, { count = 500 } = {}) {
  const code = normalizedBoardCode(boardCode);
  const limit = Math.max(1, Math.min(1000, Math.trunc(num(count, 500))));
  if (/^881\d{3}$/.test(code)) {
    return cache.get(`ths:sector-kline:${code}`, 5 * 60_000, async () => {
      const text = await request(`https://d.10jqka.com.cn/v6/line/bk_${code}/01/last.js`, {
        headers: { Referer: 'https://stockpage.10jqka.com.cn/' },
        timeout: 12_000,
      });
      const json = parseJsonp(text);
      const rows = String(json?.data || '').split(';').filter(Boolean);
      if (!rows.length) throw new Error(`无 ${code} 板块日 K 数据`);
      return rows.map((row) => {
        const b = String(row).split(',');
        const raw = String(b[0] || '').trim();
        return {
          date: /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw,
          open: num(b[1]),
          high: num(b[2]),
          low: num(b[3]),
          close: num(b[4]),
          volume: num(b[5]),
        };
      });
    });
  }
  return cache.get(`eastmoney:sector-kline:${code}:${limit}`, 5 * 60_000, async () => {
    const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
    url.searchParams.set('secid', `90.${code}`);
    url.searchParams.set('klt', '101');
    url.searchParams.set('fqt', '1');
    url.searchParams.set('lmt', String(limit));
    url.searchParams.set('end', '20500101');
    url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6');
    url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56');
    const text = await request(url.toString(), { headers: { Referer: 'https://quote.eastmoney.com/' } });
    const json = JSON.parse(text);
    const rows = json?.data?.klines;
    if (!Array.isArray(rows) || !rows.length) throw new Error(`无 ${code} 板块日 K 数据`);
    return rows.map((row) => {
      const b = String(row).split(',');
      return {
        date: b[0],
        open: num(b[1]),
        close: num(b[2]),
        high: num(b[3]),
        low: num(b[4]),
        volume: num(b[5]) * 100, // 手 -> 股
      };
    });
  });
}

module.exports = {
  sinaList,
  sinaUniverse,
  quotes,
  kline,
  intraday,
  MIN_INTRADAY_BARS,
  fundamentals,
  search,
  stockIndustry,
  sectorSnapshot,
  sectorKline,
  latestReportDate,
  prefixed,
  marketOf,
};
