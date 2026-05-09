const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    next();
  } catch {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authenticateToken };
