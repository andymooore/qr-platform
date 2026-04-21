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
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Ensure directories exist
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

// Database setup
const db = new Database(path.join(__dirname, 'data', 'qrcodes.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS qrcodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    short_code TEXT UNIQUE NOT NULL,
    destination_type TEXT NOT NULL DEFAULT 'url',
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
`);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/gif', 'image/svg+xml', 'image/webp',
      'application/pdf',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain', 'text/csv',
      'application/zip', 'application/x-zip-compressed',
      'audio/mpeg', 'audio/wav', 'audio/ogg',
      'video/mp4', 'video/webm',
      'application/json', 'application/xml'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed`));
    }
  }
});

// Generate short code
function generateShortCode() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Prepared statements
const insertQR = db.prepare(`
  INSERT INTO qrcodes (id, name, short_code, destination_type, destination_url, file_path, file_name, file_type)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const getQR = db.prepare('SELECT * FROM qrcodes WHERE id = ?');
const getQRByCode = db.prepare('SELECT * FROM qrcodes WHERE short_code = ?');
const getAllQR = db.prepare('SELECT * FROM qrcodes ORDER BY created_at DESC');
const deleteQR = db.prepare('DELETE FROM qrcodes WHERE id = ?');
const incrementScan = db.prepare('UPDATE qrcodes SET scan_count = scan_count + 1 WHERE id = ?');
const logScan = db.prepare('INSERT INTO scan_log (qr_id, user_agent, ip_address) VALUES (?, ?, ?)');
const getScanLog = db.prepare('SELECT * FROM scan_log WHERE qr_id = ? ORDER BY scanned_at DESC LIMIT 100');

// ==================== API ROUTES ====================

// Create QR code with URL
app.post('/api/qrcodes', (req, res) => {
  const { name, destination_url } = req.body;
  if (!name || !destination_url) {
    return res.status(400).json({ error: 'Name and destination URL are required' });
  }

  const id = uuidv4();
  const short_code = generateShortCode();

  try {
    insertQR.run(id, name, short_code, 'url', destination_url, null, null, null);
    const qr = getQR.get(id);
    qr.redirect_url = `${BASE_URL}/r/${short_code}`;
    res.status(201).json(qr);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create QR code with file upload
app.post('/api/qrcodes/upload', upload.single('file'), (req, res) => {
  const { name } = req.body;
  if (!name || !req.file) {
    return res.status(400).json({ error: 'Name and file are required' });
  }

  const id = uuidv4();
  const short_code = generateShortCode();

  try {
    insertQR.run(id, name, short_code, 'file', null, req.file.filename, req.file.originalname, req.file.mimetype);
    const qr = getQR.get(id);
    qr.redirect_url = `${BASE_URL}/r/${short_code}`;
    res.status(201).json(qr);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all QR codes
app.get('/api/qrcodes', (req, res) => {
  const qrcodes = getAllQR.all().map(qr => ({
    ...qr,
    redirect_url: `${BASE_URL}/r/${qr.short_code}`
  }));
  res.json(qrcodes);
});

// Get single QR code
app.get('/api/qrcodes/:id', (req, res) => {
  const qr = getQR.get(req.params.id);
  if (!qr) return res.status(404).json({ error: 'QR code not found' });
  qr.redirect_url = `${BASE_URL}/r/${qr.short_code}`;
  res.json(qr);
});

// Update QR code destination (switch link or file)
app.put('/api/qrcodes/:id', upload.single('file'), (req, res) => {
  const qr = getQR.get(req.params.id);
  if (!qr) return res.status(404).json({ error: 'QR code not found' });

  const { name, destination_url, is_active } = req.body;

  if (req.file) {
    // Switching to a file — delete old file if exists
    if (qr.file_path) {
      const oldPath = path.join(__dirname, 'uploads', qr.file_path);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    db.prepare(`
      UPDATE qrcodes SET name = COALESCE(?, name), destination_type = 'file',
        destination_url = NULL, file_path = ?, file_name = ?, file_type = ?,
        is_active = COALESCE(?, is_active), updated_at = datetime('now')
      WHERE id = ?
    `).run(name || null, req.file.filename, req.file.originalname, req.file.mimetype, is_active != null ? (is_active === 'true' || is_active === true ? 1 : 0) : null, req.params.id);
  } else if (destination_url) {
    // Switching to a URL — delete old file if exists
    if (qr.file_path) {
      const oldPath = path.join(__dirname, 'uploads', qr.file_path);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    db.prepare(`
      UPDATE qrcodes SET name = COALESCE(?, name), destination_type = 'url',
        destination_url = ?, file_path = NULL, file_name = NULL, file_type = NULL,
        is_active = COALESCE(?, is_active), updated_at = datetime('now')
      WHERE id = ?
    `).run(name || null, destination_url, is_active != null ? (is_active === 'true' || is_active === true ? 1 : 0) : null, req.params.id);
  } else {
    // Update name/status only
    db.prepare(`
      UPDATE qrcodes SET name = COALESCE(?, name),
        is_active = COALESCE(?, is_active), updated_at = datetime('now')
      WHERE id = ?
    `).run(name || null, is_active != null ? (is_active === 'true' || is_active === true ? 1 : 0) : null, req.params.id);
  }

  const updated = getQR.get(req.params.id);
  updated.redirect_url = `${BASE_URL}/r/${updated.short_code}`;
  res.json(updated);
});

// Delete QR code
app.delete('/api/qrcodes/:id', (req, res) => {
  const qr = getQR.get(req.params.id);
  if (!qr) return res.status(404).json({ error: 'QR code not found' });

  if (qr.file_path) {
    const filePath = path.join(__dirname, 'uploads', qr.file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  deleteQR.run(req.params.id);
  res.json({ message: 'QR code deleted' });
});

// Generate QR code image
app.get('/api/qrcodes/:id/image', async (req, res) => {
  const qr = getQR.get(req.params.id);
  if (!qr) return res.status(404).json({ error: 'QR code not found' });

  const redirectUrl = `${BASE_URL}/r/${qr.short_code}`;
  const format = req.query.format || 'png';
  const size = Math.min(Math.max(parseInt(req.query.size) || 300, 100), 2000);
  const color = req.query.color || '#000000';
  const bg = req.query.bg || '#ffffff';

  try {
    if (format === 'svg') {
      const svg = await QRCode.toString(redirectUrl, {
        type: 'svg', width: size,
        color: { dark: color, light: bg }
      });
      res.type('svg').send(svg);
    } else {
      const buffer = await QRCode.toBuffer(redirectUrl, {
        width: size, margin: 2,
        color: { dark: color, light: bg }
      });
      res.type('png').send(buffer);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get scan analytics
app.get('/api/qrcodes/:id/scans', (req, res) => {
  const qr = getQR.get(req.params.id);
  if (!qr) return res.status(404).json({ error: 'QR code not found' });

  const scans = getScanLog.all(req.params.id);
  res.json({ total: qr.scan_count, recent: scans });
});

// Serve a file inline (for PDF viewing in browser)
app.get('/view/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filePath = path.join(__dirname, 'uploads', filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.sendFile(filePath);
});

// ==================== REDIRECT ROUTE ====================

app.get('/r/:code', (req, res) => {
  const qr = getQRByCode.get(req.params.code);
  if (!qr || !qr.is_active) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f0f0f0">
        <div style="text-align:center"><h1>QR Code Not Found</h1><p>This QR code is inactive or does not exist.</p></div>
      </body></html>
    `);
  }

  // Log the scan
  incrementScan.run(qr.id);
  logScan.run(qr.id, req.headers['user-agent'] || '', req.ip);

  if (qr.destination_type === 'url') {
    return res.redirect(302, qr.destination_url);
  }

  if (qr.destination_type === 'file') {
    // For viewable files, show a preview page; otherwise download
    const viewable = ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml', 'image/webp', 'application/pdf'];
    if (viewable.includes(qr.file_type)) {
      return res.send(`
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>${qr.file_name}</title>
        <style>
          * { margin:0; padding:0; box-sizing:border-box; }
          body { font-family:system-ui,sans-serif; background:#1a1a2e; color:#fff; min-height:100vh; display:flex; flex-direction:column; align-items:center; padding:20px; }
          .header { text-align:center; margin-bottom:20px; }
          .header h1 { font-size:1.2rem; opacity:0.9; }
          .preview { max-width:100%; max-height:80vh; border-radius:8px; box-shadow:0 4px 24px rgba(0,0,0,0.4); }
          .download { margin-top:16px; padding:10px 24px; background:#e94560; color:#fff; border:none; border-radius:6px; font-size:1rem; cursor:pointer; text-decoration:none; display:inline-block; }
          .download:hover { background:#c73e54; }
          #pdf-container { width:100%; max-width:900px; }
          #pdf-canvas { width:100%; border-radius:8px; box-shadow:0 4px 24px rgba(0,0,0,0.4); display:block; }
          #pdf-controls { display:flex; align-items:center; gap:12px; margin-top:12px; justify-content:center; }
          #pdf-controls button { padding:6px 16px; background:#333; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:0.95rem; }
          #pdf-controls button:hover { background:#555; }
          #pdf-controls button:disabled { opacity:0.4; cursor:default; }
        </style></head><body>
          <div class="header"><h1>${qr.file_name}</h1></div>
          ${qr.file_type === 'application/pdf'
            ? `<div id="pdf-container">
                <canvas id="pdf-canvas"></canvas>
                <div id="pdf-controls">
                  <button id="prev-btn" onclick="changePage(-1)" disabled>&#8249; Prev</button>
                  <span id="page-info">Loading...</span>
                  <button id="next-btn" onclick="changePage(1)" disabled>Next &#8250;</button>
                </div>
               </div>
               <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"><\/script>
               <script>
                 pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                 let pdfDoc = null, pageNum = 1;
                 const canvas = document.getElementById('pdf-canvas');
                 const ctx = canvas.getContext('2d');
                 function renderPage(num) {
                   pdfDoc.getPage(num).then(page => {
                     const vp = page.getViewport({ scale: 1.8 });
                     canvas.height = vp.height;
                     canvas.width = vp.width;
                     page.render({ canvasContext: ctx, viewport: vp });
                     document.getElementById('page-info').textContent = 'Page ' + num + ' of ' + pdfDoc.numPages;
                     document.getElementById('prev-btn').disabled = num <= 1;
                     document.getElementById('next-btn').disabled = num >= pdfDoc.numPages;
                   });
                 }
                 function changePage(delta) {
                   pageNum = Math.min(Math.max(1, pageNum + delta), pdfDoc.numPages);
                   renderPage(pageNum);
                 }
                 pdfjsLib.getDocument('/view/${qr.file_path}').promise.then(pdf => {
                   pdfDoc = pdf;
                   renderPage(1);
                 }).catch(e => {
                   document.getElementById('pdf-container').innerHTML = '<p style="padding:20px;text-align:center;">Could not load PDF. <a class="download" href="/view/${qr.file_path}">Download instead</a></p>';
                 });
               <\/script>`
            : `<img class="preview" src="/uploads/${qr.file_path}" alt="${qr.file_name}">`
          }
          <a class="download" href="/uploads/${qr.file_path}" download="${qr.file_name}">Download</a>
        </body></html>
      `);
    }

    // Non-viewable: direct download
    return res.download(path.join(__dirname, 'uploads', qr.file_path), qr.file_name);
  }

  res.status(400).send('Invalid QR code configuration');
});

// Fallback: serve frontend
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`QR Code Platform running at ${BASE_URL}`);
});
