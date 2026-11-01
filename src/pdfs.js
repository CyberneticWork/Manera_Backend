const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { db, ensureOpening } = require('./db');
const biz = require('./business');

const uploadDir = path.join(__dirname, '..', 'uploads');
const reportSun = path.join(__dirname, '..', 'assets', 'report-sun.png');
const reportWordmark = path.join(__dirname, '..', 'assets', 'report-wordmark.png');

const TITLES = {
  bought: ['Bought Products', 'BoughtProduct.rpt'],
  'bought-url': ['Bought Products with Photos', 'BoughtProducturl.rpt'],
  approve: ['Bought Product Approval', 'BoughtProductApprove.rpt'],
  summary: ['Product Summary', 'ProductSummery.rpt'],
  'main-cash': ['Main Cash Daily', 'MainCashDily.rpt'],
  'petty-cash': ['Bank Book', 'Bank Book.rpt'],
  journal: ['Journal Entries', 'Journal_Entries.rpt'],
  chart: ['Chart of Accounts', 'Chartofacc.rpt'],
  'expenses-daily': ['Expenses Daily', 'ExpencesDaily.rpt'],
  'expenses-month': ['Expenses Month Wise', 'ExpencesMonthWise.rpt'],
};

function money(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pretty(iso) {
  const text = String(iso || '').slice(0, 10);
  if (!text) return '';
  const date = new Date(`${text}T00:00:00`);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function companyLine() {
  const name = biz.setting('company_name', 'Gold Store');
  const address = biz.setting('company_address', '');
  const phone = biz.setting('company_phone', '');
  return [name, address, phone].filter(Boolean).join('  ·  ');
}

function render(draw, options = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: options.margin ?? 36, bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    draw(doc);
    if (!options.plain) {
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font('Helvetica').fontSize(8).fillColor('#6b6256')
          .text('Sooryawansha Group', 36, doc.page.height - 24, { width: 220, lineBreak: false });
        doc.text(`Page ${i + 1} of ${range.count}`, doc.page.width - 160, doc.page.height - 24, {
          width: 124, align: 'right', lineBreak: false,
        });
        doc.page.margins.bottom = bottom;
      }
    }
    doc.end();
  });
}

function banner(doc, title, subtitle) {
  doc.save();
  doc.rect(0, 0, doc.page.width, 72).fill('#0e3d4a');
  doc.restore();
  doc.fillColor('#f4efe6').font('Helvetica-Bold').fontSize(12)
    .text('SOORYAWANSHA GROUP', 36, 14, { width: 260, lineBreak: false });
  doc.fillColor('#d4b483').font('Helvetica').fontSize(8)
    .text(companyLine(), 36, 32, { width: 280 });
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(13)
    .text(title, 300, 16, { width: 260, align: 'right' });
  doc.fillColor('#d4b483').font('Helvetica').fontSize(8)
    .text(subtitle, 300, 36, { width: 260, align: 'right' });
  doc.y = 88;
  doc.fillColor('#1c1408');
}

function paintPairRow(doc, left, right) {
  const gap = 16;
  const width = (doc.page.width - 72 - gap) / 2;
  const y = doc.y;
  const block = (pair, x) => {
    if (!pair) return 0;
    doc.font('Helvetica').fontSize(8);
    const labelHeight = doc.heightOfString(String(pair[0]), { width });
    doc.font('Helvetica-Bold').fontSize(10);
    const valueHeight = doc.heightOfString(String(pair[1] || '—'), { width });
    doc.font('Helvetica').fontSize(8).fillColor('#6b5a40').text(String(pair[0]), x, y, { width });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1c1408').text(String(pair[1] || '—'), x, y + labelHeight, { width });
    return labelHeight + valueHeight + 8;
  };
  const height = Math.max(block(left, 36), block(right, 36 + width + gap));
  doc.y = y + height;
}

function table(doc, columns, rows) {
  const startX = 36;
  const width = doc.page.width - 72;
  const colW = columns.map((column) => width * column.w);

  const head = () => {
    const y = doc.y;
    doc.save();
    doc.rect(startX, y, width, 16).fill('#0e3d4a');
    doc.restore();
    let x = startX + 4;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#f4efe6');
    columns.forEach((column, index) => {
      doc.text(column.label, x, y + 4, { width: colW[index] - 8, align: column.align || 'left', lineBreak: false });
      x += colW[index];
    });
    doc.y = y + 16;
    doc.fillColor('#1c1408');
  };

  head();
  if (!rows.length) {
    doc.font('Helvetica').fontSize(9).fillColor('#6b6256').text('No records for this period.', startX, doc.y + 8);
    doc.moveDown();
    return;
  }

  rows.forEach((row, index) => {
    doc.font('Helvetica').fontSize(8);
    const heights = columns.map((column, col) => doc.heightOfString(String(row[col] ?? ''), { width: colW[col] - 8 }));
    const rowHeight = Math.max(16, ...heights.map((h) => h + 8));
    if (doc.y + rowHeight > doc.page.height - 46) {
      doc.addPage();
      doc.y = 48;
      head();
    }
    const y = doc.y;
    if (index % 2 === 0) {
      doc.save();
      doc.rect(startX, y, width, rowHeight).fill('#f6f3ec');
      doc.restore();
    }
    let x = startX + 4;
    doc.font('Helvetica').fontSize(8).fillColor('#1c1408');
    columns.forEach((column, col) => {
      doc.text(String(row[col] ?? ''), x, y + 4, { width: colW[col] - 8, align: column.align || 'left' });
      x += colW[col];
    });
    doc.y = y + rowHeight;
  });
  doc.moveDown(0.4);
}

function jobQuery(jobNo, from, to) {
  const sql = `
    SELECT f.*, h.name, h.address, h.note, h.job_note_no, h.buddy, h.date AS client_date
    FROM finalized f
    LEFT JOIN client_header h ON h.doc_no = f.doc_no
  `;
  if (jobNo) {
    const key = String(jobNo).trim();
    return db.prepare(
      `${sql} WHERE f.deleted = 0 AND (h.doc_no IS NULL OR h.deleted = 0) AND (f.job_no = ? OR f.doc_no = ? OR CAST(f.code AS CHAR) = ? OR h.job_note_no = ?)`
    ).all(key, key, key, key);
  }
  return db.prepare(`${sql} WHERE f.deleted = 0 AND (h.doc_no IS NULL OR h.deleted = 0) AND f.finalized_date >= ? AND f.finalized_date <= ? ORDER BY f.finalized_date, f.job_no`).all(from, to);
}

function notFinalizedNote(jobNo, from, to) {
  if (jobNo) {
    const row = db.prepare(
      `SELECT doc_no, job_note_no, date, status, reject
       FROM client_header
       WHERE doc_no = ? OR job_note_no = ? OR CAST(code AS CHAR) = ?
       ORDER BY date DESC LIMIT 1`
    ).get(jobNo, jobNo, jobNo);
    if (!row) return '';
    const label = row.job_note_no || row.doc_no;
    if (row.reject) return ` Client job ${label} was rejected, so it was not bought.`;
    if (Number(row.status) !== 1) {
      return ` Client job ${label} is on ${pretty(row.date)} but the cashier has not finalized it yet. Bought products only include paid jobs.`;
    }
    return '';
  }
  const waiting = db.prepare(
    `SELECT job_note_no, doc_no FROM client_header
     WHERE status = 0 AND reject = 0 AND date >= ? AND date <= ?
     ORDER BY doc_no`
  ).all(from, to);
  if (!waiting.length) return '';
  const names = waiting.map((row) => row.job_note_no || row.doc_no).join(', ');
  return ` These client jobs are on the dates but are still waiting for the cashier: ${names}.`;
}

function bundle(row) {
  const items = row.doc_no
    ? db.prepare('SELECT * FROM client_items WHERE doc_no = ? ORDER BY id').all(row.doc_no)
    : [];
  const images = row.doc_no
    ? db.prepare('SELECT * FROM client_images WHERE doc_no = ? ORDER BY img_number, id').all(row.doc_no)
    : [];
  return { row, items, images };
}

function slashDate(iso) {
  const text = String(iso || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.replace(/-/g, '/') : text;
}

function crystalCode(code) {
  const raw = String(code ?? '').trim().replace(/#/g, '');
  if (!raw) return '';
  const body = raw.length > 3 ? `${raw.slice(0, 3)}#${raw.slice(3)}` : raw;
  return `(${body})`;
}

function printStamp() {
  const now = new Date();
  const z = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${z(now.getMonth() + 1)}-${z(now.getDate())}`;
  let hour = now.getHours();
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return { date, time: `${hour}:${z(now.getMinutes())}:${z(now.getSeconds())}${suffix}` };
}

function openMargins(doc) {
  doc.page.margins.top = 0;
  doc.page.margins.bottom = 0;
  doc.page.margins.left = 0;
  doc.page.margins.right = 0;
}

function boughtFooter(doc, jobNo, user, pageNo, stamp) {
  openMargins(doc);
  const y = doc.page.height - 30;
  doc.font('Helvetica').fontSize(8).fillColor('#000000');
  doc.text(`User:   ${user || ''}`, 18, y, { width: 150, lineBreak: false });
  doc.text(`Job No:   ${jobNo || ''}`, 150, y, { width: 150, lineBreak: false });
  doc.text(`Print Time:   ${stamp.time}`, 290, y, { width: 140, lineBreak: false });
  doc.text(`Print Date :   ${stamp.date}`, 420, y, { width: 120, lineBreak: false });
  doc.text(`Page No :  ${pageNo}`, 530, y, { width: 60, lineBreak: false });
  doc.text('Report Generated By - Cybernetic Software Solutions', 18, doc.page.height - 16, {
    width: 420, lineBreak: false,
  });
}

function labelValue(doc, label, value, x, y, labelW, valueW, align) {
  doc.font('Helvetica').fontSize(9).fillColor('#000000');
  if (label) doc.text(String(label), x, y, { width: labelW, lineBreak: false });
  doc.text(String(value || ''), x + labelW, y, {
    width: valueW, align: align || 'left', lineBreak: false,
  });
}

function photoFiles(images) {
  return (images || [])
    .map((image) => ({ image, file: localImage(image.url) }))
    .filter((item) => item.file || item.image.buffer);
}

function drawPhotoCell(doc, item, x, y, w, h) {
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000')
    .text(String(item.image.type || 'PHOTO').toUpperCase(), x, y, { width: w, align: 'center', lineBreak: false });
  const top = y + 12;
  const boxH = Math.max(20, h - 14);
  doc.save();
  doc.lineWidth(0.6).strokeColor('#000000').rect(x, top, w, boxH).stroke();
  doc.restore();
  try {
    doc.image(item.image.buffer || item.file, x + 3, top + 3, {
      fit: [w - 6, boxH - 6],
      align: 'center',
      valign: 'center',
    });
  } catch {
    doc.font('Helvetica').fontSize(8).fillColor('#444444')
      .text('This photo could not be printed', x + 8, top + 10, { width: w - 16 });
  }
}

function drawPhotoGrid(doc, slice, top, bottom) {
  const margin = 16;
  const gapX = 14;
  const gapY = 10;
  const colW = (doc.page.width - margin * 2 - gapX) / 2;
  const rowH = (bottom - top - gapY) / 2;
  slice.forEach((item, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    drawPhotoCell(
      doc,
      item,
      margin + col * (colW + gapX),
      top + row * (rowH + gapY),
      colW,
      rowH,
    );
  });
}

function drawBoughtCrystal(doc, packed, printedBy) {
  const { row, images } = packed;
  const files = photoFiles(images);
  const stamp = printStamp();
  const user = printedBy || row.cashier || '';
  const jobNo = row.job_no || '';
  const pages = Math.max(1, Math.ceil(files.length / 4) || 1);
  const footerReserve = 50;

  for (let page = 0; page < pages; page += 1) {
    if (page > 0) doc.addPage({ size: 'A4', margin: 0 });
    openMargins(doc);
    const slice = files.slice(page * 4, page * 4 + 4);
    let top = 14;
    if (page === 0) {
      doc.image(reportSun, 32.4, 8.3, { width: 36, height: 36 });
      doc.image(reportWordmark, 74.4, 8.3, { width: 90, height: 36 });
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000')
        .text('Bought Products Report', 207, 26, { lineBreak: false });
      const date = slashDate(row.client_date || row.create_date || row.finalized_date);
      labelValue(doc, 'Date', date, 446, 14, 66, 80);
      labelValue(doc, 'Document No', jobNo, 446, 30, 74, 80);
      labelValue(doc, 'Code', crystalCode(row.code), 446, 46, 90, 80);

      const rider = [row.rider_name, row.buddy]
        .map((part) => String(part || '').trim())
        .filter((part, index, list) => part && list.indexOf(part) === index)
        .join('/');
      const lines = [
        ['Customer Name', row.name || '', 'Rider/Budy', rider, false],
        ['NIC', row.nic || '', 'Call Agent', row.agent_name || '', false],
        ['Tel No', row.mobile_no || '', 'First Value', money(row.first_amount), true],
      ];
      let y = 62;
      lines.forEach(([leftLabel, leftValue, rightLabel, rightValue, moneyLine]) => {
        labelValue(doc, leftLabel, leftValue, 32, y, 109, 190);
        labelValue(doc, rightLabel, rightValue, 362, y, moneyLine ? 78 : 180, moneyLine ? 132 : 70, moneyLine ? 'right' : 'left');
        y += 12;
      });
      if (row.address) {
        labelValue(doc, '', row.address, 32, y, 109, 190);
        labelValue(doc, 'Final Value', money(row.amount), 362, y, 78, 132, 'right');
        y += 12;
        labelValue(doc, 'Location', row.location || '', 32, y, 109, 190);
        y += 12;
      } else {
        labelValue(doc, 'Location', row.location || '', 32, y, 109, 190);
        labelValue(doc, 'Final Value', money(row.amount), 362, y, 78, 132, 'right');
        y += 12;
      }
      top = y + 6;
    }
    if (slice.length) drawPhotoGrid(doc, slice, top, doc.page.height - footerReserve);
    boughtFooter(doc, jobNo, user, page + 1, stamp);
  }
}

function localImage(url) {
  if (!url || !String(url).startsWith('/uploads/')) return null;
  const file = path.join(uploadDir, path.basename(url));
  return fs.existsSync(file) ? file : null;
}

function drawJob(doc, packed, options) {
  const { row, items, images } = packed;
  if (doc.y > 120) {
    doc.addPage();
  }
  banner(doc, options.title, `${options.source}    Job ${row.job_no}`);
  if (options.approve) {
    const approved = Number(row.approved) === 1;
    const y = 104;
    doc.save();
    doc.roundedRect(doc.page.width - 140, y, 104, 18, 3).fill(approved ? '#1e7a4a' : '#8a5a12');
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff')
      .text(approved ? 'APPROVED' : 'PENDING', doc.page.width - 140, y + 4, { width: 104, align: 'center', lineBreak: false });
    doc.y = 128;
    doc.fillColor('#1c1408');
  }
  paintPairRow(doc, ['Job no', row.job_no], ['Finalized date', pretty(row.finalized_date)]);
  paintPairRow(doc, ['Customer', row.name], ['NIC', row.nic]);
  paintPairRow(doc, ['Mobile', row.mobile_no], ['Location', row.location]);
  paintPairRow(doc, ['Address', row.address], ['Job type', row.job_type]);
  paintPairRow(doc, ['Agent', row.agent_name], ['Agent commission', money(row.agent_commission)]);
  paintPairRow(doc, ['Rider', row.rider_name], ['Rider commission', money(row.rider_commission)]);
  paintPairRow(doc, ['Cashier', row.cashier], ['Job note', row.job_note_no]);
  if (row.note) {
    doc.font('Helvetica').fontSize(8).fillColor('#6b5a40').text('Note', 36, doc.y, { width: 500 });
    doc.font('Helvetica').fontSize(10).fillColor('#1c1408').text(String(row.note), 36, doc.y, { width: doc.page.width - 72 });
    doc.moveDown(0.4);
  }

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0e3d4a').text('Items', 36, doc.y);
  doc.moveDown(0.3);
  table(
    doc,
    [
      { label: 'Category', w: 0.16 },
      { label: 'Item', w: 0.18 },
      { label: 'Condition', w: 0.14 },
      { label: 'Weight (g)', w: 0.14, align: 'right' },
      { label: 'Rate', w: 0.12 },
      { label: 'Description', w: 0.26 },
    ],
    items.map((item) => [
      item.category, item.item_name, item.condition, money(item.weight), item.rate, item.description,
    ])
  );

  const boxY = doc.y + 4;
  if (boxY > doc.page.height - 80) doc.addPage();
  const y = Math.max(doc.y, 48);
  doc.save();
  doc.rect(36, y, doc.page.width - 72, 36).fill('#f3eee4');
  doc.restore();
  doc.font('Helvetica').fontSize(9).fillColor('#1c1408')
    .text(`Items ${row.item_count || items.length}     Weight ${money(row.total_weight)} g     Amount paid ${money(row.amount)}`, 48, y + 12, {
      width: doc.page.width - 96,
    });
  doc.y = y + 48;

  if (options.photos) drawPhotoPages(doc, images);
}

function drawPhotoPages(doc, images) {
  const files = images
    .map((image, index) => ({ image, index, file: localImage(image.url) }))
    .filter((item) => item.file || item.image.buffer);
  if (!files.length) {
    doc.font('Helvetica').fontSize(10).fillColor('#1c1408').text('No photos were saved for this job.');
    return;
  }
  const perPage = 4;
  for (let start = 0; start < files.length; start += perPage) {
    doc.addPage({ size: 'A4', layout: 'landscape', margin: 24 });
    const slice = files.slice(start, start + perPage);
    const count = slice.length;
    const gap = 12;
    const margin = 24;
    const top = 42;
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const boxW = (pageW - margin * 2 - gap * (count - 1)) / count;
    const boxH = pageH - top - 28;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0e3d4a')
      .text('Photos', margin, 16, { lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor('#6b6256')
      .text(`${start + 1}–${start + count} of ${files.length}   ·   left to right`, margin + 58, 18, { lineBreak: false });
    slice.forEach((item, col) => {
      const x = margin + col * (boxW + gap);
      doc.save();
      doc.lineWidth(0.6).strokeColor('#c8bfb0').rect(x, top, boxW, boxH).stroke();
      doc.restore();
      try {
        doc.image(item.image.buffer || item.file, x + 6, top + 6, {
          fit: [boxW - 12, boxH - 28],
          align: 'center',
          valign: 'center',
        });
      } catch {
        doc.font('Helvetica').fontSize(8).fillColor('#6b6256')
          .text('This photo could not be printed', x + 8, top + 12, { width: boxW - 16 });
      }
      doc.font('Helvetica').fontSize(9).fillColor('#1c1408')
        .text(`${item.index + 1}. ${item.image.type || 'Photo'}`, x, top + boxH - 18, {
          width: boxW, align: 'center', lineBreak: false,
        });
    });
  }
}

function datesInRange(from, to) {
  const dates = [];
  let cursor = String(from).slice(0, 10);
  const end = String(to).slice(0, 10);
  while (cursor && cursor <= end && dates.length < 62) {
    dates.push(cursor);
    const date = new Date(`${cursor}T00:00:00`);
    date.setDate(date.getDate() + 1);
    const z = (n) => String(n).padStart(2, '0');
    cursor = `${date.getFullYear()}-${z(date.getMonth() + 1)}-${z(date.getDate())}`;
  }
  return dates;
}

function cashBook(doc, title, source, from, to, tableName) {
  banner(doc, title, `${source}    ${pretty(from)} to ${pretty(to)}`);
  const dates = datesInRange(from, to);
  let any = false;
  dates.forEach((date) => {
    const rows = db.prepare(`SELECT * FROM ${tableName} WHERE date = ? ORDER BY id`).all(date);
    if (!rows.length && tableName !== 'main_cash') return;
    if (!rows.length && tableName === 'main_cash') return;
    any = true;
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0e3d4a').text(pretty(date), 36, doc.y);
    doc.moveDown(0.2);
    const debit = rows.reduce((sum, row) => sum + Number(row.debit), 0);
    const credit = rows.reduce((sum, row) => sum + Number(row.credit), 0);
    let openingAmount = 0;
    if (tableName === 'main_cash') {
      const opening = ensureOpening(date);
      openingAmount = Number(opening.opening);
      doc.font('Helvetica').fontSize(9).fillColor('#1c1408').text(
        `Opening ${money(opening.opening)}     Debit ${money(opening.debit)}     Credit ${money(opening.credit)}     Closing ${money(opening.closing)}`
      );
      doc.moveDown(0.3);
    }
    let running = openingAmount;
    table(
      doc,
      [
        { label: 'Invoice', w: 0.16 },
        { label: 'Description', w: 0.34 },
        { label: 'Debit', w: 0.15, align: 'right' },
        { label: 'Credit', w: 0.15, align: 'right' },
        { label: 'Balance', w: 0.20, align: 'right' },
      ],
      rows.map((row) => {
        running += Number(row.debit) + Number(row.credit);
        return [row.invoice_no, row.description, money(row.debit), money(row.credit), money(running)];
      })
    );
    if (tableName !== 'main_cash') {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0e3d4a')
        .text(`Debit ${money(debit)}     Credit ${money(credit)}`);
      doc.moveDown(0.4);
    }
  });
  if (!any) {
    doc.font('Helvetica').fontSize(10).fillColor('#6b6256').text('No records for this period.');
  }
}

async function hydrateImages(images) {
  await Promise.all((images || []).map(async (image) => {
    if (!image.url || !/^https?:/i.test(image.url)) return;
    try {
      const response = await fetch(image.url);
      if (response.ok) image.buffer = Buffer.from(await response.arrayBuffer());
    } catch {
      image.buffer = null;
    }
  }));
}

async function build(type, query) {
  const spec = TITLES[type];
  if (!spec) {
    const error = new Error('Unknown report');
    error.status = 404;
    throw error;
  }
  const from = String(query.from || query.date || '').slice(0, 10);
  const to = String(query.to || from).slice(0, 10);
  const jobNo = String(query.jobNo || '').trim();
  const [title, source] = spec;

  if (type === 'bought' || type === 'bought-url' || type === 'approve') {
    const jobs = jobQuery(jobNo, from, to).map(bundle);
    if (type === 'bought' || type === 'bought-url') {
      for (const packed of jobs) await hydrateImages(packed.images);
    }
    if (type === 'approve' && !jobs.length) {
      const error = new Error('That job was not found');
      error.status = 404;
      throw error;
    }
    if ((type === 'bought' || type === 'bought-url') && jobs.length) {
      return render((doc) => {
        jobs.forEach((packed, index) => {
          if (index > 0) doc.addPage({ size: 'A4', margin: 0 });
          drawBoughtCrystal(doc, packed, query.printedBy);
        });
      }, { margin: 0, plain: true });
    }
    return render((doc) => {
      if (!jobs.length) {
        banner(doc, title, `${source}    ${pretty(from)} to ${pretty(to)}`);
        doc.font('Helvetica').fontSize(11).fillColor('#1c1408')
          .text((jobNo ? `No bought product was found for job ${jobNo}.` : 'No bought products were finalized in this date range.') + notFinalizedNote(jobNo, from, to));
        return;
      }
      jobs.forEach((packed) => {
        drawJob(doc, packed, {
          title: type === 'approve' ? title : title,
          source,
          photos: type === 'bought' || type === 'bought-url',
          approve: type === 'approve',
        });
      });
    });
  }

  if (type === 'summary') {
    const rows = db.prepare(
      `SELECT job_type, COUNT(*) AS jobs, COALESCE(SUM(total_weight), 0) AS weight,
              COALESCE(SUM(amount), 0) AS amount,
              COALESCE(SUM(agent_commission), 0) AS agent_commission,
              COALESCE(SUM(rider_commission), 0) AS rider_commission
       FROM finalized WHERE finalized_date >= ? AND finalized_date <= ?
       GROUP BY job_type ORDER BY job_type`
    ).all(from, to);
    const jobs = rows.reduce((sum, row) => sum + Number(row.jobs), 0);
    return render((doc) => {
      banner(doc, title, `${source}    ${pretty(from)} to ${pretty(to)}`);
      table(doc, [
        { label: 'Job type', w: 0.16 },
        { label: 'Jobs', w: 0.12, align: 'right' },
        { label: 'Weight (g)', w: 0.18, align: 'right' },
        { label: 'Amount', w: 0.18, align: 'right' },
        { label: 'Agent', w: 0.18, align: 'right' },
        { label: 'Rider', w: 0.18, align: 'right' },
      ], rows.map((row) => [
        row.job_type, String(row.jobs), money(row.weight), money(row.amount), money(row.agent_commission), money(row.rider_commission),
      ]));
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#0e3d4a')
        .text(`Total jobs ${jobs}     Amount ${money(rows.reduce((s, r) => s + Number(r.amount), 0))}`);
    });
  }

  if (type === 'main-cash') {
    return render((doc) => cashBook(doc, title, source, from, to, 'main_cash'));
  }
  if (type === 'petty-cash') {
    return render((doc) => cashBook(doc, title, source, from, to, 'petty_cash'));
  }

  if (type === 'journal') {
    const rows = db.prepare('SELECT * FROM journal WHERE date >= ? AND date <= ? ORDER BY date, id').all(from, to);
    return render((doc) => {
      banner(doc, title, `${source}    ${pretty(from)} to ${pretty(to)}`);
      table(doc, [
        { label: 'No', w: 0.14 },
        { label: 'Date', w: 0.14 },
        { label: 'Account', w: 0.16 },
        { label: 'D/C', w: 0.08 },
        { label: 'Amount', w: 0.14, align: 'right' },
        { label: 'Description', w: 0.34 },
      ], rows.map((row) => [
        row.gl_no, pretty(row.date), row.acc_no, row.dc, money(row.amount), row.description,
      ]));
    });
  }

  if (type === 'chart') {
    const rows = db.prepare(
      `SELECT a.code, a.name, g.description AS group_name, s.description AS subtype_name,
              a.normal_balance, a.opening, a.settings
       FROM accounts a
       LEFT JOIN account_groups g ON g.code = a.group_code
       LEFT JOIN account_subtypes s ON s.code = a.subtype_code
       WHERE a.deleted = 0
       ORDER BY a.code`
    ).all();
    return render((doc) => {
      banner(doc, title, source);
      table(doc, [
        { label: 'Code', w: 0.12 },
        { label: 'Account', w: 0.24 },
        { label: 'Group', w: 0.18 },
        { label: 'Subtype', w: 0.16 },
        { label: 'Side', w: 0.10 },
        { label: 'Opening', w: 0.12, align: 'right' },
        { label: 'Link', w: 0.08 },
      ], rows.map((row) => [
        row.code, row.name, row.group_name, row.subtype_name, row.normal_balance, money(row.opening), row.settings,
      ]));
    });
  }

  if (type === 'expenses-daily') {
    const rows = db.prepare(
      `SELECT date, description, remarks, debit FROM petty_cash
       WHERE date >= ? AND date <= ? AND debit > 0 ORDER BY date, id`
    ).all(from, to);
    return render((doc) => {
      banner(doc, title, `${source}    ${pretty(from)} to ${pretty(to)}`);
      table(doc, [
        { label: 'Date', w: 0.18 },
        { label: 'Description', w: 0.32 },
        { label: 'Remarks', w: 0.32 },
        { label: 'Amount', w: 0.18, align: 'right' },
      ], rows.map((row) => [pretty(row.date), row.description, row.remarks, money(row.debit)]));
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#0e3d4a')
        .text(`Total ${money(rows.reduce((sum, row) => sum + Number(row.debit), 0))}`);
    });
  }

  const rows = db.prepare(
    `SELECT substr(date, 1, 7) AS month, description, SUM(debit) AS debit
     FROM petty_cash WHERE date >= ? AND date <= ? AND debit > 0
     GROUP BY month, description ORDER BY month, description`
  ).all(from, to);
  return render((doc) => {
    banner(doc, title, `${source}    ${pretty(from)} to ${pretty(to)}`);
    table(doc, [
      { label: 'Month', w: 0.22 },
      { label: 'Description', w: 0.53 },
      { label: 'Amount', w: 0.25, align: 'right' },
    ], rows.map((row) => [row.month, row.description, money(row.debit)]));
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0e3d4a')
      .text(`Total ${money(rows.reduce((sum, row) => sum + Number(row.debit), 0))}`);
  });
}

function reportQuery(query) {
  const from = String(query.from || query.date || '').slice(0, 10);
  const to = String(query.to || from).slice(0, 10);
  const jobNo = String(query.jobNo || '').trim();
  return { from, to, jobNo };
}

function collect(type, query) {
  const spec = TITLES[type];
  if (!spec) {
    const error = new Error('Unknown report');
    error.status = 404;
    throw error;
  }
  const { from, to, jobNo } = reportQuery(query);
  const [title, source] = spec;
  const subtitle = `${pretty(from)} to ${pretty(to)}`;

  if (type === 'bought' || type === 'bought-url' || type === 'approve') {
    const jobs = jobQuery(jobNo, from, to).map(bundle);
    const onTheseDates = db.prepare(
      'SELECT job_no FROM finalized WHERE finalized_date >= ? AND finalized_date <= ? ORDER BY job_no'
    ).all(from, to).map((row) => row.job_no);
    let empty = '';
    if (!jobs.length) {
      empty = jobNo
        ? `No bought product for ${jobNo}.`
        : `No bought products were finalized from ${pretty(from)} to ${pretty(to)}.`;
      if (onTheseDates.length) empty += ` Jobs in these dates: ${onTheseDates.join(', ')}.`;
      empty += notFinalizedNote(jobNo, from, to);
    }
    return {
      title,
      source,
      subtitle: jobNo ? `${subtitle} · Job ${jobNo}` : subtitle,
      empty,
      sections: jobs.map(({ row, items, images }) => ({
        heading: `Job ${row.job_no}`,
        lines: (type === 'bought' || type === 'bought-url') ? [
          ['Date', slashDate(row.client_date || row.create_date || row.finalized_date)],
          ['Document No', row.job_no || ''],
          ['Code', crystalCode(row.code)],
          ['Customer Name', row.name || ''],
          ['NIC', row.nic || ''],
          ['Tel No', row.mobile_no || ''],
          ['Address', row.address || ''],
          ['Location', row.location || ''],
          ['Rider/Budy', [row.rider_name, row.buddy].filter(Boolean).join('/')],
          ['Call Agent', row.agent_name || ''],
          ['First Value', money(row.first_amount)],
          ['Final Value', money(row.amount)],
        ] : [
          ['Date', pretty(row.finalized_date)],
          ['Customer', row.name || ''],
          ['NIC', row.nic || ''],
          ['Mobile', row.mobile_no || ''],
          ['Address', row.address || ''],
          ['Location', row.location || ''],
          ['Job type', row.job_type || ''],
          ['Agent', row.agent_name || ''],
          ['Agent commission', money(row.agent_commission)],
          ['Rider', row.rider_name || ''],
          ['Rider commission', money(row.rider_commission)],
          ['Cashier', row.cashier || ''],
          ['Weight', `${money(row.total_weight)} g`],
          ['Amount paid', money(row.amount)],
        ],
        columns: [
          { key: 'category', label: 'Category' },
          { key: 'item_name', label: 'Item' },
          { key: 'condition', label: 'Condition' },
          { key: 'weight', label: 'Weight (g)' },
          { key: 'rate', label: 'Rate' },
          { key: 'description', label: 'Description', flex: 2 },
        ],
        rows: items.map((item) => ({
          ...item,
          weight: money(item.weight),
        })),
        images: (type === 'bought' || type === 'bought-url')
          ? images.map((image) => ({ type: image.type, url: image.url }))
          : [],
        footer: row.note ? `Note: ${row.note}` : '',
      })),
    };
  }

  if (type === 'summary') {
    const rows = db.prepare(
      `SELECT job_type, COUNT(*) AS jobs, COALESCE(SUM(total_weight), 0) AS weight,
              COALESCE(SUM(amount), 0) AS amount,
              COALESCE(SUM(agent_commission), 0) AS agent_commission,
              COALESCE(SUM(rider_commission), 0) AS rider_commission
       FROM finalized WHERE finalized_date >= ? AND finalized_date <= ?
       GROUP BY job_type ORDER BY job_type`
    ).all(from, to);
    const amount = rows.reduce((sum, row) => sum + Number(row.amount), 0);
    return {
      title, source, subtitle,
      empty: rows.length ? '' : `No finalized jobs from ${pretty(from)} to ${pretty(to)}.`,
      sections: [{
        heading: 'By job type',
        lines: [['Total amount', money(amount)]],
        columns: [
          { key: 'job_type', label: 'Job type' },
          { key: 'jobs', label: 'Jobs' },
          { key: 'weight', label: 'Weight (g)' },
          { key: 'amount', label: 'Amount' },
          { key: 'agent_commission', label: 'Agent' },
          { key: 'rider_commission', label: 'Rider' },
        ],
        rows: rows.map((row) => ({
          job_type: row.job_type,
          jobs: String(row.jobs),
          weight: money(row.weight),
          amount: money(row.amount),
          agent_commission: money(row.agent_commission),
          rider_commission: money(row.rider_commission),
        })),
      }],
    };
  }

  if (type === 'main-cash' || type === 'petty-cash') {
    const tableName = type === 'main-cash' ? 'main_cash' : 'petty_cash';
    const sections = [];
    datesInRange(from, to).forEach((date) => {
      const rows = db.prepare(`SELECT * FROM ${tableName} WHERE date = ? ORDER BY id`).all(date);
      if (!rows.length) return;
      const lines = [];
      if (tableName === 'main_cash') {
        const opening = ensureOpening(date);
        lines.push(
          ['Opening', money(opening.opening)],
          ['Debit', money(opening.debit)],
          ['Credit', money(opening.credit)],
          ['Closing', money(opening.closing)],
        );
      }
      sections.push({
        heading: pretty(date),
        lines,
        columns: [
          { key: 'invoice_no', label: 'Invoice' },
          { key: 'description', label: 'Description', flex: 2 },
          { key: 'debit', label: 'Debit' },
          { key: 'credit', label: 'Credit' },
        ],
        rows: rows.map((row) => ({
          invoice_no: row.invoice_no,
          description: row.description,
          debit: money(row.debit),
          credit: money(row.credit),
        })),
      });
    });
    return {
      title, source, subtitle,
      empty: sections.length ? '' : `No ${title.toLowerCase()} lines from ${pretty(from)} to ${pretty(to)}.`,
      sections,
    };
  }

  if (type === 'journal') {
    const rows = db.prepare('SELECT * FROM journal WHERE date >= ? AND date <= ? ORDER BY date, id').all(from, to);
    return {
      title, source, subtitle,
      empty: rows.length ? '' : `No journal entries from ${pretty(from)} to ${pretty(to)}.`,
      sections: [{
        heading: 'Entries',
        lines: [],
        columns: [
          { key: 'gl_no', label: 'No' },
          { key: 'date', label: 'Date' },
          { key: 'acc_no', label: 'Account' },
          { key: 'dc', label: 'D/C' },
          { key: 'amount', label: 'Amount' },
          { key: 'description', label: 'Description', flex: 2 },
        ],
        rows: rows.map((row) => ({
          gl_no: row.gl_no,
          date: pretty(row.date),
          acc_no: row.acc_no,
          dc: row.dc,
          amount: money(row.amount),
          description: row.description,
        })),
      }],
    };
  }

  if (type === 'chart') {
    const rows = db.prepare(
      `SELECT a.code, a.name, g.description AS group_name, s.description AS subtype_name,
              a.normal_balance, a.opening, a.settings
       FROM accounts a
       LEFT JOIN account_groups g ON g.code = a.group_code
       LEFT JOIN account_subtypes s ON s.code = a.subtype_code
       WHERE a.deleted = 0
       ORDER BY a.code`
    ).all();
    return {
      title, source, subtitle: source,
      empty: rows.length ? '' : 'No accounts are set up.',
      sections: [{
        heading: 'Accounts',
        lines: [],
        columns: [
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Account', flex: 2 },
          { key: 'group_name', label: 'Group' },
          { key: 'normal_balance', label: 'Side' },
          { key: 'opening', label: 'Opening' },
        ],
        rows: rows.map((row) => ({
          code: row.code,
          name: row.name,
          group_name: row.group_name,
          normal_balance: row.normal_balance,
          opening: money(row.opening),
        })),
      }],
    };
  }

  if (type === 'expenses-daily') {
    const rows = db.prepare(
      `SELECT date, description, remarks, debit FROM petty_cash
       WHERE date >= ? AND date <= ? AND debit > 0 ORDER BY date, id`
    ).all(from, to);
    return {
      title, source, subtitle,
      empty: rows.length ? '' : `No expenses from ${pretty(from)} to ${pretty(to)}.`,
      sections: [{
        heading: 'Daily expenses',
        lines: [['Total', money(rows.reduce((sum, row) => sum + Number(row.debit), 0))]],
        columns: [
          { key: 'date', label: 'Date' },
          { key: 'description', label: 'Description', flex: 2 },
          { key: 'remarks', label: 'Remarks', flex: 2 },
          { key: 'debit', label: 'Amount' },
        ],
        rows: rows.map((row) => ({
          date: pretty(row.date),
          description: row.description,
          remarks: row.remarks,
          debit: money(row.debit),
        })),
      }],
    };
  }

  const rows = db.prepare(
    `SELECT substr(date, 1, 7) AS month, description, SUM(debit) AS debit
     FROM petty_cash WHERE date >= ? AND date <= ? AND debit > 0
     GROUP BY month, description ORDER BY month, description`
  ).all(from, to);
  return {
    title, source, subtitle,
    empty: rows.length ? '' : `No expenses from ${pretty(from)} to ${pretty(to)}.`,
    sections: [{
      heading: 'Month wise',
      lines: [['Total', money(rows.reduce((sum, row) => sum + Number(row.debit), 0))]],
      columns: [
        { key: 'month', label: 'Month' },
        { key: 'description', label: 'Description', flex: 2 },
        { key: 'debit', label: 'Amount' },
      ],
      rows: rows.map((row) => ({
        month: row.month,
        description: row.description,
        debit: money(row.debit),
      })),
    }],
  };
}

module.exports = { build, collect, TITLES };
