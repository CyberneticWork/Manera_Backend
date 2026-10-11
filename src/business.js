const { db, today, addDays } = require('./db');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Agent commission copied from the desktop Cashier screen.
 * Under 16g the original condition can never match (job type cannot be XR and NR).
 * Any result below 1500 is then raised to 1500. XR above 100g stays at 2000.
 */
function agentCommission(weight, jobType, current) {
  let amount = Number(current) || 0;
  const w = Number(weight) || 0;
  const job = String(jobType || '').toUpperCase();
  if (w < 16) {
    if (job === 'XR' && job === 'NR') amount = 500;
  } else if (w > 16 && w <= 40) {
    if (job === 'XR') amount = 650;
    else if (job === 'NR') amount = 500;
  } else if (w > 40 && w <= 100) {
    if (job === 'XR') amount = 1000;
    else if (job === 'NR') amount = 850;
  } else if (w > 100) {
    if (job === 'XR') amount = 2000;
    else if (job === 'NR') amount = 1500;
  }
  if (amount < 1500) amount = 1500;
  return round2(amount);
}

function nextDocNo() {
  const row = db.prepare('SELECT MAX(code) AS maxCode FROM client_header').get();
  const code = (row && row.maxCode != null ? Number(row.maxCode) : 0) + 1;
  return { docNo: String(code), code };
}

function nextJobNo(dateStr) {
  const [y, m, d] = dateStr.split('-');
  const ymd = `${y}${m}${d}`;
  const row = db.prepare('SELECT MAX(code) AS maxCode FROM finalized WHERE finalized_date = ?').get(dateStr);
  if (!row || row.maxCode == null) {
    return { jobNo: `${ymd}01`, code: 1 };
  }
  const code = Number(row.maxCode) + 1;
  return { jobNo: `${ymd}0${code}`, code };
}

function withinSevenDays(dateStr) {
  const selected = new Date(`${dateStr}T00:00:00`);
  const start = new Date(`${addDays(today(), -7)}T00:00:00`);
  const end = new Date(`${today()}T00:00:00`);
  return selected >= start && selected <= end;
}

function setting(key, fallback = '') {
  const row = db.prepare('SELECT `value` FROM settings WHERE `key` = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?'
  ).run(key, String(value), String(value));
}

function itemTotals(docNo) {
  const row = db.prepare(
    'SELECT COUNT(*) AS itemCount, COALESCE(SUM(weight), 0) AS totalWeight FROM client_items WHERE doc_no = ?'
  ).get(docNo);
  return {
    itemCount: row.itemCount || 0,
    totalWeight: round2(row.totalWeight || 0),
  };
}

function hasOverdueUnapproved() {
  const cutoff = addDays(today(), -8);
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM finalized
     WHERE finalized_date <= ? AND approved = 0 AND permission_granted = 0`
  ).get(cutoff);
  return row.c > 0;
}

function audit(user, menu, ref, action) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  db.prepare(
    'INSERT INTO audit_log (menu_code, ref_code, user_name, action, log_date, log_time) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(menu, ref, user, action, date, time);
}

function postCash(table, date, invoiceNo, description, debit, credit, remarks) {
  const month = new Date(`${date}T00:00:00`).toLocaleString('en-US', { month: 'long' });
  db.prepare(
    `INSERT INTO ${table} (date, invoice_no, description, debit, credit, remarks, month)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(date, invoiceNo || '', description || '', round2(debit), round2(credit), remarks || '', month);
}

function postJournal({ glNo, description, remarks, amount, date, user, dc, accNo, docNo, accountName, glType }) {
  db.prepare(
    `INSERT INTO journal
      (gl_no, description, remarks, amount, date, user_name, dc, gl_type, acc_no, doc_no, account_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(glNo, description, remarks || '', round2(amount), date, user, dc, glType, accNo, docNo || '', accountName || '');
}

function nextDoc(prefix, table, column) {
  const row = db.prepare(`SELECT MAX(${column}) AS maxCode FROM ${table}`).get();
  const code = (row && row.maxCode != null ? Number(row.maxCode) : 0) + 1;
  const now = new Date();
  const period = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  return { code, number: `${prefix}${period}${String(code).padStart(4, '0')}` };
}

module.exports = {
  round2,
  agentCommission,
  nextDocNo,
  nextJobNo,
  withinSevenDays,
  setting,
  setSetting,
  itemTotals,
  hasOverdueUnapproved,
  audit,
  postCash,
  postJournal,
  nextDoc,
};
