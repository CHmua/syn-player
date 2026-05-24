const Database = require('better-sqlite3');
const path = require('path');

const dataDir = process.env.DATA_DIR || __dirname;
const db = new Database(path.join(dataDir, 'data.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    description TEXT DEFAULT '',
    poster_url TEXT DEFAULT '',
    video_url TEXT DEFAULT '',
    year TEXT DEFAULT '',
    duration TEXT DEFAULT '',
    genre TEXT DEFAULT '',
    rating REAL DEFAULT 0,
    badge TEXT DEFAULT '',
    is_live INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- VOD aggregation tables (for resource station sync)
  CREATE TABLE IF NOT EXISTS vods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vod_id TEXT NOT NULL UNIQUE,
    vod_name TEXT NOT NULL,
    vod_pic TEXT DEFAULT '',
    vod_content TEXT DEFAULT '',
    vod_play_url TEXT DEFAULT '',
    vod_remarks TEXT DEFAULT '',
    vod_year TEXT DEFAULT '',
    vod_area TEXT DEFAULT '',
    vod_lang TEXT DEFAULT '',
    vod_actor TEXT DEFAULT '',
    vod_director TEXT DEFAULT '',
    vod_score TEXT DEFAULT '0.0',
    vod_type TEXT DEFAULT '',
    type_name TEXT DEFAULT '',
    vod_play_from TEXT DEFAULT '',
    source_name TEXT DEFAULT '',
    douban_id TEXT DEFAULT '',
    douban_rating TEXT DEFAULT '',
    poster TEXT DEFAULT '',
    tmdb_id TEXT DEFAULT '',
    vod_hits INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_vods_vod_id ON vods(vod_id);
  CREATE INDEX IF NOT EXISTS idx_vods_vod_name ON vods(vod_name);
  CREATE INDEX IF NOT EXISTS idx_vods_type_name ON vods(type_name);
  CREATE INDEX IF NOT EXISTS idx_vods_updated_at ON vods(updated_at);

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    parent_id INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    vod_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS collect_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_name TEXT NOT NULL,
    collect_type TEXT DEFAULT 'recent',
    total_fetched INTEGER DEFAULT 0,
    new_added INTEGER DEFAULT 0,
    updated_existing INTEGER DEFAULT 0,
    status TEXT DEFAULT 'success',
    error_msg TEXT,
    duration_ms INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_collect_logs_source ON collect_logs(source_name);
  CREATE INDEX IF NOT EXISTS idx_collect_logs_created ON collect_logs(created_at);
`);

// Add vod_hits column to existing SQLite vods table
try { db.exec('ALTER TABLE vods ADD COLUMN vod_hits INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_vods_vod_hits ON vods(vod_hits)'); } catch(e) {}

// Add backdrop_url for landscape/hero sections (TMDB 16:9 backdrops)
try { db.exec('ALTER TABLE videos ADD COLUMN backdrop_url TEXT DEFAULT \'\''); } catch(e) {}
// Add featured column to vods table for hero carousel support
try { db.exec('ALTER TABLE vods ADD COLUMN featured INTEGER DEFAULT 0'); } catch(e) {}

// Add enrichment columns to vods for auto-collection metadata
try { db.exec('ALTER TABLE vods ADD COLUMN backdrop_url TEXT DEFAULT \'\''); } catch(e) {}
try { db.exec('ALTER TABLE vods ADD COLUMN series_title TEXT DEFAULT \'\''); } catch(e) {}
try { db.exec('ALTER TABLE vods ADD COLUMN season_label TEXT DEFAULT \'\''); } catch(e) {}
try { db.exec('ALTER TABLE vods ADD COLUMN duration TEXT DEFAULT \'\''); } catch(e) {}
try { db.exec('ALTER TABLE vods ADD COLUMN genre TEXT DEFAULT \'\''); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_vods_series ON vods(series_title)'); } catch(e) {}

// Add featured flag for manual hero carousel control
try { db.exec('ALTER TABLE videos ADD COLUMN featured INTEGER DEFAULT 0'); } catch(e) {}

// Add series/season grouping columns
try { db.exec('ALTER TABLE videos ADD COLUMN series_title TEXT DEFAULT \'\''); } catch(e) {}
try { db.exec('ALTER TABLE videos ADD COLUMN season_label TEXT DEFAULT \'\''); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_videos_series ON videos(series_title)'); } catch(e) {}

const seedVideos = [
  // ===== 热门电影 (trendingMovies) =====
  // Posters use TMDB/Douban image CDN — real movie posters (not random placeholders)
  [null, '速度与激情 9', 'trendingMovies', '多姆·托雷托与他的家人们面对迄今为止最危险的对手。从伦敦到东京，从中东到爱丁堡，他们将不惜一切代价阻止一场惊天阴谋。', 'https://image.tmdb.org/t/p/w500/9uAPr02tOGZqEasG9RWy97ZrukJ.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4', '2021', '2h 23m', '动作 / 冒险', 8.5, '热门推荐', 0, 0],
  [null, '复仇者联盟：终局之战', 'trendingMovies', '在灭霸消灭宇宙半数生命之后，复仇者联盟必须再次集结，逆转灭霸的行动。', 'https://image.tmdb.org/t/p/w500/86gWpMdhltrlgQdSofqjYTMj7V4.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4', '2019', '3h 1m', '科幻 / 动作', 9.2, '新片上线', 0, 1],
  [null, '巴霍巴利王 2', 'trendingMovies', '年轻的希瓦从母亲口中得知父亲巴霍巴利国王的传奇故事。', 'https://image.tmdb.org/t/p/w500/dU5bSlqa6SH8FNQwhB2062pCi2C.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4', '2017', '2h 47m', '史诗 / 动作', 8.8, '高分经典', 0, 2],
  [null, '蜘蛛侠：英雄无归', 'trendingMovies', '蜘蛛侠身份暴露后，彼得·帕克向奇异博士寻求帮助。', 'https://image.tmdb.org/t/p/w500/xofidMGUJ70t92ZCVxptS3B228B.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4', '2021', '2h 28m', '动作 / 科幻', 8.9, '限时免费', 0, 3],
  [null, '怦然心动', 'trendingMovies', '讲述了青春期男孩女孩之间有趣的初恋故事。', 'https://image.tmdb.org/t/p/w500/4Nu5blbEXzNm58UKVVZ9qhe3O3y.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4', '2010', '1h 30m', '爱情 / 青春', 9.0, '经典之作', 0, 4],
  [null, '建国大业', 'trendingMovies', '讲述了从抗日战争结束到1949年中华人民共和国建国前夕发生的一系列故事。', 'https://img9.doubanio.com/view/photo/l/public/p2370615793.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4', '2009', '2h 21m', '历史 / 剧情', 7.5, '', 0, 5],
  [null, '战狼2', 'trendingMovies', '脱下军装的特种兵冷锋被卷入了一场非洲国家的叛乱。', 'https://image.tmdb.org/t/p/w500/ieqn7iCoiOJWtNeg1nSdcR0e0OB.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4', '2017', '2h 3m', '动作 / 战争', 7.1, '票房冠军', 0, 6],

  // ===== 热门电视剧 (trendingTV) =====
  [null, '权力的游戏', 'trendingTV', '在维斯特洛大陆上，几大家族为了争夺铁王座展开了残酷的权力斗争。', 'https://image.tmdb.org/t/p/w500/hqWR2XbWdgNjZ7MplmRCEQ1v18M.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4', '2011', '8 季', '奇幻 / 剧情', 9.5, '独家播出', 0, 7],
  [null, '狂飙', 'trendingTV', '以刑警安欣的视角讲述了一线干警与黑恶势力长达二十年的生死较量。', 'https://image.tmdb.org/t/p/w500/nSHBJp1ulPxdp7vtUTrhoXjZjfb.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4', '2023', '39 集', '剧情 / 犯罪', 9.1, '高分必看', 0, 8],
  [null, '三体', 'trendingTV', '根据刘慈欣同名科幻小说改编，讲述地球人类文明与三体文明的信息交流与生死搏杀。', 'https://img9.doubanio.com/view/photo/l/public/p2886227144.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4', '2023', '30 集', '科幻 / 悬疑', 8.7, '独家热播', 0, 9],
  [null, '父母爱情', 'trendingTV', '讲述了一位海军军官与妻子在青岛生活了半个世纪的爱情故事。', 'https://img9.doubanio.com/view/photo/l/public/p2181005446.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4', '2014', '44 集', '家庭 / 爱情', 9.4, '经典回顾', 0, 10],
  [null, '人世间', 'trendingTV', '以周家三兄妹近五十年的生活轨迹为线索，展现了中国社会的巨大变迁。', 'https://img9.doubanio.com/view/photo/l/public/p2866077975.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4', '2022', '58 集', '家庭 / 剧情', 9.0, '', 0, 11],
  [null, '脱口秀大会', 'trendingTV', '国内顶级脱口秀节目，各路喜剧人同台竞技。', 'https://img9.doubanio.com/view/photo/l/public/p2893059755.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4', '2024', '12 集', '喜剧 / 脱口秀', 8.3, '热播中', 0, 12],
  [null, '密室大逃脱', 'trendingTV', '明星嘉宾在密室中挑战解谜逃脱。', 'https://img9.doubanio.com/view/photo/l/public/p2561937115.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4', '2024', '24 集', '真人秀 / 悬疑', 8.1, '', 0, 13],
  [null, '欢乐喜剧人', 'trendingTV', '国内优秀喜剧人同台竞演，笑料不断。', 'https://img9.doubanio.com/view/photo/l/public/p2555536000.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4', '2024', '12 集', '喜剧 / 综艺', 7.9, '', 0, 14],
  [null, '奔跑吧', 'trendingTV', '明星户外竞技真人秀，全新一季火热来袭。', 'https://img9.doubanio.com/view/photo/l/public/p2629354347.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4', '2024', '12 集', '真人秀 / 竞技', 8.0, '', 0, 15],

  // ===== 电视直播 (liveTV) =====
  [null, 'CCTV 新闻', 'liveTV', '中央电视台新闻频道24小时直播', 'https://img9.doubanio.com/view/photo/l/public/p2561937115.jpg', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4', '', '', '新闻', 0, '直播', 1, 16],
  [null, 'CGTN 英语新闻', 'liveTV', '中国国际电视台英语频道', '', 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4', '', '', '新闻 / 英语', 0, '直播', 1, 17],
];

const count = db.prepare('SELECT COUNT(*) as c FROM videos').get();
if (count.c === 0) {
  const insert = db.prepare(`INSERT INTO videos (id, title, category, description, poster_url, video_url, year, duration, genre, rating, badge, is_live, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(...row);
  });
  insertMany(seedVideos);
}

module.exports = db;
