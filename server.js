'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ds = require('./lib/datasource');
const quant = require('./lib/quant');
const strategies = require('./lib/strategies');
const advisor = require('./lib/advisor');
const intraday = require('./lib/intraday');

const PORT = Number(process.env.PORT) || 8000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const INDEXES = [
  { symbol: 'sh000001', name: '上证指数', short: '上证' },
  { symbol: 'sz399001', name: '深证成指', short: '深成' },
  { symbol: 'sz399006', name: '创业板指', short: '创业板' },
  { symbol: 'sh000300', name: '沪深300', short: '沪深300' },
  { symbol: 'sh000905', name: '中证500', short: '中证500' },
  { symbol: 'sh000688', name: '科创50', short: '科创50' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fail(res, status, message) {
  sendJson(res, status, { ok: false, error: message });
}

/* ---------------------------- 行情总览 ---------------------------- */

let overviewCache = { time: 0, data: null };

async function buildOverview() {
  const [indexQuotes, gainers, losers, actives, turnover] = await Promise.all([
    ds.quotes(INDEXES.map((i) => i.symbol)),
    ds.sinaList({ page: 1, size: 12, sort: 'changepercent', asc: 0 }),
    ds.sinaList({ page: 1, size: 12, sort: 'changepercent', asc: 1 }),
    ds.sinaList({ page: 1, size: 12, sort: 'amount', asc: 0 }),
    ds.sinaList({ page: 1, size: 12, sort: 'turnoverratio', asc: 0 }),
  ]);

  const qmap = new Map(indexQuotes.map((q) => [q.symbol, q]));
  const indices = INDEXES.map((meta) => {
    const q = qmap.get(meta.symbol) || {};
    return {
      symbol: meta.symbol,
      name: meta.name,
      short: meta.short,
      price: q.price || 0,
      changePct: q.changePct || 0,
      change: q.change || 0,
      amount: q.amount || 0,
      volume: q.volume || 0,
      time: q.time || '',
    };
  });

  const sparks = await Promise.all(
    INDEXES.slice(0, 4).map(async (meta) => {
      try {
        const bars = await ds.kline(meta.symbol, { period: 'day', count: 60, adjust: 'none' });
        return { symbol: meta.symbol, points: bars.map((b) => b.close) };
      } catch {
        return { symbol: meta.symbol, points: [] };
      }
    }),
  );

  const turnoverTotal = indices
    .filter((i) => i.symbol === 'sh000001' || i.symbol === 'sz399001')
    .reduce((a, b) => a + b.amount, 0);

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    indices,
    sparks,
    turnoverTotal,
    boards: {
      gainers: gainers.slice(0, 10),
      losers: losers.slice(0, 10),
      actives: actives.slice(0, 10),
      turnover: turnover.slice(0, 10),
    },
    source: '腾讯财经 · 新浪财经',
  };
}

async function overview() {
  const now = Date.now();
  if (overviewCache.data && now - overviewCache.time < 20_000) return overviewCache.data;
  try {
    const data = await buildOverview();
    overviewCache = { time: now, data };
    return data;
  } catch (err) {
    if (overviewCache.data) return { ...overviewCache.data, stale: true };
    throw err;
  }
}

/* ---------------------------- 股票详情 ---------------------------- */

async function stockDetail(code, period = 'day', count = 320) {
  const clean = String(code || '').replace(/[^0-9]/g, '').slice(0, 6);
  if (clean.length !== 6) throw new Error('股票代码需为 6 位数字');

  const [quoteList, bars, fund] = await Promise.all([
    ds.quotes([clean]).catch(() => []),
    ds.kline(clean, { period, count: Math.min(520, Math.max(80, count)) }),
    ds.fundamentals().catch(() => ({ map: {}, reportDate: null })),
  ]);

  const quote = quoteList[0] || null;
  const series = quant.buildSeries(bars);
  const tech = quant.technicalProfile(bars.slice(-150));

  return {
    ok: true,
    code: clean,
    name: quote?.name || '',
    quote,
    fundamentals: fund.map[clean] || null,
    reportDate: fund.reportDate,
    period,
    series,
    technical: tech,
    strategies: quant.STRATEGIES,
    updatedAt: new Date().toISOString(),
  };
}

/* ---------------------------- 静态资源 ---------------------------- */

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) return fail(res, 403, 'forbidden');

  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) return serveStatic(req, res, `${rel.replace(/\/$/, '')}/index.html`);

    const ext = path.extname(target).toLowerCase();
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    const isHtml = ext === '.html';
    const noCache = isHtml || ext === '.js' || ext === '.css';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      ETag: etag,
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  } catch {
    return fail(res, 404, 'not found');
  }
}

/* ---------------------------- 路由 ---------------------------- */

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });

  try {
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
      return await serveStatic(req, res, pathname);
    }

    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, uptime: process.uptime(), node: process.version });
    }

    if (pathname === '/api/overview' && req.method === 'GET') {
      return sendJson(res, 200, await overview());
    }

    if (pathname === '/api/quotes' && req.method === 'GET') {
      const codes = url.searchParams.get('codes');
      if (codes) {
        const items = await ds.quotes(codes.split(',').map((c) => c.trim()).filter(Boolean).slice(0, 40));
        return sendJson(res, 200, { ok: true, items });
      }
      const rows = await ds.sinaList({
        page: Number(url.searchParams.get('page')) || 1,
        size: Math.min(100, Number(url.searchParams.get('size')) || 50),
        sort: url.searchParams.get('sort') || 'changepercent',
        asc: url.searchParams.get('asc') === '1' ? 1 : 0,
        node: url.searchParams.get('node') || 'hs_a',
      });
      return sendJson(res, 200, { ok: true, items: rows });
    }

    if (pathname === '/api/kline' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      const period = url.searchParams.get('period') || 'day';
      const count = Number(url.searchParams.get('count')) || 250;
      const bars = await ds.kline(code, { period, count: Math.min(520, count) });
      return sendJson(res, 200, { ok: true, code, period, series: quant.buildSeries(bars) });
    }

    if (pathname === '/api/stock' && req.method === 'GET') {
      const detail = await stockDetail(
        url.searchParams.get('code'),
        url.searchParams.get('period') || 'day',
        Number(url.searchParams.get('count')) || 320,
      );
      return sendJson(res, 200, detail);
    }

    if (pathname === '/api/search' && req.method === 'GET') {
      const items = await ds.search(url.searchParams.get('q'));
      return sendJson(res, 200, { ok: true, items });
    }

    if (pathname === '/api/fundamentals' && req.method === 'GET') {
      const fund = await ds.fundamentals();
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const size = Math.min(100, Number(url.searchParams.get('size')) || 30);
      const sortKey = url.searchParams.get('sort') || 'roe';
      const list = Object.entries(fund.map).map(([code, f]) => ({ code, ...f }));
      list.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
      return sendJson(res, 200, {
        ok: true,
        reportDate: fund.reportDate,
        total: list.length,
        items: list.slice((page - 1) * size, page * size),
      });
    }

    if (pathname === '/api/screen' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, await quant.screen(body));
    }

    if (pathname === '/api/screen/meta' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        factors: quant.FACTORS,
        boards: quant.BOARDS,
        defaults: quant.DEFAULT_FILTERS,
        strategies: strategies.list(),
        defaultStrategy: strategies.DEFAULT_STRATEGY,
      });
    }

    if (pathname === '/api/strategies' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        defaultStrategy: strategies.DEFAULT_STRATEGY,
        items: strategies.list(),
      });
    }

    if (pathname === '/api/recommend' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, await quant.recommend(body));
    }

    if (pathname === '/api/picks' && req.method === 'GET') {
      const optionalNumber = (key) => {
        const raw = url.searchParams.get(key);
        return raw == null || raw === '' ? undefined : Number(raw);
      };
      const result = await quant.picks({
        limit: Number(url.searchParams.get('limit')) || 20,
        scanCount: Number(url.searchParams.get('scanCount')) || 600,
        candidates: Number(url.searchParams.get('candidates')) || 90,
        force: url.searchParams.get('refresh') === '1',
        filters: {
          minPrice: optionalNumber('minPrice'),
          maxPrice: optionalNumber('maxPrice'),
          minMarketCap: optionalNumber('minMarketCap'),
          maxMarketCap: optionalNumber('maxMarketCap'),
        },
      });
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/signals' && req.method === 'GET') {
      const optionalNumber = (key) => {
        const raw = url.searchParams.get(key);
        return raw == null || raw === '' ? undefined : Number(raw);
      };
      const result = await quant.signalBoard({
        limit: Number(url.searchParams.get('limit')) || 10,
        scanCount: Number(url.searchParams.get('scanCount')) || 600,
        candidates: Number(url.searchParams.get('candidates')) || 90,
        force: url.searchParams.get('refresh') === '1',
        filters: {
          minPrice: optionalNumber('minPrice'),
          maxPrice: optionalNumber('maxPrice'),
          minMarketCap: optionalNumber('minMarketCap'),
          maxMarketCap: optionalNumber('maxMarketCap'),
        },
      });
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/stock/advice' && req.method === 'GET') {
      const result = await advisor.strategyAdvice(
        url.searchParams.get('code'),
        { days: Number(url.searchParams.get('days')) || 400 },
      );
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/intraday' && req.method === 'GET') {
      const code = String(url.searchParams.get('code') || '').replace(/\D/g, '').slice(0, 6);
      if (code.length !== 6) return fail(res, 400, '股票代码需为 6 位数字');
      return sendJson(res, 200, await intraday.analyze(code));
    }

    if (pathname === '/api/portfolio/diagnose' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await advisor.diagnose(body.holdings);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/backtest' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      const days = url.searchParams.get('days') || undefined;
      const capital = Number(url.searchParams.get('capital')) || 1_000_000;
      return sendJson(res, 200, await quant.compositeBacktest(code, { days, capital }));
    }

    if (pathname === '/api/metrics' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        uptime: process.uptime(),
        memoryMB: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
        node: process.version,
      });
    }

    return fail(res, 404, '接口不存在');
  } catch (err) {
    const message = err && err.message ? err.message : '服务内部错误';
    const status = /请求体|代码需|不支持|回测交易日/.test(message) ? 400 : 502;
    if (status === 502) console.error('[api]', pathname, message);
    return fail(res, status, message);
  }
});

server.keepAliveTimeout = 30_000;
server.headersTimeout = 35_000;

server.listen(PORT, HOST, () => {
  console.log(`[money] A-share quant terminal listening on http://${HOST}:${PORT}`);
  setTimeout(upstreamSelfTest, 600);
});

/** 启动时探测上游数据源连通性，便于线上排障 */
async function upstreamSelfTest() {
  const checks = [
    ['腾讯行情', () => ds.quotes(['sh000001'])],
    ['新浪行情', () => ds.sinaList({ page: 1, size: 5 })],
    ['腾讯K线', () => ds.kline('sh600519', { count: 5 })],
    ['东方财富财报', () => ds.fundamentals()],
  ];
  for (const [name, fn] of checks) {
    const t = Date.now();
    try {
      const result = await fn();
      const size = Array.isArray(result) ? result.length : result.count ?? 'ok';
      console.log(`[selftest] ${name} ok ${Date.now() - t}ms (${size})`);
    } catch (err) {
      console.log(`[selftest] ${name} fail ${Date.now() - t}ms: ${err.message}`);
    }
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
  });
}
