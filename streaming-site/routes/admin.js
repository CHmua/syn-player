const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const path = require('path');

const router = express.Router();

// Serve admin login page
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'index.html'));
});

// Serve admin dashboard
router.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'dashboard.html'));
});

// Initial admin setup — disabled after first admin is created
router.get('/setup', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM admins').get();
  if (count.c === 0) {
    // Verify JWT_SECRET is not default before allowing setup
    const { JWT_SECRET } = require('../middleware/auth');
    const setupKey = req.query.key;
    const expectedKey = require('crypto').createHash('sha256').update(JWT_SECRET).digest('hex').slice(0, 16);
    if (!setupKey || setupKey !== expectedKey) {
      return res.status(403).send('<h3>需要有效的setup密钥</h3><p>请使用正确的setup链接</p>');
    }
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run('admin', hash);
    res.send('<h3>管理员账号已创建</h3><p>用户名: <strong>admin</strong></p><p>密码: <strong>admin123</strong></p><p><a href="/admin">前往登录</a></p>');
  } else {
    res.send('<h3>管理员账号已存在</h3><p><a href="/admin">前往登录</a></p>');
  }
});

module.exports = router;
