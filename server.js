const express = require('express');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const ENV_BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const db = new Database(path.join(__dirname, 'data', 'qrcodes.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS qrcodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    short_code TEXT UNIQUE NOT NULL,
    destination_type TEXT NOT NULL DEFAULT 'empty',
    destination_url TEXT,
    file_path TEXT,
    file_name TEXT,
    file_type TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    scan_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scan_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    qr_id TEXT NOT NULL,
    scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
    user_agent TEXT,
    ip_address TEXT,
    FOREIGN KEY (qr_id) REFERENCES qrcodes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    qr_id TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    performed_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (qr_id) REFERENCES qrcodes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ==================== SETTINGS HELPERS ====================

const stmtGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const stmtUpsertSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

function getBaseUrl() {
  const row = stmtGetSetting.get('base_url');
  return row ? row.value : ENV_BASE_URL;
}

function getPlaceholder() {
  const emoji   = stmtGetSetting.get('placeholder_emoji');
  const title   = stmtGetSetting.get('placeholder_title');
  const message = stmtGetSetting.get('placeholder_message');
  return {
    emoji:   emoji   ? emoji.value   : '⏳',
    title:   title   ? title.value   : 'Content Coming Soon',
    message: message ? message.value : 'This QR code has been reserved but content hasn\'t been attached yet.',
  };
}

// ==================== PREPARED STATEMENTS ====================

const stmtInsertQR = db.prepare(`
  INSERT INTO qrcodes (id, name, short_code, destination_type, destination_url, file_path, file_name, file_type)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtGetQR = db.prepare('SELECT * FROM qrcodes WHERE id = ?');
const stmtGetQRByCode = db.prepare('SELECT * FROM qrcodes WHERE short_code = ?');
const stmtGetAllQR = db.prepare('SELECT * FROM qrcodes ORDER BY created_at DESC');
const stmtDeleteQR = db.prepare('DELETE FROM qrcodes WHERE id = ?');
const stmtIncrementScan = db.prepare('UPDATE qrcodes SET scan_count = scan_count + 1 WHERE id = ?');
const stmtLogScan = db.prepare('INSERT INTO scan_log (qr_id, user_agent, ip_address) VALUES (?, ?, ?)');
const stmtGetScans = db.prepare('SELECT * FROM scan_log WHERE qr_id = ? ORDER BY scanned_at DESC LIMIT 100');
const stmtInsertAudit = db.prepare('INSERT INTO audit_log (qr_id, action, details) VALUES (?, ?, ?)');
const stmtGetAudit = db.prepare('SELECT * FROM audit_log WHERE qr_id = ? ORDER BY performed_at DESC');
const stmtGetAllIds = db.prepare('SELECT id FROM qrcodes');

// ==================== HELPERS ====================

function generateShortCode() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function uniqueShortCode() {
  const exists = db.prepare('SELECT 1 FROM qrcodes WHERE short_code = ?');
  let code, attempts = 0;
  do {
    code = generateShortCode();
    if (++attempts > 20) throw new Error('Could not generate unique short code');
  } while (exists.get(code));
  return code;
}

function writeAudit(qr_id, action, details) {
  stmtInsertAudit.run(qr_id, action, JSON.stringify(details));
}

function enrichQR(qr) {
  return {
    ...qr,
    has_content: qr.destination_type !== 'empty',
    redirect_url: `${getBaseUrl()}/r/${qr.short_code}`,
  };
}

function toActiveInt(val) {
  if (val == null) return null;
  return val === 'true' || val === true ? 1 : 0;
}

function deleteUpload(filePath) {
  if (!filePath) return;
  const full = path.join(__dirname, 'uploads', filePath);
  if (fs.existsSync(full)) fs.unlinkSync(full);
}

// ==================== MIDDLEWARE ====================

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const ALLOWED_MIMETYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/svg+xml', 'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv',
  'application/zip', 'application/x-zip-compressed',
  'audio/mpeg', 'audio/wav', 'audio/ogg',
  'video/mp4', 'video/webm',
  'application/json', 'application/xml',
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    ALLOWED_MIMETYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error(`File type ${file.mimetype} not allowed`)),
});

// ==================== SETTINGS API ====================

app.get('/api/settings', (req, res) => {
  res.json({ base_url: getBaseUrl(), placeholder: getPlaceholder() });
});

app.put('/api/settings/placeholder', (req, res) => {
  const { emoji, title, message } = req.body;
  if (emoji   !== undefined) stmtUpsertSetting.run('placeholder_emoji',   String(emoji));
  if (title   !== undefined) stmtUpsertSetting.run('placeholder_title',   String(title));
  if (message !== undefined) stmtUpsertSetting.run('placeholder_message', String(message));
  res.json({ placeholder: getPlaceholder() });
});

// Update domain — all QR image URLs immediately reflect the new domain on next request.
// Existing printed/downloaded QR images pointing to the old URL are unaffected server-side
// but will continue to work as long as the old domain still routes here, or users re-download.
app.put('/api/settings/domain', (req, res) => {
  const { base_url } = req.body;
  if (!base_url || typeof base_url !== 'string') {
    return res.status(400).json({ error: 'base_url is required' });
  }
  const normalized = base_url.replace(/\/+$/, '');
  const oldUrl = getBaseUrl();
  stmtUpsertSetting.run('base_url', normalized);

  // Audit every QR so history shows when its effective URL changed
  const ids = stmtGetAllIds.all();
  const logAll = db.transaction(() => {
    for (const { id } of ids) {
      writeAudit(id, 'domain_updated', { old_base_url: oldUrl, new_base_url: normalized });
    }
  });
  logAll();

  res.json({
    base_url: getBaseUrl(),
    qr_codes_affected: ids.length,
    note: 'Re-download QR images to embed the new domain. Existing printed QRs will still work if the old domain redirects here.',
  });
});

// ==================== QR CODE API ====================

// Create — URL, file, or empty (name only)
app.post('/api/qrcodes', upload.single('file'), (req, res) => {
  const { name, destination_url } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const id = uuidv4();
  let short_code;
  try { short_code = uniqueShortCode(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  let destination_type, dest_url = null, file_path = null, file_name = null, file_type = null;

  if (req.file) {
    destination_type = 'file';
    file_path = req.file.filename;
    file_name = req.file.originalname;
    file_type = req.file.mimetype;
  } else if (destination_url) {
    destination_type = 'url';
    dest_url = destination_url;
  } else {
    destination_type = 'empty';
  }

  try {
    stmtInsertQR.run(id, name, short_code, destination_type, dest_url, file_path, file_name, file_type);
    writeAudit(id, 'created', { destination_type, destination_url: dest_url, file_name });
    res.status(201).json(enrichQR(stmtGetQR.get(id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all
app.get('/api/qrcodes', (req, res) => {
  res.json(stmtGetAllQR.all().map(enrichQR));
});

// Get one
app.get('/api/qrcodes/:id', (req, res) => {
  const qr = stmtGetQR.get(req.params.id);
  if (!qr) return res.status(404).json({ error: 'QR code not found' });
  res.json(enrichQR(qr));
});

// Audit log for a QR code
app.get('/api/qrcodes/:id/audit', (req, res) => {
  const qr = stmtGetQR.get(req.params.id);
  if (!qr) return res.status(404).json({ error: 'QR code not found' });
  const entries = stmtGetAudit.all(req.params.id).map(e => ({
    ...e,
    details: e.details ? JSON.parse(e.details) : null,
  }));
  res.json(entries);
});

// Update — destination, name, status, or clear to empty
app.put('/api/qrcodes/:id', upload.single('file'), (req, res) => {
  const qr = stmtGetQR.get(req.params.id);
  if (!qr) return res.status(404).json({ error: 'QR code not found' });

  const { name, destination_url, is_active, clear_destination } = req.body;
  const activeVal = toActiveInt(is_active);
  const changes = [];

  if (req.file) {
    deleteUpload(qr.file_path);
    db.prepare(`
      UPDATE qrcodes SET name = COALESCE(?, name), destination_type = 'file',
        destination_url = NULL, file_path = ?, file_name = ?, file_type = ?,
        is_active = COALESCE(?, is_active), updated_at = datetime('now')
      WHERE id = ?
    `).run(name || null, req.file.filename, req.file.originalname, req.file.mimetype, activeVal, req.params.id);
    changes.push({ field: 'destination', old_type: qr.destination_type, old_file: qr.file_name, new_type: 'file', new_file: req.file.originalname });

  } else if (destination_url) {
    deleteUpload(qr.file_path);
    db.prepare(`
      UPDATE qrcodes SET name = COALESCE(?, name), destination_type = 'url',
        destination_url = ?, file_path = NULL, file_name = NULL, file_type = NULL,
        is_active = COALESCE(?, is_active), updated_at = datetime('now')
      WHERE id = ?
    `).run(name || null, destination_url, activeVal, req.params.id);
    changes.push({ field: 'destination', old_type: qr.destination_type, old_url: qr.destination_url, new_type: 'url', new_url: destination_url });

  } else if (clear_destination === 'true' || clear_destination === true) {
    deleteUpload(qr.file_path);
    db.prepare(`
      UPDATE qrcodes SET name = COALESCE(?, name), destination_type = 'empty',
        destination_url = NULL, file_path = NULL, file_name = NULL, file_type = NULL,
        is_active = COALESCE(?, is_active), updated_at = datetime('now')
      WHERE id = ?
    `).run(name || null, activeVal, req.params.id);
    changes.push({ field: 'destination', old_type: qr.destination_type, new_type: 'empty' });

  } else {
    // Name / active-status only
    if (name && name !== qr.name) changes.push({ field: 'name', old: qr.name, new: name });
    if (activeVal != null && activeVal !== qr.is_active) changes.push({ field: 'is_active', old: qr.is_active, new: activeVal });
    db.prepare(`
      UPDATE qrcodes SET name = COALESCE(?, name),
        is_active = COALESCE(?, is_active), updated_at = datetime('now')
      WHERE id = ?
    `).run(name || null, activeVal, req.params.id);
  }

  if (changes.length) writeAudit(req.params.id, 'updated', { changes });

  res.json(enrichQR(stmtGetQR.get(req.params.id)));
});

// Delete
app.delete('/api/qrcodes/:id', (req, res) => {
  const qr = stmtGetQR.get(req.params.id);
  if (!qr) return res.status(404).json({ error: 'QR code not found' });
  deleteUpload(qr.file_path);
  stmtDeleteQR.run(req.params.id);
  res.json({ message: 'QR code deleted' });
});

// QR image — always uses live base_url so a domain update is reflected immediately
app.get('/api/qrcodes/:id/image', async (req, res) => {
  const qr = stmtGetQR.get(req.params.id);
  if (!qr) return res.status(404).json({ error: 'QR code not found' });

  const redirectUrl = `${getBaseUrl()}/r/${qr.short_code}`;
  const format = req.query.format || 'png';
  const size = Math.min(Math.max(parseInt(req.query.size) || 300, 100), 2000);
  const color = req.query.color || '#000000';
  const bg = req.query.bg || '#ffffff';

  try {
    if (format === 'svg') {
      const svg = await QRCode.toString(redirectUrl, { type: 'svg', width: size, color: { dark: color, light: bg } });
      res.type('svg').send(svg);
    } else {
      const buffer = await QRCode.toBuffer(redirectUrl, { width: size, margin: 2, color: { dark: color, light: bg } });
      res.type('png').send(buffer);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scan analytics
app.get('/api/qrcodes/:id/scans', (req, res) => {
  const qr = stmtGetQR.get(req.params.id);
  if (!qr) return res.status(404).json({ error: 'QR code not found' });
  res.json({ total: qr.scan_count, recent: stmtGetScans.all(req.params.id) });
});

// ==================== FILE VIEWER ====================

app.get('/view/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(__dirname, 'uploads', filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.sendFile(filePath);
});

// ==================== REDIRECT / SCAN ROUTE ====================

const PDF_JS_VER = '3.11.174';
const PDF_JS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDF_JS_VER}`;
const VIEWABLE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml', 'image/webp', 'application/pdf']);

function pageShell(title, bodyContent, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:20px}
  h1{font-size:1.2rem;opacity:.9;text-align:center;margin-bottom:20px}
  .btn{margin-top:16px;padding:10px 24px;background:#e94560;color:#fff;border:none;border-radius:6px;font-size:1rem;cursor:pointer;text-decoration:none;display:inline-block}
  .btn:hover{background:#c73e54}
  img.preview{max-width:100%;max-height:80vh;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,.4)}
  #pdf-container{width:100%;max-width:900px}
  #pdf-canvas{width:100%;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,.4);display:block}
  #pdf-controls{display:flex;align-items:center;gap:12px;margin-top:12px;justify-content:center}
  #pdf-controls button{padding:6px 16px;background:#333;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.95rem}
  #pdf-controls button:hover{background:#555}
  #pdf-controls button:disabled{opacity:.4;cursor:default}
</style>${extraHead}
</head><body>${bodyContent}</body></html>`;
}

app.get('/r/:code', (req, res) => {
  const qr = stmtGetQRByCode.get(req.params.code);

  if (!qr || !qr.is_active) {
    return res.status(404).send(pageShell('Not Found', `
      <div style="text-align:center;margin-top:20vh">
        <div style="font-size:3rem;margin-bottom:16px">🔍</div>
        <h1 style="font-size:1.5rem">QR Code Not Found</h1>
        <p style="opacity:.6;margin-top:8px">This QR code is inactive or does not exist.</p>
      </div>`));
  }

  stmtIncrementScan.run(qr.id);
  stmtLogScan.run(qr.id, req.headers['user-agent'] || '', req.ip);

  if (qr.destination_type === 'url') {
    return res.redirect(302, qr.destination_url);
  }

  if (qr.destination_type === 'empty') {
    const ph = getPlaceholder();
    return res.status(200).send(pageShell(ph.title, `
      <div style="text-align:center;margin-top:20vh;padding:40px;background:rgba(255,255,255,.05);border-radius:16px;border:1px solid rgba(255,255,255,.1);max-width:480px;width:100%">
        <div style="font-size:3.5rem;margin-bottom:16px">${ph.emoji}</div>
        <h1 style="font-size:1.5rem;margin-bottom:8px">${ph.title}</h1>
        <p style="opacity:.6">${ph.message}</p>
        <p style="margin-top:12px;font-size:.8rem;opacity:.35">${qr.name}</p>
      </div>`));
  }

  if (qr.destination_type === 'file') {
    if (!VIEWABLE.has(qr.file_type)) {
      return res.download(path.join(__dirname, 'uploads', qr.file_path), qr.file_name);
    }

    if (qr.file_type === 'application/pdf') {
      return res.send(pageShell(qr.file_name, `
        <h1>${qr.file_name}</h1>
        <div id="pdf-container">
          <canvas id="pdf-canvas"></canvas>
          <div id="pdf-controls">
            <button id="prev-btn" onclick="changePage(-1)" disabled>&#8249; Prev</button>
            <span id="page-info">Loading…</span>
            <button id="next-btn" onclick="changePage(1)" disabled>Next &#8250;</button>
          </div>
        </div>
        <a class="btn" href="/uploads/${qr.file_path}" download="${qr.file_name}">Download</a>
        <script src="${PDF_JS_CDN}/pdf.min.js"><\/script>
        <script>
          pdfjsLib.GlobalWorkerOptions.workerSrc='${PDF_JS_CDN}/pdf.worker.min.js';
          let doc=null,page=1;
          const canvas=document.getElementById('pdf-canvas'),ctx=canvas.getContext('2d');
          function render(n){
            doc.getPage(n).then(p=>{
              const vp=p.getViewport({scale:1.8});
              canvas.height=vp.height;canvas.width=vp.width;
              p.render({canvasContext:ctx,viewport:vp});
              document.getElementById('page-info').textContent='Page '+n+' of '+doc.numPages;
              document.getElementById('prev-btn').disabled=n<=1;
              document.getElementById('next-btn').disabled=n>=doc.numPages;
            });
          }
          function changePage(d){page=Math.min(Math.max(1,page+d),doc.numPages);render(page);}
          pdfjsLib.getDocument('/view/${qr.file_path}').promise
            .then(pdf=>{doc=pdf;render(1);})
            .catch(()=>{document.getElementById('pdf-container').innerHTML='<p style="padding:20px">Could not load PDF. <a class="btn" href="/view/${qr.file_path}">Download</a></p>';});
        <\/script>`));
    }

    return res.send(pageShell(qr.file_name, `
      <h1>${qr.file_name}</h1>
      <img class="preview" src="/uploads/${qr.file_path}" alt="${qr.file_name}">
      <a class="btn" href="/uploads/${qr.file_path}" download="${qr.file_name}">Download</a>`));
  }

  res.status(400).send('Invalid QR code configuration');
});

// ==================== FRONTEND FALLBACK ====================

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`QR Code Platform running — base URL: ${getBaseUrl()}`);
});
