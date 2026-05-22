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

// Initial admin setup (run once to create default admin account)
router.get('/setup', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM admins').get();
  if (count.c === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run('admin', hash);
    res.send('<h3>管理员账号已创建</h3><p>用户名: <strong>admin</strong></p><p>密码: <strong>admin123</strong></p><p><a href="/admin">前往登录</a></p>');
  } else {
    res.send('<h3>管理员账号已存在</h3><p><a href="/admin">前往登录</a></p>');
  }
});

module.exports = router;
