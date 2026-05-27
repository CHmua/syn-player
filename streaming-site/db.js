const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'synplayer123',
  database: process.env.DB_NAME || 'syn_movie',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  charset: 'utf8mb4'
});

// Initialize schema on first connection
async function initDB() {
  const conn = await pool.getConnection();
  try {
    // Core tables
    await conn.query(`
      CREATE TABLE IF NOT EXISTS vods (
        id INT PRIMARY KEY AUTO_INCREMENT,
        vod_id VARCHAR(100) NOT NULL,
        vod_name VARCHAR(500) NOT NULL,
        vod_pic TEXT,
        vod_content TEXT,
        vod_play_url LONGTEXT,
        vod_remarks VARCHAR(255),
        vod_year VARCHAR(20),
        vod_area VARCHAR(100),
        vod_lang VARCHAR(100),
        vod_actor TEXT,
        vod_director VARCHAR(500),
        vod_score VARCHAR(10),
        vod_type VARCHAR(255),
        type_name VARCHAR(100),
        source_name VARCHAR(100),
        tmdb_id VARCHAR(50),
        tmdb_data JSON,
        vod_hits INT DEFAULT 0,
        is_active TINYINT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_vod_id (vod_id),
        INDEX idx_vod_name (vod_name),
        INDEX idx_type_name (type_name),
        INDEX idx_vod_year (vod_year),
        INDEX idx_is_active (is_active),
        INDEX idx_updated_at (updated_at),
        FULLTEXT INDEX ft_vod_name (vod_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Add vod_hits column for existing tables (safe if already exists)
    try { await conn.query('ALTER TABLE vods ADD COLUMN vod_hits INT DEFAULT 0'); } catch(e) {}
    try { await conn.query('CREATE INDEX idx_vod_hits ON vods(vod_hits)'); } catch(e) {}
    // Add featured column for hero carousel support
    try { await conn.query('ALTER TABLE vods ADD COLUMN featured INT DEFAULT 0'); } catch(e) {}
    // Add enrichment columns from TMDB/Douban
    try { await conn.query('ALTER TABLE vods ADD COLUMN poster TEXT'); } catch(e) {}
    try { await conn.query('ALTER TABLE vods ADD COLUMN backdrop TEXT'); } catch(e) {}
    try { await conn.query('ALTER TABLE vods ADD COLUMN douban_id VARCHAR(50)'); } catch(e) {}
    try { await conn.query('ALTER TABLE vods ADD COLUMN douban_rating VARCHAR(10)'); } catch(e) {}
    // Playback-health columns (auto disable dead sources)
    try { await conn.query('ALTER TABLE vods ADD COLUMN playback_fail_count INT DEFAULT 0'); } catch(e) {}
    try { await conn.query('ALTER TABLE vods ADD COLUMN playback_last_failed_at TIMESTAMP NULL'); } catch(e) {}
    try { await conn.query("ALTER TABLE vods ADD COLUMN playback_disable_reason VARCHAR(255) DEFAULT ''"); } catch(e) {}
    try { await conn.query('CREATE INDEX idx_playback_fail_count ON vods(playback_fail_count)'); } catch(e) {}

    await conn.query(`
      CREATE TABLE IF NOT EXISTS vod_play_sources (
        id INT PRIMARY KEY AUTO_INCREMENT,
        vod_id VARCHAR(100) NOT NULL,
        source_name VARCHAR(100) NOT NULL,
        source_label VARCHAR(255),
        source_url TEXT,
        is_active TINYINT DEFAULT 1,
        last_checked TIMESTAMP,
        fail_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_vod_source (vod_id, source_name),
        INDEX idx_is_active (is_active),
        INDEX idx_last_checked (last_checked)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS vod_play_urls (
        id INT PRIMARY KEY AUTO_INCREMENT,
        vod_id VARCHAR(100) NOT NULL,
        source_id INT NOT NULL,
        episode_name VARCHAR(255),
        play_url TEXT NOT NULL,
        is_active TINYINT DEFAULT 1,
        last_checked TIMESTAMP,
        fail_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_play_vod (vod_id),
        INDEX idx_play_source (source_id),
        INDEX idx_is_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL UNIQUE,
        slug VARCHAR(100) NOT NULL UNIQUE,
        parent_id INT DEFAULT 0,
        sort_order INT DEFAULT 0,
        vod_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS search_logs (
        id INT PRIMARY KEY AUTO_INCREMENT,
        keyword VARCHAR(255) NOT NULL,
        result_count INT DEFAULT 0,
        source VARCHAR(50) DEFAULT 'cache',
        ip VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_keyword (keyword),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS collect_logs (
        id INT PRIMARY KEY AUTO_INCREMENT,
        source_name VARCHAR(100) NOT NULL,
        collect_type VARCHAR(50),
        total_fetched INT DEFAULT 0,
        new_added INT DEFAULT 0,
        updated_existing INT DEFAULT 0,
        status VARCHAR(20) DEFAULT 'success',
        error_msg TEXT,
        duration_ms INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_source (source_name),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS hot_keywords (
        id INT PRIMARY KEY AUTO_INCREMENT,
        keyword VARCHAR(255) NOT NULL,
        search_count INT DEFAULT 1,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_keyword (keyword),
        INDEX idx_search_count (search_count DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    console.log('[DB] MySQL schema initialized (7 tables)');
  } finally {
    conn.release();
  }
}

pool.initDB = initDB;

module.exports = pool;
