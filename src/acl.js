const biz = require('./business');

const PERMISSIONS = [
  { key: 'calls', label: 'Call Log', group: 'Call Center' },
  { key: 'clients', label: 'Client Details', group: 'Call Center' },
  { key: 'assign', label: 'Assign Numbers', group: 'Call Center' },
  { key: 'cashier', label: 'Cashier', group: 'Cashier' },
  { key: 'history', label: 'Past Records', group: 'Records' },
  { key: 'masters', label: 'Create Menu', group: 'Records' },
  { key: 'reports', label: 'Reports', group: 'Records' },
  { key: 'accounts', label: 'Accounts', group: 'Accounts' },
  { key: 'transfer', label: 'Cash Transfer', group: 'Accounts' },
  { key: 'expenses', label: 'Expenses', group: 'Accounts' },
  { key: 'approvals', label: 'Job Approvals', group: 'Manager' },
  { key: 'commission', label: 'Commission', group: 'Manager' },
  { key: 'access', label: 'Access Code', group: 'Manager' },
  { key: 'users', label: 'Users', group: 'Utilities' },
  { key: 'acl', label: 'Access Control', group: 'Utilities' },
  { key: 'firebase', label: 'Firebase', group: 'Utilities' },
];

const ROLES = ['CallCenter', 'Cashier', 'History', 'Account', 'Admin'];

const DEFAULTS = {
  CallCenter: ['calls', 'clients', 'assign', 'history', 'masters', 'reports'],
  Cashier: ['cashier', 'history', 'masters', 'reports'],
  History: ['history'],
  Account: ['cashier', 'history', 'masters', 'reports', 'accounts', 'transfer', 'expenses'],
  Admin: ['history', 'reports', 'approvals', 'commission', 'access'],
};

function permissionsFor(group) {
  if (group === 'SAdmin') return PERMISSIONS.map((item) => item.key);
  const saved = readMap();
  const list = Array.isArray(saved[group]) ? saved[group] : DEFAULTS[group] || [];
  const known = new Set(PERMISSIONS.map((item) => item.key));
  return list.filter((key) => known.has(key));
}

function readMap() {
  const raw = biz.setting('acl', '');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function matrix() {
  const saved = readMap();
  const roles = {};
  for (const role of ROLES) {
    roles[role] = Array.isArray(saved[role]) ? permissionsFor(role) : (DEFAULTS[role] || []).slice();
  }
  return { permissions: PERMISSIONS, roles, locked: ['SAdmin'] };
}

function saveMatrix(input) {
  const known = new Set(PERMISSIONS.map((item) => item.key));
  const next = {};
  for (const role of ROLES) {
    const list = Array.isArray(input?.[role]) ? input[role] : DEFAULTS[role];
    next[role] = [...new Set(list.filter((key) => known.has(key)))];
  }
  biz.setSetting('acl', JSON.stringify(next));
  return matrix();
}

function can(group, keys) {
  if (group === 'SAdmin') return true;
  const owned = new Set(permissionsFor(group));
  return keys.some((key) => owned.has(key));
}

module.exports = { PERMISSIONS, ROLES, permissionsFor, matrix, saveMatrix, can };
