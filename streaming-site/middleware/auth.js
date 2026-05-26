const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'synplayer_secret_key_2025';

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    req.admin = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// User auth — reads token from cookie or Authorization header
function userAuthMiddleware(req, res, next) {
  let token = null;

  if (req.cookies && req.cookies.syn_user_token) {
    token = req.cookies.syn_user_token;
  } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7);
  }

  if (!token) {
    return res.redirect('/');
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.redirect('/');
  }
}

// API auth — accepts user cookie OR Bearer token (user or admin), returns JSON
function apiAuthMiddleware(req, res, next) {
  let token = null;
  if (req.cookies && req.cookies.syn_user_token) {
    token = req.cookies.syn_user_token;
  } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7);
  }
  if (!token) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期' });
  }
}

module.exports = { authMiddleware, userAuthMiddleware, apiAuthMiddleware, JWT_SECRET };
