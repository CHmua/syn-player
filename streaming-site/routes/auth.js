const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// Register new user
router.post('/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: '请填写所有字段' });
  }
  if (username.length < 2 || username.length > 20) {
    return res.status(400).json({ error: '用户名需要2-20个字符' });
  }
  if (!/^[a-zA-Z0-9_一-龥]+$/.test(username)) {
    return res.status(400).json({ error: '用户名只能包含中英文、数字和下划线' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: '请输入有效的邮箱地址' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少需要6个字符' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) {
    return res.status(409).json({ error: '用户名或邮箱已被注册' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)').run(username, email, hash);
  res.status(201).json({ success: true, user: { id: result.lastInsertRowid, username, email } });
});

// User login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
});

// Get current user info (protected)
router.get('/me', (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    res.json({ id: decoded.id, username: decoded.username, email: decoded.email });
  } catch {
    return res.status(401).json({ error: '登录已过期' });
  }
});

// Change password (protected)
router.put('/password', (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  let userId;
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    userId = decoded.id;
  } catch {
    return res.status(401).json({ error: '登录已过期' });
  }
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: '请填写当前密码和新密码' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少需要6个字符' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: '当前密码错误' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  res.json({ success: true, message: '密码修改成功' });
});

// List all registered users (admin)
router.get('/users', (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    jwt.verify(header.slice(7), JWT_SECRET);
  } catch {
    return res.status(401).json({ error: '登录已过期' });
  }
  const users = db.prepare('SELECT id, username, email, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

// Delete a user (admin)
router.delete('/users/:id', (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  let adminUser;
  try {
    adminUser = jwt.verify(header.slice(7), JWT_SECRET);
  } catch {
    return res.status(401).json({ error: '登录已过期' });
  }
  const targetId = parseInt(req.params.id);
  if (adminUser.id === targetId) {
    return res.status(400).json({ error: '不能删除自己的账号' });
  }
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  if (result.changes === 0) {
    return res.status(404).json({ error: '用户不存在' });
  }
  res.json({ success: true });
});

module.exports = router;
