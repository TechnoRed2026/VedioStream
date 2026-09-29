// لایه‌ی کش مقاوم در برابر قطعی اینترنت — با بافر محدود
// - فقط حدود ۴۰ تا ۵۰ ثانیه جلوتر از جای پخش دانلود می‌شود، نه کل فایل
//     · سرور حداکثر PLAYER_AHEAD ثانیه جلوتر از جای پخش به مرورگر می‌فرستد
//       (صفحه هر ثانیه جای پخش را گزارش می‌دهد؛ سرور خودش می‌داند تا کجا فرستاده)
//     · کش روی دیسک حداکثر CACHE_AHEAD ثانیه جلوتر از جایی که پخش‌کننده خوانده دانلود می‌کند
//     · وقتی پخش متوقف (pause) است، دانلود هم می‌ایستد
// - اگر اینترنت قطع شود، پخش از قسمت دانلودشده ادامه پیدا می‌کند
// - درخواست‌ها به‌جای خطا دادن منتظر می‌مانند و دانلود هر چند ثانیه دوباره امتحان می‌شود
// - با وصل شدن اینترنت، دانلود از همان بایتی که مانده بود ادامه پیدا می‌کند
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const CACHE_DIR = process.env.CACHE_DIR || path.join(os.tmpdir(), 'stream-player-cache');
const KEEP = Number(process.env.CACHE_KEEP || 3);                 // چند فایل آخر روی دیسک بماند
const CACHE_AHEAD = Number(process.env.CACHE_AHEAD || 18);        // ثانیه‌هایی که کش جلوتر از پخش‌کننده نگه می‌دارد
const CACHE_REFILL = Number(process.env.CACHE_REFILL || 10);      // وقتی ذخیره‌ی جلو کمتر از این شد، دوباره دانلود کن
const PLAYER_AHEAD = Number(process.env.PLAYER_AHEAD || 22);      // حداکثر بافر داخل مرورگر (ثانیه)
const PLAYER_RESUME = Math.max(1, PLAYER_AHEAD - 5);             // وقتی بافر مرورگر به این رسید، ارسال ادامه پیدا می‌کند
const RETRY_MS = 4000;                                             // فاصله‌ی تلاش دوباره هنگام قطعی
const IDLE_TIMEOUT = 20000;                                        // اگر ۲۰ ثانیه داده نیامد، اتصال مرده حساب می‌شود
const TAIL = 4 * 1024 * 1024;                                      // انتهای فایل (ایندکس mkv) زودتر گرفته می‌شود
const TAIL_FREE = 16 * 1024 * 1024;                                // خواندن از این ناحیه‌ی انتهایی جای پخش حساب نمی‌شود
const NEAR = 8 * 1024 * 1024;                                      // اگر درخواست نزدیک جای دانلود است، فقط صبر کن
const JUMP = 2 * 1024 * 1024;                                      // پرش بزرگ‌تر از این = جابه‌جایی (seek)
const SETTLE_MS = 1500;                                            // بعد از جابه‌جایی کمی صبر کن تا جای جدید معلوم شود
const MIN_AHEAD = 2 * 1024 * 1024;
const PROBE_CHUNK = 2 * 1024 * 1024;                               // ffprobe فقط تکه‌ی کوچکی لازم دارد
const FALLBACK_RATE = 512 * 1024;                                  // اگر مدت فیلم معلوم نیست، ۴ مگابیت بر ثانیه فرض کن
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

fs.mkdirSync(CACHE_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(url, headers, redirects = 5) {
  return new Promise((resolve, reject) => {
    const u = typeof url === 'string' ? new URL(url) : url;
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers: { 'User-Agent': UA, ...headers } }, (res) => {
      const loc = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc && redirects > 0) {
        res.resume();
        resolve(request(new URL(loc, u), headers, redirects - 1));
      } else {
        resolve(res);
      }
    });
    req.on('error', reject);
    req.setTimeout(IDLE_TIMEOUT, () => req.destroy(new Error('timeout')));
  });
}

class Entry extends EventEmitter {
  constructor(url) {
    super();
    this.setMaxListeners(0);
    this.url = url;
    this.id = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
    this.bin = path.join(CACHE_DIR, this.id + '.bin');
    this.meta = path.join(CACHE_DIR, this.id + '.json');
    this.size = 0;
    this.duration = 0;         // مدت فیلم (از ffprobe یا مرورگر) برای تبدیل ثانیه به بایت
    this.ranges = [];          // بازه‌های دانلودشده [start, end)
    this.online = true;
    this.lastError = '';
    this.want = null;          // بایتی که پخش‌کننده همین حالا لازم دارد و هنوز نیامده
    this.wantProbe = false;    // درخواست‌کننده ffprobe است (فقط تکه‌ی کوچک)
    this.frontier = 0;         // جایی که پخش‌کننده تا آن‌جا خوانده
    this.hasPlayer = false;    // تا پخش‌کننده چیزی نخوانده، دانلود جلوتر شروع نمی‌شود
    this.lastJump = 0;
    this.play = null;          // آخرین گزارش صفحه: { t, at, playing }
    this.stream = null;        // جریانی که الان به مرورگر می‌رود
    this.holding = false;      // ارسال به مرورگر فعلاً متوقف است چون به اندازه‌ی کافی جلوتر فرستاده شده
    this.active = null;
    this.done = false;
    this.wake = null;
    this.ready = this.init();
  }

  async init() {
    let lastErr;
    for (let i = 0; i < 4; i++) {
      try {
        const res = await request(this.url, { Range: 'bytes=0-0' });
        res.resume();
        const m = /\/(\d+)\s*$/.exec(res.headers['content-range'] || '');
        if (res.statusCode !== 206 || !m) {
          const e = new Error('سرور مبدأ از دانلود تکه‌ای (Range) پشتیبانی نمی‌کند');
          e.code = 'NORANGE';
          throw e;
        }
        this.size = Number(m[1]);
        break;
      } catch (e) {
        if (e.code === 'NORANGE') throw e;
        lastErr = e;
        this.online = false;
        await sleep(2000);
      }
    }
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(this.meta, 'utf8')); } catch {}
    if (!this.size) {
      // آفلاین هستیم؛ اگر قبلاً چیزی از این فایل دانلود شده، از همان استفاده کن
      if (saved && saved.size && fs.existsSync(this.bin)) this.size = saved.size;
      if (!this.size) throw lastErr || new Error('اتصال به سرور مبدأ ممکن نشد');
    } else {
      this.online = true;
    }

    // ادامه‌ی دانلود قبلی اگر وجود دارد
    if (saved && saved.size === this.size && fs.existsSync(this.bin)) {
      this.ranges = saved.ranges || [];
      this.duration = saved.duration || 0;
    }
    this.fd = fs.openSync(this.bin, fs.existsSync(this.bin) ? 'r+' : 'w+');
    this.loop();
    return this;
  }

  // ---------- محاسبه‌ی بازه‌ها ----------
  cachedEnd(p) {
    for (const [s, e] of this.ranges) if (s <= p && p < e) return e;
    return -1;
  }
  cachedBytes() { return this.ranges.reduce((n, [s, e]) => n + (e - s), 0); }

  addRange(s, e) {
    this.ranges.push([s, e]);
    this.ranges.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of this.ranges) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else out.push([r[0], r[1]]);
    }
    this.ranges = out;
  }

  gapFrom(p) {
    let pos = p;
    for (const [s, e] of this.ranges) {
      if (e <= pos) continue;
      if (s > pos) break;
      pos = e;
    }
    return pos < this.size ? pos : null;
  }
  nextCachedStart(p) {
    for (const [s] of this.ranges) if (s > p) return s;
    return this.size;
  }

  // ---------- محدودیت بافر ----------
  rate() { return this.duration > 0 ? this.size / this.duration : FALLBACK_RATE; }
  bytesFor(sec) { return Math.max(MIN_AHEAD, Math.round(this.rate() * sec)); }
  inTail(p) { return p >= this.size - TAIL_FREE; }

  setDuration(d) {
    d = Number(d);
    if (d > 0 && Math.abs(d - this.duration) > 0.5) { this.duration = d; this.saveSoon(); }
  }

  // پخش‌کننده (مرورگر یا ffmpeg) الان بایت p را می‌خواند
  setFrontier(p) {
    if (this.inTail(p)) return;
    if (!this.hasPlayer || Math.abs(p - this.frontier) > JUMP) {
      this.lastJump = Date.now();
      // دانلودِ جلوتری که برای جای قبلی بود دیگر لازم نیست
      if (this.hasPlayer && this.active && this.active.kind === 'fill') this.active.abort();
    }
    this.hasPlayer = true;
    this.frontier = p;
  }

  // ---------- محدود کردن ارسال به مرورگر ----------
  // مقدار «جلوتر» = زمانِ آخرین داده‌ی فرستاده‌شده − جای فعلی پخش
  //   پخش مستقیم: زمان از روی بایت تخمین زده می‌شود (نسبت به نقطه‌ی شروع همین درخواست)
  //   تبدیل هم‌زمان: زمان دقیق از خروجی progress خود ffmpeg می‌آید

  // گزارش صفحه: t = currentTime ویدیو، playing = در حال پخش است یا نه
  report({ t, playing, duration } = {}) {
    if (duration) this.setDuration(duration);
    if (t == null || !isFinite(t)) return;
    const now = Date.now();
    this.play = { t: Number(t), at: now, playing: !!playing };
    const st = this.stream;
    // اولین گزارش‌های بعد از شروع یک درخواست مستقیم، زمانِ نقطه‌ی شروع آن را مشخص می‌کنند
    if (st && st.kind === 'direct' && !st.locked && now - st.t0 < 2500) st.anchorTime = Number(t);
    this.emit('report');
  }

  playNow() {
    const p = this.play;
    if (!p) return this.stream ? this.stream.anchorTime ?? 0 : 0;
    return p.t + (p.playing ? (Date.now() - p.at) / 1000 : 0);
  }

  startStream(kind, anchorByte = 0) {
    const prev = this.stream;
    const st = { kind, t0: Date.now(), anchorByte, pos: anchorByte, anchorTime: null, locked: false, outTime: 0, bytesSince: 0 };
    // درخواست تازه‌ای که دقیقاً از جای درخواست قبلی ادامه می‌دهد جابه‌جایی نیست؛ زمانش را از قبلی بگیر
    if (kind === 'direct' && prev && prev.kind === 'direct' && Math.abs(anchorByte - prev.pos) < JUMP) {
      st.anchorTime = this.sentTime() + (anchorByte - prev.pos) / this.rate();
      st.locked = true;
      this.stream = st;
      this.emit('report');
      return st;
    }
    this.stream = st;
    this.holding = false;
    // تا صفحه گزارش بدهد، فرض کن پخش از همین حالا شروع شده
    this.play = { t: kind === 'transcode' ? 0 : anchorByte / this.rate(), at: Date.now(), playing: true };
    this.emit('report');
    return st;
  }

  sentTime() {
    const st = this.stream;
    if (!st) return 0;
    // گزارش ffmpeg هر نیم ثانیه می‌آید؛ بین دو گزارش، بایت‌های فرستاده‌شده هم حساب می‌شوند
    if (st.kind === 'transcode') return st.outTime + st.bytesSince / this.rate();
    const base = st.anchorTime ?? st.anchorByte / this.rate();
    return base + (st.pos - st.anchorByte) / this.rate();
  }

  // چند ثانیه جلوتر از جای پخش فرستاده شده (حداقلِ آنچه مرورگر در دست دارد)
  sentAhead() { return this.stream ? Math.max(0, this.sentTime() - this.playNow()) : 0; }

  shouldHold() {
    const a = this.sentAhead();
    if (a >= PLAYER_AHEAD) this.holding = true;
    else if (a <= PLAYER_RESUME) this.holding = false;
    return this.holding;
  }

  waitReport(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.off('report', done); resolve(); };
      const t = setTimeout(done, ms);
      this.on('report', done);
    });
  }

  // ثانیه‌هایی که از جای پخش‌کننده به بعد روی دیسک آماده است
  aheadSeconds() {
    const g = this.gapFrom(this.frontier);
    const end = g == null ? this.size : g;
    return Math.max(0, (end - this.frontier) / this.rate());
  }

  // پخش‌کننده بایت p را لازم دارد
  need(p, probe = false) {
    const a = this.active;
    if (a && p >= a.pos && p - a.pos < NEAR && p <= a.end) return;
    if (this.want === p) return;
    this.want = p;
    this.wantProbe = probe;
    if (a) a.abort();
    if (this.wake) this.wake();
  }

  waitData(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.off('data', done); resolve(); };
      const t = setTimeout(done, ms);
      this.on('data', done);
    });
  }

  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.writeFileSync(this.meta, JSON.stringify({ url: this.url, size: this.size, duration: this.duration, ranges: this.ranges }));
      } catch {}
    }, 2000);
  }

  // تصمیم می‌گیرد الان چه قسمتی دانلود شود (یا هیچ)
  nextJob() {
    // ۱) چیزی که پخش‌کننده همین حالا منتظرش است
    if (this.want != null) {
      const w = this.want;
      this.want = null;
      const s = this.gapFrom(w);
      if (s != null) {
        const end = this.wantProbe
          ? Math.min(this.nextCachedStart(s), s + PROBE_CHUNK, this.size) - 1
          : this.capEnd(s, w);
        return { kind: 'need', start: s, end };
      }
    }
    // ۲) انتهای فایل (ایندکس mkv / moov در mp4) — کوچک است
    const t = this.gapFrom(Math.max(0, this.size - TAIL));
    if (t != null) return { kind: 'tail', start: t, end: this.nextCachedStart(t) - 1 };

    // ۳) پر کردن ذخیره‌ی جلوی پخش‌کننده، فقط تا سقف CACHE_AHEAD ثانیه
    if (!this.hasPlayer || Date.now() - this.lastJump < SETTLE_MS) return null;
    const s = this.gapFrom(this.frontier);
    if (s == null) return null;
    if (s >= this.frontier + this.bytesFor(CACHE_REFILL)) return null;   // هنوز ذخیره کافی است
    return { kind: 'fill', start: s, end: this.capEnd(s, this.frontier) };
  }

  capEnd(s, base) {
    let end = this.nextCachedStart(s) - 1;
    if (!this.inTail(s)) end = Math.min(end, Math.max(s + MIN_AHEAD, base + this.bytesFor(CACHE_AHEAD)) - 1);
    return Math.max(s, Math.min(end, this.size - 1));
  }

  idle(ms) {
    return new Promise((r) => {
      const t = setTimeout(() => { this.wake = null; r(); }, ms);
      this.wake = () => { clearTimeout(t); this.wake = null; r(); };
    });
  }

  async loop() {
    while (!this.done) {
      if (this.gapFrom(0) == null) {
        this.done = true;
        this.saveSoon();
        this.emit('data');
        console.log(`[cache] کل فایل روی دیسک است: ${this.id}`);
        break;
      }
      const job = this.nextJob();
      if (!job) { await this.idle(1000); continue; }
      if (process.env.CACHE_DEBUG) console.log('[job]', job.kind, (job.start/1e6).toFixed(1), '-', (job.end/1e6).toFixed(1), 'MB  frontier', (this.frontier/1e6).toFixed(1));
      const result = await this.fetchRange(job);
      if (result === 'error') {
        if (this.online) console.log(`[cache] اتصال قطع شد (${this.lastError}) — هر ${RETRY_MS / 1000} ثانیه دوباره تلاش می‌کنم...`);
        this.online = false;
        this.emit('status');
        if (job.kind === 'need' && this.want == null) this.want = job.start;   // بعد از وصل شدن همین را بگیر
        await this.idle(RETRY_MS);
      }
    }
  }

  fetchRange({ kind, start, end }) {
    return new Promise((resolve) => {
      let pos = start, settled = false, aborted = false;
      const finish = (r) => { if (!settled) { settled = true; this.active = null; resolve(r); } };
      this.active = { kind, pos, end, abort: () => { aborted = true; } };

      request(this.url, { Range: `bytes=${start}-${end}` }).then((res) => {
        if (res.statusCode !== 206) {
          res.resume();
          this.lastError = 'HTTP ' + res.statusCode;
          return finish('error');
        }
        if (!this.online) console.log('[cache] اینترنت برگشت؛ دانلود ادامه پیدا کرد.');
        this.online = true;
        this.emit('status');
        if (this.active) this.active.abort = () => { aborted = true; res.destroy(); };
        if (aborted) { res.destroy(); return finish('abort'); }

        res.on('data', (chunk) => {
          fs.writeSync(this.fd, chunk, 0, chunk.length, pos);
          this.addRange(pos, pos + chunk.length);
          pos += chunk.length;
          if (this.active) this.active.pos = pos;
          this.emit('data');
          this.saveSoon();
        });
        res.on('error', (e) => { this.lastError = e.message; });
        res.on('close', () => {
          if (aborted) return finish('abort');
          if (pos > end) return finish('ok');
          this.lastError = this.lastError || 'connection closed';
          finish('error');
        });
      }).catch((e) => {
        this.lastError = e.code || e.message;
        finish(aborted ? 'abort' : 'error');
      });
    });
  }

  status() {
    const size = this.size || 1;
    return {
      size: this.size,
      cached: this.cachedBytes(),
      percent: Math.floor((this.cachedBytes() / size) * 1000) / 10,
      online: this.online,
      done: this.done,
      downloading: !!this.active,
      aheadSec: Math.round(this.aheadSeconds() * 10) / 10,     // روی دیسک، جلوتر از جایی که پخش‌کننده خوانده
      sentSec: Math.round(this.sentAhead() * 10) / 10,         // فرستاده‌شده به مرورگر، جلوتر از جای پخش
      holding: this.holding,
      limits: { player: PLAYER_AHEAD, cache: CACHE_AHEAD },
      ranges: this.ranges.slice(0, 200).map(([s, e]) => [s / size, e / size]),
    };
  }
}

const entries = new Map();

function prune(keepId) {
  try {
    const files = fs.readdirSync(CACHE_DIR)
      .filter((f) => f.endsWith('.bin'))
      .map((f) => ({ id: f.slice(0, -4), t: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    const active = new Set([...entries.values()].map((e) => e.id).concat(keepId));
    files.slice(KEEP).forEach(({ id }) => {
      if (active.has(id)) return;
      for (const ext of ['.bin', '.json']) try { fs.unlinkSync(path.join(CACHE_DIR, id + ext)); } catch {}
    });
  } catch {}
}

async function get(url) {
  let e = entries.get(url);
  if (!e) {
    e = new Entry(url);
    entries.set(url, e);
    prune(e.id);
  }
  try {
    await e.ready;
    return e;
  } catch (err) {
    entries.delete(url);
    throw err;
  }
}

function byId(id) {
  for (const e of entries.values()) if (e.id === id) return e;
  return null;
}

// سرو کردن فایل از کش با پشتیبانی Range؛ اگر داده هنوز نرسیده، منتظر می‌ماند (خطا نمی‌دهد)
//   opts.player   : این خواننده پخش‌کننده است (مرورگر یا ffmpeg)، نه ffprobe
//   opts.throttle : اگر بافر مرورگر پر است، ارسال را نگه دار (فقط برای پخش مستقیم)
async function serve(entry, req, res, contentType, opts = {}) {
  const size = entry.size;

  let start = 0, end = size - 1, status = 200;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    status = 206;
    if (m[1] === '') start = Math.max(0, size - Number(m[2]));
    else {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
    }
  }
  if (start >= size || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  const headers = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Cache-Control': 'no-store',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);

  let closed = false, wake = null;
  const onClose = () => { closed = true; if (wake) wake(); };
  req.once('close', onClose);
  res.once('close', onClose);
  res.on('drain', () => { if (wake) wake(); });

  // درخواست تازه‌ی مرورگر (شروع یا جابه‌جایی): شمارش بافر از نو؛ خواندن ایندکس انتهای فایل حساب نمی‌شود
  let stream = null;
  if (opts.throttle && !entry.inTail(start)) stream = entry.startStream('direct', start);

  let pos = start;
  while (pos <= end && !closed) {
    if (stream && entry.stream === stream && entry.shouldHold()) {
      await entry.waitReport(1000);
      continue;
    }
    if (opts.player) entry.setFrontier(pos);
    const avail = entry.cachedEnd(pos);
    if (avail > pos) {
      const n = Math.min(256 * 1024, avail - pos, end + 1 - pos);
      const buf = Buffer.allocUnsafe(n);
      fs.readSync(entry.fd, buf, 0, n, pos);
      pos += n;
      if (stream) stream.pos = pos;
      if (!res.write(buf) && !closed) {
        await new Promise((r) => { wake = r; });
        wake = null;
      }
    } else {
      entry.need(pos, !opts.player);
      await entry.waitData(3000);
    }
  }
  res.end();
}

module.exports = { get, byId, serve, CACHE_DIR, PLAYER_AHEAD, CACHE_AHEAD };
