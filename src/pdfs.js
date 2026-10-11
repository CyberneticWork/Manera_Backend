const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { db, ensureOpening } = require('./db');
const biz = require('./business');

const uploadDir = path.join(__dirname, '..', 'uploads');

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

function render(draw) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    draw(doc);
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
    SELECT f.*, h.name, h.address, h.note, h.job_note_no
    FROM finalized f
    LEFT JOIN client_header h ON h.doc_no = f.doc_no
  `;
  if (jobNo) {
    const key = String(jobNo).trim();
    return db.prepare(
      `${sql} WHERE f.job_no = ? OR f.doc_no = ? OR CAST(f.code AS CHAR) = ?`
    ).all(key, key, key);
  }
  return db.prepare(`${sql} WHERE f.finalized_date >= ? AND f.finalized_date <= ? ORDER BY f.finalized_date, f.job_no`).all(from, to);
}

function bundle(row) {
  const items = row.doc_no
    ? db.prepare('SELECT * FROM client_items WHERE doc_no = ? ORDER BY id').all(row.doc_no)
    : [];
  const images = row.doc_no
    ? db.prepare('SELECT * FROM client_images WHERE doc_no = ? ORDER BY id').all(row.doc_no)
    : [];
  return { row, items, images };
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
    return render((doc) => {
      if (!jobs.length) {
        banner(doc, title, `${source}    ${pretty(from)} to ${pretty(to)}`);
        doc.font('Helvetica').fontSize(11).fillColor('#1c1408')
          .text(jobNo ? `No bought product was found for job ${jobNo}.` : 'No bought products were finalized in this date range.');
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
    }
    return {
      title,
      source,
      subtitle: jobNo ? `${subtitle} · Job ${jobNo}` : subtitle,
      empty,
      sections: jobs.map(({ row, items, images }) => ({
        heading: `Job ${row.job_no}`,
        lines: [
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
