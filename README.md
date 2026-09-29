# Stream Player | پخش‌کنندهٔ ویدیو

## فارسی

پخش ویدیو از لینک مستقیم HTTP/HTTPS بدون دانلود کامل فایل. MP4/WebM سازگار مستقیم پخش می‌شود؛ برای MKV یا کدک ناسازگار، FFmpeg هنگام پخش به MP4 تبدیل می‌کند.

### راه‌اندازی

Node.js 18 یا جدیدتر لازم است.

```bash
npm ci
npm start
```

آدرس http://localhost:3000 را باز کنید و لینک مستقیم ویدیو را وارد کنید. برای کش، سرور مبدأ باید HTTP Range را پشتیبانی کند؛ در غیر این صورت پخش مستقیم به جریان ساده از مبدأ برمی‌گردد.

### امکانات و تنظیمات

جابه‌جایی در فیلم، انتخاب صدا، تنظیم تأخیر صدا، تبدیل هم‌زمان، کش محدود روی دیسک و ادامهٔ دانلود پس از قطع اتصال. لینک‌های اخیر در حافظهٔ محلی مرورگر ذخیره می‌شوند.

متغیرهای اختیاری: PORT (پیش‌فرض 3000)، CACHE_DIR (پوشهٔ موقت سیستم)، CACHE_KEEP (3 فایل)، CACHE_AHEAD (18 ثانیه)، CACHE_REFILL (10 ثانیه)، PLAYER_AHEAD (22 ثانیه). کش ممکن است ویدیو و لینک کامل، از جمله پارامترهای دسترسی، را نگه دارد؛ آن را خصوصی نگه دارید. برنامه احراز هویت ندارد و لینک‌ها را از سمت سرور درخواست می‌کند؛ آن را روی شبکهٔ عمومی منتشر نکنید.

## English

Play video from direct HTTP/HTTPS links without downloading the entire file. Compatible MP4/WebM plays directly; FFmpeg converts MKV and incompatible codecs to fragmented MP4 while streaming.

### Setup

Requires Node.js 18 or newer.

```bash
npm ci
npm start
```

Open http://localhost:3000 and paste a direct video URL. HTTP Range support is required for disk caching; otherwise direct playback falls back to a simple upstream stream.

### Features and configuration

Seek, select audio tracks, adjust audio delay, transcode on the fly, and cache a bounded amount ahead of playback with reconnect attempts. Recent URLs are stored in browser local storage.

Optional environment variables: PORT (default 3000), CACHE_DIR (system temp directory), CACHE_KEEP (3 files), CACHE_AHEAD (18 seconds), CACHE_REFILL (10 seconds), PLAYER_AHEAD (22 seconds). The cache can contain video and complete URLs including access parameters; keep it private. The app has no authentication and fetches URLs server-side; do not expose it directly to the public internet.
