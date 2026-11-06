const bcrypt = require('bcryptjs');
const db = require('./db');

const CENTRAL_ROLES = ['bos','admin_pusat'];

function isCentral(user) {
  return CENTRAL_ROLES.includes(user?.role);
}

function canManageMaster(user) {
  return isCentral(user);
}

function canManageEmployees(user) {
  return ['bos','admin_pusat','admin_cabang'].includes(user?.role);
}

function branchScope(user, requestedBranchId) {
  if (isCentral(user)) return requestedBranchId ? Number(requestedBranchId) : null;
  return user?.branch_id ? Number(user.branch_id) : null;
}

async function authenticate(username, password) {
  if (!username || !password) return null;
  const [rows] = await db.query(`
    SELECT u.id,u.username,u.password_hash,u.full_name,u.role,u.branch_id,u.photo,u.status,u.archived_at,
           b.name AS branch_name
    FROM users u
    LEFT JOIN branches b ON b.id=u.branch_id
    WHERE u.username=? LIMIT 1
  `, [username]);
  const u = rows[0];
  if (!u || u.status !== 'aktif' || u.archived_at) return null;
  const valid = await bcrypt.compare(password, u.password_hash);
  if (!valid) return null;
  delete u.password_hash;
  return u;
}

async function log(userId, action, description='') {
  await db.query(
    'INSERT INTO activity_logs(user_id,action,description) VALUES(?,?,?)',
    [userId || null, action, description]
  );
}

module.exports = {
  authenticate,
  isCentral,
  canManageMaster,
  canManageEmployees,
  branchScope,
  log
};
