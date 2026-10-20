const biz = require('./business');

const ACTIONS = ['view', 'create', 'update', 'delete'];

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
const SCREENS = new Set(PERMISSIONS.map((item) => item.key));

const DEFAULTS = {
  CallCenter: grant(['calls', 'clients', 'assign', 'masters'], ACTIONS).concat(grant(['history', 'reports'], ['view'])),
  Cashier: grant(['cashier', 'masters'], ACTIONS).concat(grant(['history', 'reports'], ['view'])),
  History: grant(['history'], ['view']),
  Account: grant(['cashier', 'accounts', 'transfer', 'expenses', 'masters'], ACTIONS).concat(grant(['history', 'reports'], ['view'])),
  Admin: grant(['approvals', 'commission', 'access'], ACTIONS).concat(grant(['history', 'reports'], ['view'])),
};

function grant(screens, actions) {
  return screens.flatMap((screen) => actions.map((action) => `${screen}:${action}`));
}

function expand(list) {
  const out = [];
  for (const key of list || []) {
    if (typeof key !== 'string' || !key.includes(':')) continue;
    const [screen, action] = key.split(':');
    if (SCREENS.has(screen) && ACTIONS.includes(action)) out.push(`${screen}:${action}`);
  }
  return [...new Set(out)];
}

function fromSaved(role, list) {
  const keys = (list || []).filter((key) => typeof key === 'string');
  if (!keys.length) return (DEFAULTS[role] || []).slice();
  if (keys.some((key) => key.includes(':'))) return expand(keys);
  const defaults = DEFAULTS[role] || [];
  return keys.filter((key) => SCREENS.has(key)).flatMap((screen) => {
    const actions = defaults
      .filter((key) => key.startsWith(`${screen}:`))
      .map((key) => key.split(':')[1]);
    return grant([screen], actions.length ? actions : ['view']);
  });
}

function permissionsFor(group) {
  if (group === 'SAdmin') return grant([...SCREENS], ACTIONS);
  const saved = readMap();
  return fromSaved(group, Array.isArray(saved[group]) ? saved[group] : DEFAULTS[group]);
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
    roles[role] = fromSaved(role, Array.isArray(saved[role]) ? saved[role] : DEFAULTS[role]);
  }
  return { permissions: PERMISSIONS, actions: ACTIONS, roles, locked: ['SAdmin'] };
}

function saveMatrix(input) {
  const next = {};
  for (const role of ROLES) {
    next[role] = expand(Array.isArray(input?.[role]) ? input[role] : DEFAULTS[role]);
  }
  biz.setSetting('acl', JSON.stringify(next));
  return matrix();
}

function can(group, keys) {
  if (group === 'SAdmin') return true;
  const owned = new Set(permissionsFor(group));
  return keys.some((key) => owned.has(key) || (!String(key).includes(':') && owned.has(`${key}:view`)));
}

module.exports = { PERMISSIONS, ACTIONS, ROLES, permissionsFor, matrix, saveMatrix, can };
