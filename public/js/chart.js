const UP = '#ff4d63';
const DOWN = '#14c98a';
const GRID = 'rgba(126, 156, 196, 0.10)';
const TEXT = '#7f8ea8';
const MA_COLORS = { ma5: '#f5c542', ma10: '#3ba9ff', ma20: '#a78bfa', ma60: '#7dd3a0' };

function prepare(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(280, canvas.clientWidth || canvas.parentElement.clientWidth || 600);
  const h = cssHeight || Number(canvas.getAttribute('height')) || 360;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function fmt(v, d = 2) {
  return Number.isFinite(v) ? v.toFixed(d) : '--';
}

function text(ctx, str, x, y, { color = TEXT, size = 10, align = 'left', baseline = 'middle', weight = 400 } = {}) {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px "SF Mono", Menlo, Consolas, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(str, x, y);
}

export function drawSparkline(canvas, points, up) {
  const { ctx, w, h } = prepare(canvas, 46);
  if (!points || points.length < 2) return;
  const color = up ? UP : DOWN;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const y = (v) => h - 4 - ((v - min) / span) * (h - 12);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, up ? 'rgba(255,77,99,0.28)' : 'rgba(20,201,138,0.26)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  ctx.moveTo(0, h);
  points.forEach((p, i) => ctx.lineTo(i * step, y(p)));
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(i * step, y(p)) : ctx.moveTo(0, y(p))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

export function drawKline(canvas, series, opts = {}) {
  const { ctx, w, h } = prepare(canvas, opts.height || 440);
  const bars = series?.bars || [];
  if (!bars.length) {
    text(ctx, '暂无 K 线数据', w / 2, h / 2, { align: 'center', size: 12 });
    return null;
  }

  const showMacd = opts.showMacd !== false;
  const padL = 6;
  const padR = 62;
  const padT = 12;
  const padB = 22;
  const gap = 12;
  const totalH = h - padT - padB;
  const usable = totalH - gap * (showMacd ? 2 : 1);
  const priceH = usable * 0.64;
  const volH = usable * (showMacd ? 0.16 : 0.34);
  const macdH = showMacd ? usable * 0.2 : 0;

  const priceTop = padT;
  const priceBot = priceTop + priceH;
  const volTop = priceBot + gap;
  const volBot = volTop + volH;
  const macdTop = volBot + gap;
  const macdBot = macdTop + macdH;

  const n = bars.length;
  const plotW = w - padL - padR;
  const step = plotW / n;
  const x = (i) => padL + (i + 0.5) * step;
  const bodyW = Math.max(1.2, Math.min(9, step * 0.62));

  const lows = bars.map((b) => b.low);
  const highs = bars.map((b) => b.high);
  for (const key of Object.keys(series.ma || {})) {
    for (const v of series.ma[key]) {
      if (v != null) {
        lows.push(v);
        highs.push(v);
      }
    }
  }
  let lo = Math.min(...lows);
  let hi = Math.max(...highs);
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad;
  hi += pad;
  const yPrice = (v) => priceBot - ((v - lo) / (hi - lo)) * priceH;

  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, priceTop, plotW, priceH);
  ctx.clip();

  // 网格与价格刻度
  for (let i = 0; i <= 4; i += 1) {
    const p = lo + ((hi - lo) * i) / 4;
    const yy = yPrice(p);
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    text(ctx, fmt(p), w - padR + 7, yy, { size: 9.5 });
  }
  ctx.restore();

  // 蜡烛
  for (let i = 0; i < n; i += 1) {
    const b = bars[i];
    const isUp = b.close >= b.open;
    const color = isUp ? UP : DOWN;
    const cx = x(i);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, yPrice(b.high));
    ctx.lineTo(Math.round(cx) + 0.5, yPrice(b.low));
    ctx.stroke();
    const y1 = yPrice(Math.max(b.open, b.close));
    const y2 = yPrice(Math.min(b.open, b.close));
    const bh = Math.max(1, y2 - y1);
    ctx.fillRect(cx - bodyW / 2, y1, bodyW, bh);
  }

  // 均线
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, priceTop, plotW, priceH);
  ctx.clip();
  for (const [key, arr] of Object.entries(series.ma || {})) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i += 1) {
      const v = arr[i];
      if (v == null) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(x(i), yPrice(v));
        started = true;
      } else {
        ctx.lineTo(x(i), yPrice(v));
      }
    }
    ctx.strokeStyle = MA_COLORS[key] || TEXT;
    ctx.lineWidth = 1.1;
    ctx.globalAlpha = 0.9;
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  // 成交量
  const maxVol = Math.max(...bars.map((b) => b.volume)) || 1;
  ctx.strokeStyle = GRID;
  ctx.beginPath();
  ctx.moveTo(padL, volBot);
  ctx.lineTo(w - padR, volBot);
  ctx.stroke();
  for (let i = 0; i < n; i += 1) {
    const b = bars[i];
    const vh = (b.volume / maxVol) * (volH - 4);
    ctx.fillStyle = b.close >= b.open ? 'rgba(255,77,99,0.5)' : 'rgba(20,201,138,0.5)';
    ctx.fillRect(x(i) - bodyW / 2, volBot - vh, bodyW, vh);
  }
  text(ctx, 'VOL', padL + 2, volTop + 7, { size: 9 });

  // MACD
  if (showMacd) {
    const { dif, dea, hist } = series.macd || { dif: [], dea: [], hist: [] };
    const vals = [...dif, ...dea, ...hist].filter((v) => v != null);
    const m = Math.max(...vals.map(Math.abs), 0.01);
    const zero = macdTop + macdH / 2;
    const yM = (v) => zero - (v / m) * (macdH / 2 - 2);
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(padL, zero);
    ctx.lineTo(w - padR, zero);
    ctx.stroke();
    for (let i = 0; i < n; i += 1) {
      const v = hist[i];
      if (v == null) continue;
      ctx.fillStyle = v >= 0 ? 'rgba(255,77,99,0.55)' : 'rgba(20,201,138,0.55)';
      const y1 = yM(v);
      ctx.fillRect(x(i) - bodyW / 2, Math.min(y1, zero), bodyW, Math.max(1, Math.abs(y1 - zero)));
    }
    const line = (arr, color) => {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i += 1) {
        const v = arr[i];
        if (v == null) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(x(i), yM(v));
          started = true;
        } else ctx.lineTo(x(i), yM(v));
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    line(dif, '#f5c542');
    line(dea, '#3ba9ff');
    text(ctx, 'MACD', padL + 2, macdTop + 7, { size: 9 });
  }

  // 时间轴
  const labelCount = w < 600 ? 4 : 6;
  for (let i = 0; i < labelCount; i += 1) {
    const idx = Math.round((i / (labelCount - 1)) * (n - 1));
    const d = bars[idx].date.slice(2);
    text(ctx, d, x(idx), h - padB / 2 + 2, { align: 'center', size: 9 });
  }

  const layout = { padL, padR, step, n, priceTop, priceBot, volTop, volBot, macdTop, macdBot, w, h, lo, hi };
  layout.indexFromX = (px) => Math.max(0, Math.min(n - 1, Math.floor((px - padL) / step)));

  // 十字光标
  if (opts.hoverIndex != null && opts.mouseY != null) {
    const i = opts.hoverIndex;
    const cx = x(i);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(180, 205, 235, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, priceTop);
    ctx.lineTo(cx, macdBot);
    ctx.stroke();
    const b = bars[i];
    const my = Math.max(priceTop, Math.min(priceBot, opts.mouseY));
    ctx.beginPath();
    ctx.moveTo(padL, my);
    ctx.lineTo(w - padR, my);
    ctx.stroke();
    ctx.restore();

    const price = lo + ((priceBot - my) / priceH) * (hi - lo);
    const label = fmt(price);
    ctx.fillStyle = '#243146';
    const tw = 52;
    ctx.fillRect(w - padR + 2, my - 8, tw, 16);
    text(ctx, label, w - padR + 28, my, { align: 'center', color: '#e6edf9', size: 9.5 });
    void b;
  }

  return layout;
}

export function drawEquity(canvas, curve, hoverIndex = null) {
  const { ctx, w, h } = prepare(canvas, 260);
  if (!curve || curve.length < 2) {
    text(ctx, '暂无回测数据', w / 2, h / 2, { align: 'center', size: 12 });
    return null;
  }
  const padL = 6;
  const padR = 56;
  const padT = 14;
  const padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const values = curve.flatMap((p) => [p.equity, p.benchmark]);
  const lo = Math.min(...values, 0.98);
  const hi = Math.max(...values, 1.02);
  const span = hi - lo || 1;
  const x = (i) => padL + (i / (curve.length - 1)) * plotW;
  const y = (v) => padT + plotH - ((v - lo) / span) * plotH;

  for (let i = 0; i <= 4; i += 1) {
    const v = lo + (span * i) / 4;
    const yy = y(v);
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    text(ctx, `${(v * 100).toFixed(0)}%`, w - padR + 7, yy, { size: 9.5 });
  }

  const baseY = y(1);
  ctx.strokeStyle = 'rgba(160, 180, 210, 0.3)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padL, baseY);
  ctx.lineTo(w - padR, baseY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 基准
  ctx.beginPath();
  curve.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.benchmark)) : ctx.moveTo(x(i), y(p.benchmark))));
  ctx.strokeStyle = '#5c6c85';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // 策略净值
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, 'rgba(255,181,71,0.26)');
  grad.addColorStop(1, 'rgba(255,181,71,0)');
  ctx.beginPath();
  ctx.moveTo(padL, padT + plotH);
  curve.forEach((p, i) => ctx.lineTo(x(i), y(p.equity)));
  ctx.lineTo(w - padR, padT + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  curve.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.equity)) : ctx.moveTo(x(i), y(p.equity))));
  ctx.strokeStyle = '#ffb547';
  ctx.lineWidth = 1.8;
  ctx.stroke();

  const labelCount = w < 600 ? 4 : 6;
  for (let i = 0; i < labelCount; i += 1) {
    const idx = Math.round((i / (labelCount - 1)) * (curve.length - 1));
    text(ctx, curve[idx].date.slice(2), x(idx), h - padB / 2 + 2, { align: 'center', size: 9 });
  }

  if (hoverIndex != null && curve[hoverIndex]) {
    const cx = x(hoverIndex);
    ctx.strokeStyle = 'rgba(180, 205, 235, 0.4)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, padT);
    ctx.lineTo(cx, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  return { x, y, padL, padR, w, indexFromX: (px) => Math.max(0, Math.min(curve.length - 1, Math.round(((px - padL) / plotW) * (curve.length - 1)))) };
}
