// پخش زنده‌ی ویدیو از لینک مستقیم، بدون دانلود کامل
//   /proxy     : پخش مستقیم با پشتیبانی Range — برای mp4/webm
//   /transcode : تبدیل لحظه‌ای با ffmpeg به MP4 تکه‌تکه — برای mkv و کدک‌های ناسازگار
// همه‌چیز از لایه‌ی کش (cache.js) عبور می‌کند تا قطعی اینترنت پخش را خراب نکند.
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn, execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const cache = require('./cache');

const app = express();
const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const fs = require('fs');
  const inPublic = path.join(__dirname, 'public', 'index.html');
  res.sendFile(fs.existsSync(inPublic) ? inPublic : path.join(__dirname, 'index.html'));
});

function parseUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:' ? x : null;
  } catch {
    return null;
  }
}

function guessType(pathname) {
  const ext = path.extname(pathname).toLowerCase();
  return {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4',
    '.webm': 'video/webm', '.mkv': 'video/webm',
  }[ext] || 'application/octet-stream';
}

// ورودی ffmpeg: اگر کش ممکن بود، آدرس محلی کش؛ وگرنه خود لینک
//   probe=true برای ffprobe: خواندن‌هایش جای پخش حساب نمی‌شود و دانلود جلوتر راه نمی‌اندازد
async function inputFor(url, probe = false) {
  try {
    const entry = await cache.get(url.href);
    return { input: `http://127.0.0.1:${PORT}/cache/${entry.id}${probe ? '?probe=1' : ''}`, local: true, entry };
  } catch (e) {
    console.log('[cache] استفاده از لینک مستقیم:', e.message);
    return { input: url.href, local: false, entry: null };
  }
}

// آدرس داخلی کش (فقط برای ffmpeg/ffprobe)
app.get('/cache/:id', (req, res) => {
  const entry = cache.byId(req.params.id);
  if (!entry) return res.status(404).end();
  cache.serve(entry, req, res, 'application/octet-stream', { player: !req.query.probe });
});

// وضعیت دانلود و اتصال — صفحه هر ثانیه این را صدا می‌زند و جای پخش را گزارش می‌دهد
//   t: currentTime ویدیو   p: 1 اگر در حال پخش است   d: مدت فیلم
app.get('/status', (req, res) => {
  const url = parseUrl(req.query.url);
  if (!url) return res.status(400).json({ error: 'لینک نامعتبر است' });
  cache.get(url.href)
    .then((e) => {
      e.report({
        t: req.query.t != null ? parseFloat(req.query.t) : null,
        playing: req.query.p === '1',
        duration: parseFloat(req.query.d) || 0,
      });
      res.json(e.status());
    })
    .catch(() => res.json({ online: false, percent: 0, ranges: [], unsupported: true }));
});

// پخش مستقیم
app.get('/proxy', async (req, res) => {
  const url = parseUrl(req.query.url);
  if (!url) return res.status(400).send('لینک نامعتبر است');
  try {
    const entry = await cache.get(url.href);
    cache.serve(entry, req, res, guessType(url.pathname), { player: true, throttle: true });
  } catch (e) {
    // سرور مبدأ Range را پشتیبانی نمی‌کند: عبور ساده
    const lib = url.protocol === 'https:' ? https : http;
    lib.get(url, { headers: { 'User-Agent': UA } }, (up) => {
      res.writeHead(up.statusCode, { 'Content-Type': guessType(url.pathname) });
      up.pipe(res);
      req.on('close', () => up.destroy());
    }).on('error', (err) => { if (!res.headersSent) res.status(502).send(err.message); });
  }
});

// اطلاعات فایل
app.get('/info', async (req, res) => {
  const url = parseUrl(req.query.url);
  if (!url) return res.status(400).json({ error: 'لینک نامعتبر است' });
  const { input, entry } = await inputFor(url, true);

  const args = ['-v', 'error', '-user_agent', UA, '-print_format', 'json', '-show_format', '-show_streams', input];
  execFile(ffprobePath, args, { timeout: 60000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(502).json({ error: 'خواندن اطلاعات فایل ناموفق بود' });
    try {
      const data = JSON.parse(stdout);
      const streams = data.streams || [];
      const video = streams.find((s) => s.codec_type === 'video');
      const audios = streams.filter((s) => s.codec_type === 'audio').map((s, i) => ({
        index: i, codec: s.codec_name, channels: s.channels,
        language: s.tags?.language || '', title: s.tags?.title || '',
      }));
      const duration = parseFloat(data.format?.duration) || 0;
      if (entry && duration) entry.setDuration(duration);
      res.json({
        duration,
        container: data.format?.format_name || '',
        videoCodec: video?.codec_name || '', width: video?.width, height: video?.height,
        audios,
      });
    } catch {
      res.status(500).json({ error: 'پاسخ ffprobe قابل خواندن نبود' });
    }
  });
});

// پیدا کردن فریم کلیدی قبل از زمان t
// پخش دقیقاً از یک فریم کلیدی شروع می‌شود تا صدا و تصویر هر دو از یک نقطه شروع شوند
app.get('/keyframe', async (req, res) => {
  const url = parseUrl(req.query.url);
  const t = Math.max(0, parseFloat(req.query.t) || 0);
  if (!url) return res.status(400).json({ error: 'لینک نامعتبر است' });
  if (t < 0.5) return res.json({ start: 0 });
  const { input } = await inputFor(url, true);
  const args = [
    '-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${t}%+#1`,
    '-show_entries', 'packet=pts_time,flags:format=start_time', '-of', 'json', input,
  ];
  execFile(ffprobePath, args, { timeout: 30000 }, (err, stdout) => {
    let start = t;
    try {
      const data = JSON.parse(stdout);
      const pkt = (data.packets || []).find((p) => (p.flags || '').includes('K')) || (data.packets || [])[0];
      const base = parseFloat(data.format?.start_time) || 0;
      const k = parseFloat(pkt?.pts_time) - base;
      if (isFinite(k) && k >= 0 && k <= t + 1) start = k;
    } catch {}
    res.json({ start: Math.round(start * 1000) / 1000 });
  });
});

// تبدیل لحظه‌ای
app.get('/transcode', async (req, res) => {
  const url = parseUrl(req.query.url);
  if (!url) return res.status(400).send('لینک نامعتبر است');

  const start = Math.max(0, parseFloat(req.query.start) || 0);
  const audio = Math.max(0, parseInt(req.query.audio, 10) || 0);
  const encodeVideo = req.query.v === 'encode';
  // تأخیر صدا به میلی‌ثانیه: مثبت = صدا دیرتر، منفی = صدا زودتر
  const ad = Math.max(-10000, Math.min(10000, parseInt(req.query.ad, 10) || 0));
  const audioFilter = [
    ad > 0 ? `adelay=${ad}:all=1` : '',
    ad < 0 ? `atrim=start=${(-ad / 1000).toFixed(3)},asetpts=PTS-STARTPTS` : '',
    'aresample=async=1:first_pts=0',   // صدا را دقیقاً با شروع تصویر هم‌تراز می‌کند و فاصله‌ها را پر می‌کند
  ].filter(Boolean).join(',');
  const { input, local, entry } = await inputFor(url);
  const stream = entry ? entry.startStream('transcode') : null;   // ویدیوی تازه، بافر مرورگر خالی است

  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...(local
      ? []   // کش محلی خودش منتظر اینترنت می‌ماند
      : ['-user_agent', UA, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '30']),
    // start همیشه یک فریم کلیدی است؛ ۰.۲ ثانیه اضافه تا ffmpeg دقیقاً روی همان فریم بنشیند (نه قبلی)
    // noaccurate_seek: صدا را هم از همان فریم کلیدی شروع می‌کند، پس صدا و تصویر از یک نقطه شروع می‌شوند
    '-noaccurate_seek',
    '-ss', String(start > 0 ? start + 0.2 : 0),
    '-i', input,
    '-map', '0:v:0', '-map', `0:a:${audio}?`,
    ...(encodeVideo
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']
      : ['-c:v', 'copy']),
    '-af', audioFilter,
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-avoid_negative_ts', 'make_zero',
    '-sn', '-dn',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
    // گزارش پیشرفت روی fd 3: زمانِ آخرین داده‌ی ساخته‌شده (برای محدود کردن بافر)
    '-progress', 'pipe:3', '-stats_period', '0.5',
  ];

  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  if (stream) {
    let buf = '';
    ff.stdio[3].on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        const m = /^out_time_us=(\d+)/.exec(l);
        if (m) { stream.outTime = Number(m[1]) / 1e6; stream.bytesSince = 0; }
      }
    });
  }
  let started = false, closed = false, waitingDrain = false, holding = false;
  // خروجی ffmpeg متوقف می‌شود اگر مرورگر منتظر drain است یا بافرش پر است؛
  // در نتیجه ffmpeg هم جلوتر نمی‌خواند و کش هم جلوتر دانلود نمی‌کند
  const update = () => { if (waitingDrain || holding) ff.stdout.pause(); else ff.stdout.resume(); };
  const checkHold = () => {
    if (closed) return;
    if (entry && entry.stream === stream && entry.shouldHold()) setTimeout(checkHold, 400);
    else { holding = false; update(); }
  };
  ff.stdout.on('data', (chunk) => {
    if (!started) {
      started = true;
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    }
    if (stream) stream.bytesSince += chunk.length;
    if (!res.write(chunk)) {
      waitingDrain = true;
      update();
      res.once('drain', () => { waitingDrain = false; update(); });
    }
    if (entry && entry.stream === stream && !holding && entry.shouldHold()) {
      holding = true;
      update();
      setTimeout(checkHold, 400);
    }
  });
  ff.stderr.on('data', (d) => process.stderr.write('[ffmpeg] ' + d));
  ff.on('close', () => {
    if (!started) { if (!res.headersSent) res.status(502).send('ffmpeg نتوانست فایل را باز کند'); }
    else res.end();
  });
  req.on('close', () => { closed = true; ff.kill('SIGKILL'); });
});

app.listen(PORT, () => {
  console.log(`پخش‌کننده آماده است: http://localhost:${PORT}`);
  console.log(`پوشه‌ی کش: ${cache.CACHE_DIR}`);
});
