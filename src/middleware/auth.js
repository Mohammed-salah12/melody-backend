const User = require('../models/User');
const { HttpError } = require('../lib/http');
const { verify } = require('../lib/tokens');

/** Requires "Authorization: Bearer <token>" and puts the user on req.user. */
async function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Please log in.');
  const { sub } = verify(token, 'session');
  const user = await User.findById(sub);
  if (!user) throw new HttpError(401, 'Please log in again.');
  req.user = user;
  next();
}

/** Use after requireAuth: only admins (role "admin") may continue. */
function requireAdmin(req, _res, next) {
  if (req.user?.role !== 'admin') throw new HttpError(403, 'Only admins can do this.');
  next();
}

module.exports = { requireAuth, requireAdmin };
