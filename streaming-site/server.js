require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const newsRoutes = require('./routes/news');
const vodRoutes = require('./routes/vod');
const tmdbRoutes = require('./routes/tmdb');
const doubanRoutes = require('./routes/douban');
const { userAuthMiddleware } = require('./middleware/auth');
const { initRedis } = require('./services/cache');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(cookieParser());

// ============================================================
//  API Routes
// ============================================================

// Existing routes
app.use('/api', apiRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/news', newsRoutes);
app.use('/admin', adminRoutes);

// VOD aggregation routes (search, detail, play parse – client direct connect)
app.use('/api/vod', vodRoutes);

// TMDB metadata & poster routes
app.use('/api/tmdb', tmdbRoutes);

// Douban poster scraper routes (no API key needed)
app.use('/api/douban', doubanRoutes);

// ============================================================
//  Public routes
// ============================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

// ============================================================
//  Protected routes (require user auth)
// ============================================================
app.get('/home', userAuthMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/video-player.html', userAuthMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'video-player.html')));
app.get('/news.html', userAuthMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'news.html')));
app.get('/browse.html', userAuthMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'browse.html')));

// Serve static files (CSS, JS, images, etc.) — AFTER routes so auth checks run first
app.use(express.static(__dirname, { index: false }));

// ============================================================
//  Startup
// ============================================================
async function start() {
  // Initialize MySQL schema
  const db = require('./db');
  try {
    await db.initDB();
    console.log('[DB] Database initialized');
  } catch (err) {
    console.error('[DB] Init error:', err.message);
    console.log('[DB] Continuing without MySQL — some features may be unavailable');
  }

  // Initialize Redis/Memory cache
  await initRedis();

  app.listen(PORT, () => {
    console.log(`Syn Player 服务器已启动: http://localhost:${PORT}`);
    console.log(`管理后台: http://localhost:${PORT}/admin`);
    console.log(`VOD搜索API: http://localhost:${PORT}/api/vod/search?wd=流浪地球`);
    console.log(`流媒体播放: 客户端直连 (无代理)`);
    console.log(`会员登录: http://localhost:${PORT}`);
  });
}

// ============================================================
//  Global error handlers — prevent process crash on unhandled errors
// ============================================================
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack?.split('\n')[1] || '');
  // Keep the process alive — do NOT exit
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason?.message || reason);
  // Keep the process alive — do NOT exit
});

start();
