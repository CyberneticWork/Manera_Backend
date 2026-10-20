const bcrypt = require('bcryptjs');
const mysql = require('mysql2');
const deasync = require('deasync');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required. Example: mysql://root:password@localhost:3306/manera');
  process.exit(1);
}

const parsed = new URL(databaseUrl);
const connection = mysql.createConnection({
  host: parsed.hostname,
  port: Number(parsed.port || 3306),
  user: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password),
  database: parsed.pathname.replace(/^\//, ''),
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
});

const SOFT_DELETE = new Set([
  'lookups', 'client_header', 'client_items', 'call_log', 'mobile_assignments', 'users',
  'accounts', 'journal', 'debit_notes', 'credit_notes', 'main_cash', 'petty_cash', 'daily_codes', 'finalized',
]);

function guardSelect(sql) {
  if (!/^\s*select\b/i.test(sql) || /\bdeleted\b/i.test(sql) || /\bjoin\b/i.test(sql)) return sql;
  const match = sql.match(/\bfrom\s+`?([a-z_]+)`?/i);
  if (!match || !SOFT_DELETE.has(match[1])) return sql;
  if (/\bwhere\b/i.test(sql)) return sql.replace(/\bwhere\b/i, 'WHERE deleted = 0 AND');
  if (/\border\s+by\b/i.test(sql)) return sql.replace(/\border\s+by\b/i, 'WHERE deleted = 0 ORDER BY');
  if (/\bgroup\s+by\b/i.test(sql)) return sql.replace(/\bgroup\s+by\b/i, 'WHERE deleted = 0 GROUP BY');
  if (/\blimit\b/i.test(sql)) return sql.replace(/\blimit\b/i, 'WHERE deleted = 0 LIMIT');
  return `${sql} WHERE deleted = 0`;
}

function query(sql, params = []) {
  sql = guardSelect(sql);
  let done = false;
  let rows;
  let error;
  connection.query(sql, params, (err, result) => {
    error = err;
    rows = result;
    done = true;
  });
  deasync.loopWhile(() => !done);
  if (error) throw error;
  return rows;
}

function normalize(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out;
}

const db = {
  prepare(sql) {
    return {
      get(...params) {
        const rows = query(sql, params);
        if (!Array.isArray(rows) || !rows.length) return undefined;
        return normalize(rows[0]);
      },
      all(...params) {
        const rows = query(sql, params);
        return Array.isArray(rows) ? rows.map(normalize) : [];
      },
      run(...params) {
        const result = query(sql, params);
        return {
          lastInsertRowid: result && result.insertId ? Number(result.insertId) : 0,
          changes: result && result.affectedRows ? Number(result.affectedRows) : 0,
        };
      },
    };
  },
  transaction(fn) {
    return () => {
      query('START TRANSACTION');
      try {
        fn();
        query('COMMIT');
      } catch (error) {
        try { query('ROLLBACK'); } catch { /* already failing */ }
        throw error;
      }
    };
  },
};

function today() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

function ensureOpening(date) {
  const prev = db.prepare(
    'SELECT closing FROM opening_balances WHERE date < ? ORDER BY date DESC LIMIT 1'
  ).get(date);
  const opening = prev ? Number(prev.closing) : 0;
  const sums = db.prepare(
    'SELECT COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit FROM main_cash WHERE date = ?'
  ).get(date);
  const closing = opening + Number(sums.debit) + Number(sums.credit);
  const existing = db.prepare('SELECT date FROM opening_balances WHERE date = ?').get(date);
  if (existing) {
    db.prepare(
      'UPDATE opening_balances SET opening = ?, debit = ?, credit = ?, closing = ? WHERE date = ?'
    ).run(opening, sums.debit, sums.credit, closing, date);
  } else {
    db.prepare(
      'INSERT INTO opening_balances (date, opening, debit, credit, closing) VALUES (?, ?, ?, ?, ?)'
    ).run(date, opening, sums.debit, sums.credit, closing);
  }
  return db.prepare('SELECT * FROM opening_balances WHERE date = ?').get(date);
}

function ensureDeletedColumn() {
  for (const table of SOFT_DELETE) {
    try {
      query(`ALTER TABLE \`${table}\` ADD COLUMN deleted INT NOT NULL DEFAULT 0`);
    } catch (error) {
      if (error && (error.code === 'ER_DUP_FIELDNAME' || error.code === 'ER_NO_SUCH_TABLE')) continue;
      throw error;
    }
  }
}

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users WHERE deleted >= 0').get().c;
  if (Number(count) > 0) return;

  const insertUser = db.prepare(
    `INSERT INTO users (username, password_hash, title, group_code, active, company, station_id)
     VALUES (?, ?, ?, ?, 1, 'Gold Store', 'Gold Store')`
  );
  const people = [
    ['sadmin', 'admin123', 'Super Admin', 'SAdmin'],
    ['admin', 'admin123', 'Manager', 'Admin'],
    ['cashier', 'cashier123', 'Cashier', 'Cashier'],
    ['call', 'call123', 'Call Center', 'CallCenter'],
    ['history', 'history123', 'History', 'History'],
    ['account', 'account123', 'Accounts', 'Account'],
  ];
  db.transaction(() => {
    for (const [username, password, title, group] of people) {
      insertUser.run(username, bcrypt.hashSync(password, 10), title, group);
    }
  })();

  const insertLookup = db.prepare(
    'INSERT INTO lookups (type, description, category) VALUES (?, ?, ?)'
  );
  const lists = [
    ['category', 'Gold', null],
    ['category', 'Silver', null],
    ['item', 'Ring', 'Gold'],
    ['item', 'Chain', 'Gold'],
    ['item', 'Bracelet', 'Gold'],
    ['item', 'Coin', 'Gold'],
    ['item', 'Bangle', 'Silver'],
    ['condition', 'New', null],
    ['condition', 'Used', null],
    ['condition', 'Broken', null],
    ['jobType', 'XR', null],
    ['jobType', 'NR', null],
    ['imageType', 'Item', null],
    ['imageType', 'NIC', null],
    ['imageType', 'Receipt', null],
    ['agent', 'Kamal', null],
    ['agent', 'Nimal', null],
    ['rider', 'Sunil', null],
    ['mobile', '0771111111', null],
    ['mobile', '0772222222', null],
    ['userCategory', 'SAdmin', null],
    ['userCategory', 'Admin', null],
    ['userCategory', 'Cashier', null],
    ['userCategory', 'CallCenter', null],
    ['userCategory', 'History', null],
    ['userCategory', 'Account', null],
  ];
  db.transaction(() => {
    for (const row of lists) insertLookup.run(...row);
  })();

  const settings = [
    ['company_name', 'Gold Store'],
    ['company_address', 'Colombo'],
    ['company_phone', '0110000000'],
    ['business_commission', '250'],
    ['rider_commission', '200'],
  ];
  const insertSetting = db.prepare('INSERT INTO settings (`key`, `value`) VALUES (?, ?)');
  for (const row of settings) insertSetting.run(...row);

  db.prepare('INSERT INTO mobile_assignments (date, user_name, mobile_no) VALUES (?, ?, ?)').run(
    today(),
    'call',
    '0771111111'
  );

  const groups = [
    ['100000', 'Assets'],
    ['150000', 'Current Assets'],
    ['200000', 'Liabilities'],
    ['250000', 'Equity'],
    ['300000', 'Income'],
    ['350000', 'Expenses'],
  ];
  const insertGroup = db.prepare('INSERT INTO account_groups (code, description) VALUES (?, ?)');
  for (const row of groups) insertGroup.run(...row);

  const subtypes = [
    ['111', 'Cash and Bank', '150000', 1],
    ['101', 'Bank', '150000', 1],
    ['301', 'Sales Income', '300000', 0],
    ['351', 'Operating Expense', '350000', 0],
    ['201', 'Tax Payable', '200000', 0],
  ];
  const insertSub = db.prepare(
    'INSERT INTO account_subtypes (code, description, group_code, is_bank) VALUES (?, ?, ?, ?)'
  );
  for (const row of subtypes) insertSub.run(...row);

  const accounts = [
    ['15001', 'Manager', '150000', '111', 'Debit', 'CashBook'],
    ['15002', 'Main Cash', '150000', '111', 'Debit', ''],
    ['15003', 'Petty Cash', '150000', '111', 'Debit', ''],
    ['300001', 'Other Income', '300000', '301', 'Credit', 'Income'],
    ['350001', 'Gold Purchase', '350000', '351', 'Debit', 'Purchase'],
    ['200001', 'VAT', '200000', '201', 'Credit', 'VAT'],
  ];
  const insertAcc = db.prepare(
    `INSERT INTO accounts (code, name, group_code, subtype_code, normal_balance, opening, settings, company)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'Gold Store')`
  );
  for (const row of accounts) insertAcc.run(...row);

  db.prepare(
    `INSERT INTO client_header
      (doc_no, code, nic, name, address, mobile_no, location, agent_name, agent_commission,
       rider_name, rider_commission, job_type, job_note_no, date, note, reject, buddy, answered,
       total_amount, status, created_by)
     VALUES ('1', 1, '199012345678', 'Sample Customer', 'Colombo 07', '0771234567', 'Colombo',
             'Kamal', 0, 'Sunil', 0, 'XR', 'N-1', ?, 'Walk-in sample job', 0, 'No', 'Yes',
             150000, 0, 'sadmin')`
  ).run(today());
  db.prepare(
    `INSERT INTO client_items (doc_no, nic, date, category, item_name, \`condition\`, weight, rate, description)
     VALUES ('1', '199012345678', ?, 'Gold', 'Ring', 'Used', 22.5, '22K', 'Sample ring')`
  ).run(today());
}

try {
  ensureDeletedColumn();
  seed();
} catch (error) {
  if (error && error.code === 'ER_NO_SUCH_TABLE') {
    console.error('MySQL tables are missing. Run npm run db:push in the backend folder, then start again.');
  }
  throw error;
}

module.exports = { db, today, addDays, ensureOpening };
