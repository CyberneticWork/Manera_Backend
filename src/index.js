require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const storage = require('./storage');
const acl = require('./acl');
const { db, today, addDays, ensureOpening } = require('./db');
const biz = require('./business');
const { build: buildPdf, collect: collectReport } = require('./pdfs');

const app = express();
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'goldstore-dev-secret';

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '4mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

function sign(user) {
  return jwt.sign(
    { id: user.id, username: user.username, group: user.group_code, title: user.title },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token && String(req.path).startsWith('/api/media') && req.query.token) token = String(req.query.token);
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please login again.' });
  }
}

function permit(...keys) {
  return (req, res, next) => {
    if (acl.can(req.user.group, keys)) return next();
    res.status(403).json({ error: 'Your access list does not include this action' });
  };
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

function imageContentType(name) {
  const ext = path.extname(name || '').toLowerCase();
  return {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.bmp': 'image/bmp',
  }[ext] || '';
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'Gold Store', time: new Date().toISOString() });
});

app.post('/api/auth/login', asyncRoute((req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Enter username and password' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !user.active || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'User name or password is wrong' });
  }
  const opening = ensureOpening(today());
  biz.audit(user.username, 'LOGIN', user.username, 'Login');
  res.json({
    token: sign(user),
    user: {
      id: user.id,
      username: user.username,
      title: user.title,
      group: user.group_code,
      company: user.company,
    },
    permissions: acl.permissionsFor(user.group_code),
    opening,
    company: {
      name: biz.setting('company_name', 'Gold Store'),
      address: biz.setting('company_address', ''),
      phone: biz.setting('company_phone', ''),
    },
  });
}));

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, username, title, group_code, company FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({
    user: { id: user.id, username: user.username, title: user.title, group: user.group_code, company: user.company },
    permissions: acl.permissionsFor(user.group_code),
    company: {
      name: biz.setting('company_name', 'Gold Store'),
      address: biz.setting('company_address', ''),
      phone: biz.setting('company_phone', ''),
    },
  });
});

app.get('/api/acl', auth, permit('acl'), (_req, res) => {
  res.json(acl.matrix());
});

app.put('/api/acl', auth, permit('acl:update'), (req, res) => {
  const saved = acl.saveMatrix(req.body.roles || {});
  biz.audit(req.user.username, 'ACL', '*', 'Update access list');
  res.json(saved);
});

app.get('/api/firebase/status', auth, (_req, res) => {
  res.json({ configured: storage.configured() });
});

app.get('/api/firebase', auth, permit('firebase'), (_req, res) => {
  res.json(storage.publicStatus());
});

app.put('/api/firebase', auth, permit('firebase:update'), (req, res) => {
  const bucket = String(req.body.bucket || '').trim();
  const projectId = String(req.body.projectId || '').trim();
  const clientEmail = String(req.body.clientEmail || '').trim();
  const privateKey = String(req.body.privateKey || '').trim();
  if (bucket) biz.setSetting('firebase_bucket', bucket);
  if (projectId) biz.setSetting('firebase_project_id', projectId);
  if (clientEmail) biz.setSetting('firebase_client_email', clientEmail);
  if (privateKey) biz.setSetting('firebase_private_key', privateKey.replace(/\\n/g, '\n'));
  biz.audit(req.user.username, 'FIREBASE', bucket || 'firebase', 'Update storage config');
  res.json(storage.publicStatus());
});

function riderNames(user) {
  if (!user || user.group !== 'Rider') return null;
  return [...new Set([user.username, user.title].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function riderOwns(user, header) {
  const names = riderNames(user);
  if (!names) return true;
  return names.includes(String(header?.rider_name || '').trim().toLowerCase());
}

function riderChoice(user) {
  if (!user || user.group !== 'Rider') return null;
  const title = String(user.title || '').trim();
  const username = String(user.username || '').trim();
  const rows = db.prepare("SELECT description FROM lookups WHERE type = 'rider'").all();
  const match = (value) => rows.find((row) => String(row.description || '').trim().toLowerCase() === value.toLowerCase());
  return (title && match(title)?.description) || (username && match(username)?.description) || title || username || '';
}

function asNumber(value) {
  return Number(value) || 0;
}

function weekday(dateStr) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${dateStr}T00:00:00`).getDay()];
}

app.get('/api/dashboard', auth, (req, res) => {
  const date = today();
  const month = date.slice(0, 7);
  const weekStart = addDays(date, -6);
  const names = riderNames(req.user);
  const ownSql = names ? ` AND LOWER(TRIM(rider_name)) IN (${names.map(() => '?').join(', ')})` : '';
  const own = names || [];
  const shop = !names;

  const countOf = (sql, params = []) => asNumber(db.prepare(sql).get(...params)?.c);
  const rowOf = (sql, params = []) => db.prepare(sql).get(...params) || {};
  const slices = (sql, params = []) => db.prepare(sql).all(...params).map((row) => ({
    label: row.label || 'Other',
    jobs: asNumber(row.jobs),
    amount: asNumber(row.amount),
    weight: asNumber(row.weight),
  }));

  const pending = countOf(
    `SELECT COUNT(*) AS c FROM client_header WHERE status = 0 AND reject = 0${ownSql}`,
    own
  );
  const pendingAmount = asNumber(rowOf(
    `SELECT COALESCE(SUM(total_amount), 0) AS amount FROM client_header WHERE status = 0 AND reject = 0${ownSql}`,
    own
  ).amount);
  const rejected = countOf(`SELECT COUNT(*) AS c FROM client_header WHERE reject = 1${ownSql}`, own);
  const finalizedToday = countOf(
    `SELECT COUNT(*) AS c FROM finalized WHERE finalized_date = ?${ownSql}`,
    [date, ...own]
  );
  const unapproved = countOf(`SELECT COUNT(*) AS c FROM finalized WHERE approved = 0${ownSql}`, own);
  const approved = countOf(`SELECT COUNT(*) AS c FROM finalized WHERE approved = 1${ownSql}`, own);

  const cash = shop
    ? rowOf('SELECT COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit FROM main_cash WHERE date = ?', [date])
    : { debit: 0, credit: 0 };
  const petty = shop
    ? rowOf('SELECT COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit FROM petty_cash WHERE date = ?', [date])
    : { debit: 0, credit: 0 };
  const todayJobs = rowOf(
    `SELECT COUNT(*) AS jobs, COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(total_weight), 0) AS weight,
            COALESCE(SUM(agent_commission), 0) AS agent_commission, COALESCE(SUM(rider_commission), 0) AS rider_commission,
            COALESCE(SUM(item_count), 0) AS items
     FROM finalized WHERE finalized_date = ?${ownSql}`,
    [date, ...own]
  );
  const monthJobs = rowOf(
    `SELECT COUNT(*) AS jobs, COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(total_weight), 0) AS weight,
            COALESCE(SUM(agent_commission), 0) AS agent_commission, COALESCE(SUM(rider_commission), 0) AS rider_commission
     FROM finalized WHERE finalized_date LIKE ?${ownSql}`,
    [`${month}%`, ...own]
  );
  const callsToday = shop ? countOf('SELECT COUNT(*) AS c FROM call_log WHERE date = ?', [date]) : 0;
  const callsMonth = shop ? countOf('SELECT COUNT(*) AS c FROM call_log WHERE date LIKE ?', [`${month}%`]) : 0;

  const typesToday = slices(
    `SELECT COALESCE(NULLIF(TRIM(job_type), ''), 'Other') AS label, COUNT(*) AS jobs,
            COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(total_weight), 0) AS weight
     FROM finalized WHERE finalized_date = ?${ownSql}
     GROUP BY COALESCE(NULLIF(TRIM(job_type), ''), 'Other')
     ORDER BY amount DESC`,
    [date, ...own]
  );
  const typesMonth = slices(
    `SELECT COALESCE(NULLIF(TRIM(job_type), ''), 'Other') AS label, COUNT(*) AS jobs,
            COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(total_weight), 0) AS weight
     FROM finalized WHERE finalized_date LIKE ?${ownSql}
     GROUP BY COALESCE(NULLIF(TRIM(job_type), ''), 'Other')
     ORDER BY amount DESC`,
    [`${month}%`, ...own]
  );
  const openTypes = slices(
    `SELECT COALESCE(NULLIF(TRIM(job_type), ''), 'Other') AS label, COUNT(*) AS jobs,
            COALESCE(SUM(total_amount), 0) AS amount, 0 AS weight
     FROM client_header WHERE status = 0 AND reject = 0${ownSql}
     GROUP BY COALESCE(NULLIF(TRIM(job_type), ''), 'Other')
     ORDER BY amount DESC`,
    own
  );
  const weekRows = db.prepare(
    `SELECT finalized_date AS date, COUNT(*) AS jobs, COALESCE(SUM(amount), 0) AS amount,
            COALESCE(SUM(total_weight), 0) AS weight
     FROM finalized WHERE finalized_date >= ? AND finalized_date <= ?${ownSql}
     GROUP BY finalized_date`
  ).all(weekStart, date, ...own);
  const weekByDate = new Map(weekRows.map((row) => [String(row.date).slice(0, 10), row]));
  const week = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const day = addDays(weekStart, offset);
    const row = weekByDate.get(day) || {};
    week.push({
      date: day,
      label: weekday(day),
      jobs: asNumber(row.jobs),
      amount: asNumber(row.amount),
      weight: asNumber(row.weight),
    });
  }
  const places = slices(
    `SELECT COALESCE(NULLIF(TRIM(location), ''), 'Unknown') AS label, COUNT(*) AS jobs,
            COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(total_weight), 0) AS weight
     FROM finalized WHERE finalized_date LIKE ?${ownSql}
     GROUP BY COALESCE(NULLIF(TRIM(location), ''), 'Unknown')
     ORDER BY amount DESC LIMIT 6`,
    [`${month}%`, ...own]
  );
  const openPlaces = slices(
    `SELECT COALESCE(NULLIF(TRIM(location), ''), 'Unknown') AS label, COUNT(*) AS jobs,
            COALESCE(SUM(total_amount), 0) AS amount, 0 AS weight
     FROM client_header WHERE status = 0 AND reject = 0${ownSql}
     GROUP BY COALESCE(NULLIF(TRIM(location), ''), 'Unknown')
     ORDER BY amount DESC LIMIT 6`,
    own
  );
  const agents = slices(
    `SELECT COALESCE(NULLIF(TRIM(agent_name), ''), 'Unassigned') AS label, COUNT(*) AS jobs,
            COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(total_weight), 0) AS weight
     FROM finalized WHERE finalized_date LIKE ?${ownSql}
     GROUP BY COALESCE(NULLIF(TRIM(agent_name), ''), 'Unassigned')
     ORDER BY amount DESC LIMIT 6`,
    [`${month}%`, ...own]
  );

  res.json({
    date,
    scope: shop ? 'shop' : 'rider',
    pending,
    pendingAmount,
    rejected,
    approved,
    finalizedToday,
    unapproved,
    cashDebit: asNumber(cash.debit),
    cashCredit: asNumber(cash.credit),
    weightToday: asNumber(todayJobs.weight),
    amountToday: asNumber(todayJobs.amount),
    monthJobs: asNumber(monthJobs.jobs),
    monthAmount: asNumber(monthJobs.amount),
    monthWeight: asNumber(monthJobs.weight),
    callsToday,
    callsMonth,
    byType: typesToday.map((row) => ({ job_type: row.label, jobs: row.jobs, amount: row.amount })),
    today: {
      jobs: asNumber(todayJobs.jobs),
      amount: asNumber(todayJobs.amount),
      weight: asNumber(todayJobs.weight),
      items: asNumber(todayJobs.items),
      agentCommission: asNumber(todayJobs.agent_commission),
      riderCommission: asNumber(todayJobs.rider_commission),
      cashOut: asNumber(cash.debit),
      cashIn: asNumber(cash.credit),
      pettyOut: asNumber(petty.debit),
      pettyIn: asNumber(petty.credit),
      calls: callsToday,
    },
    month: {
      jobs: asNumber(monthJobs.jobs),
      amount: asNumber(monthJobs.amount),
      weight: asNumber(monthJobs.weight),
      agentCommission: asNumber(monthJobs.agent_commission),
      riderCommission: asNumber(monthJobs.rider_commission),
      calls: callsMonth,
    },
    book: [
      { label: 'Pending', value: pending },
      { label: 'Approved', value: approved },
      { label: 'Need approval', value: unapproved },
      { label: 'Rejected', value: rejected },
    ],
    typesToday,
    typesMonth,
    openTypes,
    week,
    places,
    openPlaces,
    agents,
    recent: db.prepare(
      `SELECT job_no, doc_no, nic, job_type, amount, location, finalized_date, approved
       FROM finalized WHERE 1 = 1${ownSql} ORDER BY finalized_date DESC, job_no DESC LIMIT 6`
    ).all(...own),
    waiting: db.prepare(
      `SELECT doc_no, name, nic, job_type, location, date, total_amount, rider_name
       FROM client_header WHERE status = 0 AND reject = 0${ownSql}
       ORDER BY date DESC, doc_no DESC LIMIT 6`
    ).all(...own),
    arrivals: db.prepare(
      `SELECT doc_no, code, name, nic, job_type, location, total_amount, rider_name, mobile_no, created_by, date
       FROM client_header WHERE status = 0 AND reject = 0${ownSql}
       ORDER BY code DESC LIMIT 8`
    ).all(...own),
    role: req.user.group,
  });
});

app.get('/api/lookups', auth, (_req, res) => {
  const rows = db.prepare('SELECT id, type, description, category FROM lookups ORDER BY type, description').all();
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.type]) grouped[row.type] = [];
    grouped[row.type].push(row);
  }
  res.json(grouped);
});

app.post('/api/lookups', auth, permit('masters:create'), asyncRoute((req, res) => {
  const type = String(req.body.type || '').trim();
  const description = String(req.body.description || '').trim();
  const category = req.body.category ? String(req.body.category).trim() : null;
  if (!type || !description) bad('Type and description are required');
  const info = db.prepare('INSERT INTO lookups (type, description, category) VALUES (?, ?, ?)').run(type, description, category);
  res.json({ id: info.lastInsertRowid, type, description, category });
}));

app.put('/api/lookups/:id', auth, permit('masters:update'), (req, res) => {
  const description = String(req.body.description || '').trim();
  if (!description) return res.status(400).json({ error: 'Description is required' });
  db.prepare('UPDATE lookups SET description = ?, category = ? WHERE id = ?').run(
    description,
    req.body.category ? String(req.body.category) : null,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/lookups/:id', auth, permit('masters:delete'), (req, res) => {
  db.prepare('UPDATE lookups SET deleted = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

function jobPayload(row, items, images, documents) {
  return { ...row, items, images, documents: documents || [] };
}

app.get('/api/clients', auth, permit('clients', 'cashier', 'history'), (req, res) => {
  const status = req.query.status === undefined ? 0 : Number(req.query.status);
  const names = riderNames(req.user);
  const riderSql = names ? ` AND LOWER(TRIM(rider_name)) IN (${names.map(() => '?').join(', ') || 'NULL'})` : '';
  const rows = db.prepare(
    `SELECT doc_no, agent_name, rider_name, mobile_no, date, name, nic, location, total_amount, job_type, status, reject
     FROM client_header WHERE status = ? AND reject = 0${riderSql} ORDER BY code DESC`
  ).all(status, ...(names || []));
  res.json(rows);
});

app.get('/api/clients/:docNo', auth, permit('clients', 'cashier', 'history', 'approvals'), (req, res) => {
  const header = db.prepare('SELECT * FROM client_header WHERE doc_no = ?').get(req.params.docNo);
  if (!header || !riderOwns(req.user, header)) return res.status(404).json({ error: 'Job not found' });
  const items = db.prepare('SELECT * FROM client_items WHERE doc_no = ? ORDER BY id').all(req.params.docNo);
  const images = db.prepare('SELECT * FROM client_images WHERE doc_no = ? ORDER BY id').all(req.params.docNo);
  const documents = db.prepare('SELECT * FROM client_documents WHERE doc_no = ? ORDER BY id').all(req.params.docNo);
  res.json(jobPayload(header, items, images, documents));
});

app.get('/api/clients/next/code', auth, permit('clients'), (_req, res) => {
  res.json(biz.nextDocNo());
});

function saveItems(docNo, nic, date, items) {
  db.prepare('UPDATE client_items SET deleted = 1 WHERE doc_no = ? AND deleted = 0').run(docNo);
  const insert = db.prepare(
    `INSERT INTO client_items (doc_no, nic, date, category, item_name, \`condition\`, weight, rate, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const item of items || []) {
    insert.run(
      docNo,
      nic,
      date,
      item.category || '',
      item.itemName || item.item_name || '',
      item.condition || '',
      num(item.weight),
      item.rate || '',
      item.description || ''
    );
  }
}

app.post('/api/clients', auth, permit('clients:create'), asyncRoute((req, res) => {
  const body = req.body || {};
  if (!body.name || !body.mobileNo) bad('Customer name and mobile number are required');
  const { docNo, code } = biz.nextDocNo();
  const date = body.date || today();
  const save = db.transaction(() => {
    db.prepare(
      `INSERT INTO client_header
        (doc_no, code, nic, name, address, mobile_no, location, agent_name, agent_commission,
         rider_name, rider_commission, job_type, job_note_no, date, note, reject, buddy, answered,
         total_amount, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?)`
    ).run(
      docNo, code, body.nic || '', body.name, body.address || '', body.mobileNo, body.location || '',
      body.agentName || '', num(body.agentCommission), riderChoice(req.user) || body.riderName || '', num(body.riderCommission),
      body.jobType || '', body.jobNoteNo || '', date, body.note || '', body.buddy || '', body.answered || '',
      num(body.totalAmount), req.user.username
    );
    saveItems(docNo, body.nic || '', date, body.items || []);
    if (body.totalAmount === undefined || body.totalAmount === '') {
      db.prepare('UPDATE client_header SET total_amount = 0 WHERE doc_no = ? AND total_amount IS NULL').run(docNo);
    }
  });
  save();
  biz.audit(req.user.username, 'CLIENT', docNo, 'Create job');
  res.json({ docNo, code });
}));

app.put('/api/clients/:docNo', auth, permit('clients:update', 'cashier:update'), asyncRoute((req, res) => {
  const existing = db.prepare('SELECT * FROM client_header WHERE doc_no = ?').get(req.params.docNo);
  if (!existing) return res.status(404).json({ error: 'Job not found' });
  if (existing.status === 1 && req.user.group !== 'SAdmin') {
    return res.status(400).json({ error: 'This job is already finalized' });
  }
  if (!riderOwns(req.user, existing)) return res.status(404).json({ error: 'Job not found' });
  const body = req.body || {};
  const date = body.date || existing.date;
  const riderName = riderChoice(req.user) || (body.riderName ?? existing.rider_name);
  const save = db.transaction(() => {
    db.prepare(
      `UPDATE client_header SET nic = ?, name = ?, address = ?, mobile_no = ?, location = ?,
        agent_name = ?, agent_commission = ?, rider_name = ?, rider_commission = ?, job_type = ?,
        job_note_no = ?, date = ?, note = ?, buddy = ?, answered = ?, total_amount = ?
       WHERE doc_no = ?`
    ).run(
      body.nic ?? existing.nic,
      body.name ?? existing.name,
      body.address ?? existing.address,
      body.mobileNo ?? existing.mobile_no,
      body.location ?? existing.location,
      body.agentName ?? existing.agent_name,
      body.agentCommission !== undefined ? num(body.agentCommission) : existing.agent_commission,
      riderName,
      body.riderCommission !== undefined ? num(body.riderCommission) : existing.rider_commission,
      body.jobType ?? existing.job_type,
      body.jobNoteNo ?? existing.job_note_no,
      date,
      body.note ?? existing.note,
      body.buddy ?? existing.buddy,
      body.answered ?? existing.answered,
      body.totalAmount !== undefined ? num(body.totalAmount) : existing.total_amount,
      req.params.docNo
    );
    if (Array.isArray(body.items)) saveItems(req.params.docNo, body.nic ?? existing.nic, date, body.items);
  });
  save();
  biz.audit(req.user.username, 'CLIENT', req.params.docNo, 'Update job');
  res.json({ ok: true });
}));

app.post('/api/clients/:docNo/reject', auth, permit('clients:update'), (req, res) => {
  const row = db.prepare('SELECT * FROM client_header WHERE doc_no = ?').get(req.params.docNo);
  if (!row) return res.status(404).json({ error: 'Job not found' });
  const reject = db.transaction(() => {
    db.prepare(
      `INSERT INTO client_header_reject
        (doc_no, code, nic, name, address, mobile_no, location, agent_name, agent_commission,
         rider_name, rider_commission, job_type, job_note_no, date, note, buddy, answered,
         total_amount, created_by, rejected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.doc_no, row.code, row.nic, row.name, row.address, row.mobile_no, row.location, row.agent_name,
      row.agent_commission, row.rider_name, row.rider_commission, row.job_type, row.job_note_no, row.date,
      row.note, row.buddy, row.answered, row.total_amount, row.created_by, new Date().toISOString()
    );
    db.prepare('UPDATE client_header SET reject = 1 WHERE doc_no = ?').run(row.doc_no);
  });
  reject();
  biz.audit(req.user.username, 'CLIENT', row.doc_no, 'Reject job');
  res.json({ ok: true });
});

app.delete('/api/clients/:docNo', auth, permit('clients:delete', 'history:delete', 'cashier:delete'), (req, res) => {
  const header = db.prepare('SELECT * FROM client_header WHERE doc_no = ?').get(req.params.docNo);
  if (!header) return res.status(404).json({ error: 'Job not found' });
  const jobs = db.prepare('SELECT job_no FROM finalized WHERE doc_no = ? AND deleted >= 0').all(req.params.docNo);
  const hide = db.transaction(() => {
    db.prepare('UPDATE client_header SET deleted = 1 WHERE doc_no = ?').run(req.params.docNo);
    db.prepare('UPDATE client_items SET deleted = 1 WHERE doc_no = ? AND deleted = 0').run(req.params.docNo);
    db.prepare('UPDATE finalized SET deleted = 1 WHERE doc_no = ? AND deleted = 0').run(req.params.docNo);
    for (const job of jobs) {
      db.prepare('UPDATE main_cash SET deleted = 1 WHERE invoice_no = ? AND deleted = 0').run(job.job_no);
    }
  });
  hide();
  biz.audit(req.user.username, 'CLIENT', req.params.docNo, 'Hide job');
  res.json({ ok: true });
});

function canUploadImages(user) {
  if (!user) return false;
  if (user.group === 'SAdmin') return true;
  if (acl.can(user.group, ['clients:update', 'cashier:update'])) return true;
  return user.group === 'Rider' && acl.can(user.group, ['clients']);
}

app.post('/api/clients/:docNo/images', auth, (req, res, next) => {
  if (!canUploadImages(req.user)) return res.status(403).json({ error: 'Your access list does not include this action' });
  next();
}, upload.single('image'), asyncRoute(async (req, res) => {
  const header = db.prepare('SELECT * FROM client_header WHERE doc_no = ?').get(req.params.docNo);
  if (!header || !riderOwns(req.user, header)) return res.status(404).json({ error: 'Job not found' });
  if (!req.file) return res.status(400).json({ error: 'Choose an image' });
  const contentType = /^image\//.test(req.file.mimetype) ? req.file.mimetype : imageContentType(req.file.originalname);
  if (!contentType) return res.status(400).json({ error: 'Choose an image file' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM client_images WHERE doc_no = ?').get(req.params.docNo).c;
  const stored = await storage.uploadObject({
    buffer: req.file.buffer,
    contentType,
    originalName: req.file.originalname,
    folder: `clients/${req.params.docNo}/images`,
  });
  const info = db.prepare(
    'INSERT INTO client_images (doc_no, nic, date, type, url, img_number, storage_path) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.params.docNo, header.nic, header.date, req.body.type || 'Item', stored.url, count + 1, stored.storagePath);
  res.json({ id: info.lastInsertRowid, url: stored.url, type: req.body.type || 'Item' });
}));

app.get('/api/media/images/:id', auth, permit('clients', 'cashier', 'history', 'approvals', 'reports'), asyncRoute(async (req, res) => {
  const image = db.prepare('SELECT * FROM client_images WHERE id = ?').get(req.params.id);
  if (!image) return res.status(404).json({ error: 'Image not found' });
  if (!image.storage_path) return res.redirect(image.url);
  const file = await storage.readObject(image.storage_path);
  res.set('Content-Type', file.contentType);
  res.set('Cache-Control', 'private, max-age=300');
  res.send(file.buffer);
}));

app.get('/api/media/documents/:id', auth, permit('clients', 'cashier', 'history', 'approvals'), asyncRoute(async (req, res) => {
  const document = db.prepare('SELECT * FROM client_documents WHERE id = ?').get(req.params.id);
  if (!document) return res.status(404).json({ error: 'Document not found' });
  if (!document.storage_path) return res.redirect(document.url);
  const file = await storage.readObject(document.storage_path);
  res.set('Content-Type', file.contentType);
  res.set('Content-Disposition', `inline; filename="${String(document.file_name || 'document').replace(/"/g, '')}"`);
  res.send(file.buffer);
}));

app.delete('/api/clients/:docNo/images/:id', auth, permit('clients:delete', 'cashier:delete'), asyncRoute(async (req, res) => {
  const image = db.prepare('SELECT * FROM client_images WHERE id = ? AND doc_no = ?').get(req.params.id, req.params.docNo);
  if (!image) return res.status(404).json({ error: 'Image not found' });
  await storage.deleteObject(image.storage_path);
  db.prepare('DELETE FROM client_images WHERE id = ?').run(image.id);
  res.json({ ok: true });
}));

app.post('/api/clients/:docNo/documents', auth, permit('clients:update', 'cashier:update'), upload.single('document'), asyncRoute(async (req, res) => {
  const header = db.prepare('SELECT * FROM client_header WHERE doc_no = ?').get(req.params.docNo);
  if (!header) return res.status(404).json({ error: 'Job not found' });
  if (!req.file) return res.status(400).json({ error: 'Choose a document' });
  const stored = await storage.uploadObject({
    buffer: req.file.buffer,
    contentType: req.file.mimetype,
    originalName: req.file.originalname,
    folder: `clients/${req.params.docNo}/documents`,
  });
  const info = db.prepare(
    `INSERT INTO client_documents (doc_no, nic, date, type, file_name, url, storage_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.params.docNo, header.nic, header.date, req.body.type || 'Document',
    req.file.originalname || 'document', stored.url, stored.storagePath, new Date().toISOString()
  );
  res.json({ id: info.lastInsertRowid, url: stored.url, fileName: req.file.originalname });
}));

app.delete('/api/clients/:docNo/documents/:id', auth, permit('clients:delete', 'cashier:delete'), asyncRoute(async (req, res) => {
  const document = db.prepare('SELECT * FROM client_documents WHERE id = ? AND doc_no = ?').get(req.params.id, req.params.docNo);
  if (!document) return res.status(404).json({ error: 'Document not found' });
  await storage.deleteObject(document.storage_path);
  db.prepare('DELETE FROM client_documents WHERE id = ?').run(document.id);
  res.json({ ok: true });
}));

app.get('/api/history', auth, permit('history'), (req, res) => {
  const mode = req.query.mode || 'all';
  const q = String(req.query.q || '').trim();
  let sql = `SELECT doc_no, nic, name, mobile_no, location, agent_name, rider_name, job_type, date, total_amount, status
             FROM client_header WHERE status = 1 AND reject = 0`;
  const params = [];
  if (mode === 'nic') {
    sql += ' AND nic LIKE ?';
    params.push(`%${q}%`);
  } else if (mode === 'mobile') {
    sql += ' AND mobile_no LIKE ?';
    params.push(`%${q}%`);
  } else if (mode === 'location') {
    sql += ' AND location LIKE ?';
    params.push(`%${q}%`);
  } else if (mode === 'rider') {
    sql += ' AND rider_name LIKE ?';
    params.push(`%${q}%`);
  } else if (mode === 'agent') {
    sql += ' AND agent_name LIKE ?';
    params.push(`%${q}%`);
  } else if (mode === 'date') {
    sql += ' AND date >= ? AND date <= ?';
    params.push(req.query.from || today(), req.query.to || today());
  } else if (req.user.group === 'History') {
    return res.json([]);
  }
  sql += ' ORDER BY date DESC, code DESC LIMIT 500';
  res.json(db.prepare(sql).all(...params));
});

function loadOpenJob(where, value) {
  return db.prepare(
    `SELECT * FROM client_header WHERE ${where} = ? AND status = 0 AND reject = 0 ORDER BY code DESC LIMIT 1`
  ).get(value);
}

app.get('/api/cashier/lookup', auth, permit('cashier'), (req, res) => {
  const date = req.query.date || today();
  if (!biz.withinSevenDays(date)) {
    return res.status(400).json({ error: 'Please select a date within the last 7 days', jobNo: null });
  }
  let header = null;
  if (req.query.nic) header = loadOpenJob('nic', String(req.query.nic).trim());
  else if (req.query.mobile) header = loadOpenJob('mobile_no', String(req.query.mobile).trim());
  else if (req.query.docNo) header = db.prepare('SELECT * FROM client_header WHERE doc_no = ?').get(String(req.query.docNo).trim());
  else return res.status(400).json({ error: 'Enter NIC, mobile number, or job number' });
  if (!header) return res.status(404).json({ error: 'No open job found' });
  const items = db.prepare('SELECT * FROM client_items WHERE doc_no = ?').all(header.doc_no);
  const images = db.prepare('SELECT * FROM client_images WHERE doc_no = ?').all(header.doc_no);
  const totals = biz.itemTotals(header.doc_no);
  const commission = biz.agentCommission(totals.totalWeight, header.job_type, header.agent_commission);
  const finalized = db.prepare('SELECT job_no FROM finalized WHERE doc_no = ?').get(header.doc_no);
  res.json({
    job: header,
    items,
    images,
    totals,
    agentCommission: commission,
    suggestedJobNo: biz.nextJobNo(date),
    alreadyFinalized: Boolean(finalized),
  });
});

app.get('/api/cashier/job-no', auth, permit('cashier'), (req, res) => {
  const date = req.query.date || today();
  if (!biz.withinSevenDays(date)) return res.status(400).json({ error: 'Please select a date within the last 7 days' });
  res.json(biz.nextJobNo(date));
});

app.post('/api/cashier/finalize', auth, permit('cashier:create'), asyncRoute((req, res) => {
  const docNo = String(req.body.docNo || '').trim();
  const date = req.body.date || today();
  const amount = num(req.body.amount);
  if (!docNo) bad('Job number is required');
  if (!biz.withinSevenDays(date)) bad('Please select a date within the last 7 days');
  if (amount <= 0) bad('Last value should be entered and confirmed before finalize');
  const header = db.prepare('SELECT * FROM client_header WHERE doc_no = ? AND reject = 0').get(docNo);
  if (!header) return res.status(404).json({ error: 'Job not found' });
  if (header.status === 1) return res.status(400).json({ error: 'This job is already finalized' });
  const totals = biz.itemTotals(docNo);
  const { jobNo, code } = biz.nextJobNo(date);
  const agentCommission = req.body.agentCommission !== undefined
    ? num(req.body.agentCommission)
    : biz.agentCommission(totals.totalWeight, header.job_type, header.agent_commission);
  const riderCommission = req.body.riderCommission !== undefined ? num(req.body.riderCommission) : num(header.rider_commission);
  const save = db.transaction(() => {
    db.prepare(
      `INSERT INTO finalized
        (job_no, nic, mobile_no, agent_name, rider_name, job_type, create_date, finalized_date,
         create_user, cashier, agent_commission, rider_commission, amount, location, item_count,
         total_weight, first_amount, code, doc_no, approved, permission_granted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
    ).run(
      jobNo, header.nic, header.mobile_no, header.agent_name, header.rider_name, header.job_type,
      header.date, date, header.agent_name, req.user.username, agentCommission, riderCommission,
      amount, header.location, totals.itemCount, totals.totalWeight, num(header.total_amount),
      code, docNo
    );
    db.prepare('UPDATE client_header SET status = 1 WHERE doc_no = ?').run(docNo);
    db.prepare('UPDATE call_log SET status = 0 WHERE status IS NULL').run();
    biz.postCash(
      'main_cash',
      today(),
      jobNo,
      `${totals.itemCount}/${totals.totalWeight}${header.location || ''}`,
      amount,
      0,
      ''
    );
  });
  save();
  biz.audit(req.user.username, 'CASHIER', jobNo, 'Finalize');
  res.json({ jobNo, code, agentCommission, riderCommission, totals });
}));

app.post('/api/cashier/cancel', auth, permit('cashier:delete'), (req, res) => {
  const jobNo = String(req.body.jobNo || '').trim();
  const row = db.prepare('SELECT * FROM finalized WHERE job_no = ?').get(jobNo);
  if (!row) return res.status(404).json({ error: 'Finalized job not found' });
  const cancel = db.transaction(() => {
    db.prepare('UPDATE finalized SET deleted = 1 WHERE job_no = ?').run(jobNo);
    db.prepare('UPDATE client_header SET status = 0 WHERE doc_no = ?').run(row.doc_no);
    db.prepare('UPDATE main_cash SET deleted = 1 WHERE invoice_no = ? AND deleted = 0').run(jobNo);
  });
  cancel();
  biz.audit(req.user.username, 'CASHIER', jobNo, 'Cancel finalize');
  res.json({ ok: true, docNo: row.doc_no });
});

app.get('/api/calls', auth, permit('calls'), (req, res) => {
  const contact = String(req.query.contact || '').trim();
  if (!contact) return res.json([]);
  const rows = db.prepare(
    'SELECT * FROM call_log WHERE contact_no = ? ORDER BY id DESC LIMIT 100'
  ).all(contact);
  res.json(rows);
});

app.delete('/api/calls/:id', auth, permit('calls:delete'), (req, res) => {
  db.prepare('UPDATE call_log SET deleted = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/calls', auth, permit('calls:create'), (req, res) => {
  const contact = String(req.body.contactNo || '').trim();
  const reason = String(req.body.reason || '').trim();
  if (!contact || !reason) return res.status(400).json({ error: 'Contact number and comments are required' });
  const now = new Date();
  const info = db.prepare(
    `INSERT INTO call_log (date, contact_no, reason, agent, agent_no, status, call_time)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ).run(today(), contact, reason, req.body.agent || req.user.username, req.body.agentNo || '', now.toLocaleTimeString());
  res.json({ id: info.lastInsertRowid });
});

app.get('/api/assignments', auth, permit('assign'), (_req, res) => {
  res.json(db.prepare('SELECT * FROM mobile_assignments ORDER BY user_name, mobile_no').all());
});

app.delete('/api/assignments/:id', auth, permit('assign:delete'), (req, res) => {
  db.prepare('UPDATE mobile_assignments SET deleted = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/assignments', auth, permit('assign:create'), (req, res) => {
  const userName = String(req.body.userName || '').trim();
  const mobileNo = String(req.body.mobileNo || '').trim();
  if (!userName || !mobileNo) return res.status(400).json({ error: 'User and mobile number are required' });
  const info = db.prepare(
    'INSERT INTO mobile_assignments (date, user_name, mobile_no) VALUES (?, ?, ?)'
  ).run(today(), userName, mobileNo);
  res.json({ id: info.lastInsertRowid });
});

app.post('/api/assignments/replace', auth, permit('assign:update'), (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const save = db.transaction(() => {
    db.prepare('UPDATE mobile_assignments SET deleted = 1 WHERE deleted = 0').run();
    const insert = db.prepare('INSERT INTO mobile_assignments (date, user_name, mobile_no) VALUES (?, ?, ?)');
    for (const row of rows) {
      if (row.userName && row.mobileNo) insert.run(today(), row.userName, row.mobileNo);
    }
  });
  save();
  res.json({ ok: true });
});

app.post('/api/assignments/transfer', auth, permit('assign:update'), (req, res) => {
  const fromUser = String(req.body.fromUser || '').trim();
  const toUser = String(req.body.toUser || '').trim();
  if (!fromUser || !toUser) return res.status(400).json({ error: 'Choose both agents' });
  db.prepare('UPDATE mobile_assignments SET user_name = ? WHERE user_name = ? AND deleted = 0').run(toUser, fromUser);
  res.json({ ok: true });
});

app.get('/api/assignments/mine', auth, permit('calls', 'assign', 'clients'), (req, res) => {
  res.json(db.prepare('SELECT * FROM mobile_assignments WHERE user_name = ?').all(req.user.username));
});

function approvalGuard(req, res) {
  if (req.user.group !== 'SAdmin' && biz.hasOverdueUnapproved()) {
    res.status(403).json({
      error: 'Jobs older than 7 days are still waiting for approval. A super admin must grant permission first.',
    });
    return false;
  }
  return true;
}

app.get('/api/approvals', auth, permit('approvals'), (req, res) => {
  if (!approvalGuard(req, res)) return;
  const date = req.query.date || today();
  const rows = db.prepare(
    `SELECT finalized_date, job_no, nic, mobile_no, agent_name, rider_name, job_type, amount, location,
            approved, permission_granted, doc_no, item_count, total_weight, agent_commission, rider_commission
     FROM finalized WHERE finalized_date = ? ORDER BY job_no`
  ).all(date);
  res.json(rows);
});

app.get('/api/approvals/:jobNo', auth, permit('approvals'), (req, res) => {
  if (!approvalGuard(req, res)) return;
  const row = db.prepare('SELECT * FROM finalized WHERE job_no = ?').get(req.params.jobNo);
  if (!row) return res.status(404).json({ error: 'Job not found' });
  const header = db.prepare('SELECT * FROM client_header WHERE doc_no = ?').get(row.doc_no);
  const items = db.prepare('SELECT * FROM client_items WHERE doc_no = ?').all(row.doc_no);
  const images = db.prepare('SELECT * FROM client_images WHERE doc_no = ?').all(row.doc_no);
  res.json({ finalized: row, header, items, images });
});

app.post('/api/approvals/:jobNo/approve', auth, permit('approvals:update'), (req, res) => {
  if (!approvalGuard(req, res)) return;
  const info = db.prepare(
    'UPDATE finalized SET approved = 1, permission_granted = 1 WHERE job_no = ?'
  ).run(req.params.jobNo);
  if (!info.changes) return res.status(404).json({ error: 'Job not found' });
  biz.audit(req.user.username, 'APPROVAL', req.params.jobNo, 'Approve');
  res.json({ ok: true });
});

app.post('/api/approvals/grant-permission', auth, (req, res) => {
  if (req.user.group !== 'SAdmin') return res.status(403).json({ error: 'Only super admin can grant permission' });
  db.prepare('UPDATE finalized SET permission_granted = 1 WHERE permission_granted = 0').run();
  biz.audit(req.user.username, 'APPROVAL', '*', 'Grant permission');
  res.json({ ok: true });
});

app.get('/api/approvals/dashboard/day', auth, permit('approvals'), (req, res) => {
  if (!approvalGuard(req, res)) return;
  const date = req.query.date || today();
  const jobs = db.prepare('SELECT * FROM finalized WHERE finalized_date = ?').all(date);
  const rate = num(biz.setting('business_commission', '0'));
  const riderRate = num(biz.setting('rider_commission', '0'));
  const xr = jobs.filter((j) => j.job_type === 'XR').reduce((sum, j) => sum + num(j.agent_commission), 0);
  const nr = jobs.filter((j) => j.job_type === 'NR').reduce((sum, j) => sum + num(j.agent_commission), 0);
  const business = biz.round2(rate * jobs.length);
  const rider = biz.round2(jobs.length * riderRate);
  const agent = biz.round2(xr + nr);
  res.json({
    date,
    count: jobs.length,
    businessCommission: business,
    xr: biz.round2(xr),
    nr: biz.round2(nr),
    agentCommission: agent,
    riderCommission: rider,
    balance: biz.round2(business - (nr + xr + rider)),
    rate,
    riderRate,
  });
});

app.get('/api/commission', auth, permit('commission'), (_req, res) => {
  res.json({
    businessCommission: num(biz.setting('business_commission', '0')),
    riderCommission: num(biz.setting('rider_commission', '0')),
  });
});

app.put('/api/commission', auth, permit('commission:update'), (req, res) => {
  if (req.body.businessCommission !== undefined) biz.setSetting('business_commission', num(req.body.businessCommission));
  if (req.body.riderCommission !== undefined) biz.setSetting('rider_commission', num(req.body.riderCommission));
  res.json({
    businessCommission: num(biz.setting('business_commission', '0')),
    riderCommission: num(biz.setting('rider_commission', '0')),
  });
});

app.get('/api/access-codes', auth, permit('access'), (_req, res) => {
  res.json(db.prepare('SELECT id, code, date, created_by FROM daily_codes ORDER BY date DESC LIMIT 60').all());
});

app.delete('/api/access-codes/:id', auth, permit('access:delete'), (req, res) => {
  db.prepare('UPDATE daily_codes SET deleted = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/access-codes', auth, permit('access:create'), (req, res) => {
  const date = req.body.date || today();
  let code = String(req.body.code || '').replace(/\s/g, '');
  if (code.length >= 3 && !code.includes('#')) code = `${code.slice(0, 3)}#${code.slice(3)}`;
  if (code.length < 4) return res.status(400).json({ error: 'Enter an access code of at least 3 characters' });
  const existing = db.prepare('SELECT id FROM daily_codes WHERE date = ?').get(date);
  if (existing) return res.status(400).json({ error: 'An access code already exists for this date' });
  db.prepare('INSERT INTO daily_codes (code, date, created_by) VALUES (?, ?, ?)').run(code, date, req.user.username);
  res.json({ code, date });
});

function normalizeCode(value) {
  return String(value || '').replace(/#/g, '').replace(/\s/g, '').toUpperCase();
}

function requireAccess(req, res) {
  const date = String(req.query.from || req.query.date || today()).slice(0, 10);
  const code = normalizeCode(req.query.code);
  const row = db.prepare('SELECT * FROM daily_codes WHERE date = ?').get(date);
  if (!row) {
    res.status(403).json({ error: `No access code is saved for ${date}. Create one on the Access Code screen first.` });
    return null;
  }
  if (!code || normalizeCode(row.code) !== code) {
    res.status(403).json({ error: `That code does not match the access code saved for ${date}.` });
    return null;
  }
  return date;
}

app.get('/api/reports/bought', auth, permit('reports'), (req, res) => {
  if (!requireAccess(req, res)) return;
  const from = req.query.from || today();
  const to = req.query.to || from;
  const rows = db.prepare(
    `SELECT * FROM finalized WHERE finalized_date >= ? AND finalized_date <= ? ORDER BY finalized_date, job_no`
  ).all(from, to);
  res.json(rows);
});

app.get('/api/reports/summary', auth, permit('reports'), (req, res) => {
  if (!requireAccess(req, res)) return;
  const from = req.query.from || today();
  const to = req.query.to || from;
  const rows = db.prepare(
    `SELECT job_type, COUNT(*) AS jobs, COALESCE(SUM(amount), 0) AS amount,
            COALESCE(SUM(total_weight), 0) AS weight, COALESCE(SUM(agent_commission), 0) AS agent_commission
     FROM finalized WHERE finalized_date >= ? AND finalized_date <= ?
     GROUP BY job_type`
  ).all(from, to);
  res.json(rows);
});

app.get('/api/reports/main-cash', auth, permit('reports'), (req, res) => {
  if (!requireAccess(req, res)) return;
  const date = req.query.from || today();
  const opening = ensureOpening(date);
  const rows = db.prepare('SELECT * FROM main_cash WHERE date = ? ORDER BY id').all(date);
  res.json({ opening, rows });
});

app.get('/api/reports/petty-cash', auth, permit('reports'), (req, res) => {
  if (!requireAccess(req, res)) return;
  const date = req.query.from || today();
  res.json(db.prepare('SELECT * FROM petty_cash WHERE date = ? ORDER BY id').all(date));
});

app.get('/api/reports/journal', auth, permit('reports'), (req, res) => {
  if (!requireAccess(req, res)) return;
  const from = req.query.from || today();
  const to = req.query.to || from;
  res.json(db.prepare('SELECT * FROM journal WHERE date >= ? AND date <= ? ORDER BY id').all(from, to));
});

app.get('/api/reports/chart', auth, permit('reports'), (req, res) => {
  if (!requireAccess(req, res)) return;
  res.json(db.prepare(
    `SELECT a.code, a.name, g.description AS group_name, s.description AS subtype_name, a.normal_balance, a.opening, a.settings
     FROM accounts a
     LEFT JOIN account_groups g ON g.code = a.group_code
     LEFT JOIN account_subtypes s ON s.code = a.subtype_code
     WHERE a.deleted = 0
     ORDER BY a.code`
  ).all());
});

app.get('/api/reports/:type/data', auth, permit('reports'), (req, res) => {
  if (req.params.type !== 'approve' && !requireAccess(req, res)) return;
  res.json(collectReport(req.params.type, req.query));
});

app.get('/api/reports/:type/pdf', auth, permit('reports'), asyncRoute(async (req, res) => {
  if (req.params.type !== 'approve' && !requireAccess(req, res)) return;
  const pdf = await buildPdf(req.params.type, req.query);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${req.params.type}.pdf"`);
  res.send(pdf);
}));

app.get('/api/users', auth, permit('users'), (_req, res) => {
  res.json(db.prepare(
    'SELECT id, username, title, group_code, active, company FROM users ORDER BY username'
  ).all());
});

app.delete('/api/users/:id', auth, permit('users:delete'), (req, res) => {
  if (String(req.user.id) === String(req.params.id)) return res.status(400).json({ error: 'You cannot remove your own login' });
  db.prepare('UPDATE users SET deleted = 1, active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

const USER_GROUPS = new Set([...acl.ROLES, 'SAdmin']);

app.put('/api/users/:id', auth, permit('users:update'), (req, res) => {
  const group = String(req.body.group || '').trim();
  if (!USER_GROUPS.has(group)) return res.status(400).json({ error: 'Choose a valid role' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET group_code = ? WHERE id = ?').run(group, req.params.id);
  biz.audit(req.user.username, 'USER', req.params.id, `Assign ${group}`);
  res.json({ ok: true, group });
});

app.post('/api/users', auth, permit('users:create'), asyncRoute((req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const group = String(req.body.group || '').trim();
  if (!USER_GROUPS.has(group)) bad('Choose a valid role');
  if (!username || !password || !group) bad('Username, password, and category are required');
  if (password.length < 4) bad('Password must be at least 4 characters');
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(400).json({ error: 'That username already exists' });
  const info = db.prepare(
    `INSERT INTO users (username, password_hash, title, group_code, active, company, station_id)
     VALUES (?, ?, ?, ?, 1, 'Gold Store', 'Gold Store')`
  ).run(username, bcrypt.hashSync(password, 10), req.body.title || username, group);
  res.json({ id: info.lastInsertRowid });
}));

app.get('/api/accounts', auth, permit('accounts'), (_req, res) => {
  res.json({
    groups: db.prepare('SELECT * FROM account_groups ORDER BY code').all(),
    subtypes: db.prepare('SELECT * FROM account_subtypes ORDER BY code').all(),
    accounts: db.prepare(
      `SELECT a.*, g.description AS group_name, s.description AS subtype_name
       FROM accounts a
       LEFT JOIN account_groups g ON g.code = a.group_code
       LEFT JOIN account_subtypes s ON s.code = a.subtype_code
       WHERE a.deleted = 0
       ORDER BY a.code`
    ).all(),
  });
});

app.delete('/api/accounts/:code', auth, permit('accounts:delete'), (req, res) => {
  db.prepare('UPDATE accounts SET deleted = 1 WHERE code = ?').run(req.params.code);
  res.json({ ok: true });
});

app.post('/api/accounts', auth, permit('accounts:create'), (req, res) => {
  const name = String(req.body.name || '').trim();
  const groupCode = String(req.body.groupCode || '').trim();
  const subtypeCode = String(req.body.subtypeCode || '').trim();
  if (!name || !groupCode) return res.status(400).json({ error: 'Account name and type are required' });
  const max = db.prepare('SELECT MAX(code) AS code FROM accounts WHERE group_code = ?').get(groupCode);
  let code = req.body.code ? String(req.body.code) : '';
  if (!code) {
    if (max && max.code) code = String(Number(max.code) + 1);
    else code = `${groupCode}1`;
  }
  const normal = ['100000', '150000', '350000'].includes(groupCode) ? 'Debit' : 'Credit';
  db.prepare(
    `INSERT INTO accounts (code, name, group_code, subtype_code, normal_balance, opening, payable_acc, settings, bank_name, bank_account, company)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'Gold Store')`
  ).run(code, name, groupCode, subtypeCode, normal, num(req.body.opening), req.body.payableAcc || '', req.body.bankName || '', req.body.bankAccount || '');
  res.json({ code });
});

app.put('/api/accounts/:code', auth, permit('accounts:update'), (req, res) => {
  db.prepare('UPDATE accounts SET name = ?, payable_acc = COALESCE(?, payable_acc) WHERE code = ?').run(
    String(req.body.name || '').trim(),
    req.body.payableAcc,
    req.params.code
  );
  res.json({ ok: true });
});

app.put('/api/accounts/settings/map', auth, permit('accounts:update'), (req, res) => {
  const role = String(req.body.settings || '').trim();
  const code = String(req.body.code || '').trim();
  if (!role || !code) return res.status(400).json({ error: 'Choose a role and an account' });
  const save = db.transaction(() => {
    db.prepare('UPDATE accounts SET settings = \'\' WHERE settings = ?').run(role);
    db.prepare('UPDATE accounts SET settings = ? WHERE code = ?').run(role, code);
  });
  save();
  res.json({ ok: true });
});

app.get('/api/journal/next', auth, permit('accounts'), (_req, res) => {
  res.json(biz.nextDoc('JOU', 'journal', 'id'));
});

app.get('/api/journal', auth, permit('accounts'), (req, res) => {
  const glNo = String(req.query.glNo || '');
  if (!glNo) return res.json([]);
  res.json(db.prepare('SELECT * FROM journal WHERE gl_no = ? ORDER BY id').all(glNo));
});

app.delete('/api/journal/:id', auth, permit('accounts:delete'), (req, res) => {
  db.prepare('UPDATE journal SET deleted = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/journal', auth, permit('accounts:create'), (req, res) => {
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  if (!lines.length) return res.status(400).json({ error: 'Add at least one journal line' });
  const date = req.body.date || today();
  const { number } = biz.nextDoc('JOU', 'journal', 'id');
  const glNo = req.body.glNo || number;
  const save = db.transaction(() => {
    for (const line of lines) {
      const debit = num(line.debit);
      const credit = num(line.credit);
      if (debit === 0 && credit === 0) continue;
      biz.postJournal({
        glNo,
        description: line.description || line.name || '',
        remarks: line.remarks || req.body.remarks || '',
        amount: debit !== 0 ? debit : credit,
        date,
        user: req.user.username,
        dc: debit !== 0 ? 'D' : 'C',
        accNo: line.accNo || line.code || '',
        docNo: glNo,
        accountName: line.name || '',
        glType: 'Jou',
      });
    }
  });
  save();
  biz.audit(req.user.username, 'JOURNAL', glNo, 'Post journal');
  res.json({ glNo });
});

app.delete('/api/cash/:book/:id', auth, permit('transfer:delete', 'expenses:delete'), (req, res) => {
  const table = req.params.book === 'petty' ? 'petty_cash' : 'main_cash';
  db.prepare(`UPDATE ${table} SET deleted = 1 WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/cash/transfer', auth, permit('transfer:create'), (req, res) => {
  const from = String(req.body.from || '');
  const to = String(req.body.to || '');
  const amount = num(req.body.amount);
  const date = req.body.date || today();
  const desc = req.body.description || `Transfer ${from} to ${to}`;
  if (!from || !to || from === to) return res.status(400).json({ error: 'Choose two different cash accounts' });
  if (amount <= 0) return res.status(400).json({ error: 'Enter a transfer amount' });
  const allowed = new Set(['15001', '15002', '15003']);
  if (!allowed.has(from) || !allowed.has(to)) return res.status(400).json({ error: 'Unknown cash account' });
  const save = db.transaction(() => {
    if (to === '15002') biz.postCash('main_cash', date, '', desc, 0, amount, `From ${from}`);
    if (from === '15002') biz.postCash('main_cash', date, '', desc, amount, 0, `To ${to}`);
    if (to === '15003') biz.postCash('petty_cash', date, '', desc, 0, amount, `From ${from}`);
    if (from === '15003') biz.postCash('petty_cash', date, '', desc, amount, 0, `To ${to}`);
  });
  save();
  res.json({ ok: true });
});

app.get('/api/cash/petty', auth, permit('expenses'), (req, res) => {
  const date = req.query.date || today();
  res.json(db.prepare('SELECT * FROM petty_cash WHERE date = ? ORDER BY id').all(date));
});

app.post('/api/cash/petty', auth, permit('expenses:create'), (req, res) => {
  const date = req.body.date || today();
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  const save = db.transaction(() => {
    db.prepare('UPDATE petty_cash SET deleted = 1 WHERE date = ? AND description = ? AND deleted = 0').run(date, 'Expenses');
    for (const line of lines) {
      const amount = num(line.amount);
      if (amount <= 0) continue;
      biz.postCash('petty_cash', date, '', 'Expenses', amount, 0, line.remarks || line.description || '');
    }
  });
  save();
  res.json({ ok: true });
});

app.delete('/api/notes/:kind/:id', auth, permit('accounts:delete'), (req, res) => {
  const table = req.params.kind === 'credit' ? 'credit_notes' : 'debit_notes';
  db.prepare(`UPDATE ${table} SET deleted = 1 WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/notes/debit', auth, permit('accounts:create'), (req, res) => {
  const amount = num(req.body.amount);
  const date = req.body.date || today();
  if (!req.body.supplierAcc || !req.body.expenseAcc) return res.status(400).json({ error: 'Choose both accounts' });
  if (amount <= 0) return res.status(400).json({ error: 'Enter an amount' });
  let vat = 0;
  let expenseAmount = amount;
  if (String(req.body.taxType || '').toUpperCase() === 'VAT') {
    vat = biz.round2(amount * 0.08);
    expenseAmount = biz.round2(amount - vat);
  }
  const { code, number } = biz.nextDoc('DN', 'debit_notes', 'doc_code');
  const save = db.transaction(() => {
    db.prepare(
      `INSERT INTO debit_notes (doc_code, note_no, date, debit_acc, credit_acc, amount, vat, setoff_inv, tax_type, user_name, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(code, number, date, req.body.supplierAcc, req.body.expenseAcc, amount, vat, req.body.setoffInv || '', req.body.taxType || '', req.user.username, req.body.remarks || '');
    biz.postJournal({
      glNo: number, description: 'Debit Note', remarks: 'Debit Note', amount, date,
      user: req.user.username, dc: 'D', accNo: req.body.supplierAcc, docNo: number,
      accountName: req.body.supplierName || '', glType: 'DN',
    });
    biz.postJournal({
      glNo: number, description: 'Debit Note', remarks: 'Debit Note', amount: expenseAmount, date,
      user: req.user.username, dc: 'C', accNo: req.body.expenseAcc, docNo: number,
      accountName: req.body.expenseName || '', glType: 'DN',
    });
  });
  save();
  res.json({ noteNo: number, vat, expenseAmount });
});

app.post('/api/notes/credit', auth, permit('accounts:create'), (req, res) => {
  const amount = num(req.body.amount);
  const date = req.body.date || today();
  if (!req.body.supplierAcc || !req.body.expenseAcc) return res.status(400).json({ error: 'Choose both accounts' });
  if (amount <= 0) return res.status(400).json({ error: 'Enter an amount' });
  const { code, number } = biz.nextDoc('CR', 'credit_notes', 'doc_code');
  const save = db.transaction(() => {
    db.prepare(
      `INSERT INTO credit_notes (doc_code, note_no, date, debit_acc, credit_acc, amount, setoff_inv, user_name, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(code, number, date, req.body.expenseAcc, req.body.supplierAcc, amount, req.body.setoffInv || '', req.user.username, req.body.remarks || '');
    biz.postJournal({
      glNo: number, description: 'Credit Note', remarks: 'Voucher', amount, date,
      user: req.user.username, dc: 'C', accNo: req.body.supplierAcc, docNo: number,
      accountName: req.body.supplierName || '', glType: 'CR',
    });
    biz.postJournal({
      glNo: number, description: 'Credit Note', remarks: 'Voucher', amount, date,
      user: req.user.username, dc: 'D', accNo: req.body.expenseAcc, docNo: number,
      accountName: req.body.expenseName || '', glType: 'CR',
    });
  });
  save();
  res.json({ noteNo: number });
});

app.get('/api/notes', auth, permit('accounts'), (_req, res) => {
  res.json({
    debit: db.prepare('SELECT * FROM debit_notes ORDER BY id DESC LIMIT 50').all(),
    credit: db.prepare('SELECT * FROM credit_notes ORDER BY id DESC LIMIT 50').all(),
  });
});

const webDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

app.listen(PORT, HOST, () => {
  console.log(`Gold Store API listening on http://${HOST}:${PORT}`);
});
