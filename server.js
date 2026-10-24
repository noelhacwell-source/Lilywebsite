'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PHOTO_DIR = path.join(ROOT, 'private', 'photos');
const PORT = Number(process.env.PORT || 4173);
const ACCESS_CODE = process.env.ACCESS_CODE || '3.4.2026';
const ALBUM_CODE = process.env.ALBUM_CODE || 'ilysm';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_BAD_ATTEMPTS = 12;

// Originals supplied by the user, kept in the same order as the attachments.
// Add future pictures to this list and copy the untouched files into private/photos.
const PHOTO_FILES = [
  'Snapchat-450520850.jpg',
  'Snapchat-237768679.jpg',
  'Snapchat-1619438486.jpg',
  'Snapchat-2121754739.jpg',
  'Snapchat-405204846.jpg',
  'Snapchat-118449011.jpg',
  'Snapchat-1049105704.jpg',
  'Snapchat-1294576761.jpg',
  'Screenshot_20260909-200735.png',
  'Snapchat-1687208768.jpg',
  'Snapchat-1610623526.jpg',
  'Snapchat-2088658041.jpg',
  'Snapchat-299045725.jpg'
];

const sessions = new Map();
const badAttempts = new Map();

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function cookieValue(header, name) {
  if (!header) return '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return '';
}

function requestSessionId(req, url) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+([A-Za-z0-9_-]+)$/i);
  const bearer = match && match[1];
  // Query tickets are a fallback for image requests and preview proxies which
  // may not retain cookies or forward custom authorization headers.
  return bearer || (url && url.searchParams.get('ticket')) || cookieValue(req.headers.cookie, 'lily_session');
}

function sessionFor(req, url) {
  const id = requestSessionId(req, url);
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function createSession(req, res, url) {
  const existingId = requestSessionId(req, url);
  let session = existingId ? sessions.get(existingId) : null;
  let id = existingId;
  if (!session || session.expiresAt < Date.now()) {
    id = crypto.randomBytes(32).toString('base64url');
    session = { id, siteUnlocked: false, albumUnlocked: false, expiresAt: Date.now() + SESSION_TTL_MS };
    sessions.set(id, session);
  }
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = forwardedProto === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `lily_session=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
  return session;
}

function sameSecret(candidate, expected) {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  // Do not trust arbitrary X-Forwarded-For input here; this is only a soft
  // per-connection throttle for the tiny private gift site.
  return req.socket.remoteAddress || 'unknown';
}

function rateStateFor(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let state = badAttempts.get(ip);
  if (!state || state.resetAt <= now) {
    state = { count: 0, resetAt: now + RATE_WINDOW_MS };
    badAttempts.set(ip, state);
  }
  return state;
}

function isRateLimited(req) {
  return rateStateFor(req).count >= MAX_BAD_ATTEMPTS;
}

function recordBadAttempt(req) {
  rateStateFor(req).count += 1;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8192) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
  })[ext] || 'application/octet-stream';
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
  };
}

function photoManifest(session) {
  return PHOTO_FILES.map((file, index) => ({
    id: index,
    title: `Erinnerung ${String(index + 1).padStart(2, '0')}`,
    src: `/api/photos/${index}?ticket=${encodeURIComponent(session.id)}`
  }));
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const session = sessionFor(req, url);
    return json(res, 200, {
      siteUnlocked: Boolean(session && session.siteUnlocked),
      albumUnlocked: Boolean(session && session.siteUnlocked && session.albumUnlocked),
      token: session ? session.id : ''
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/unlock') {
    if (isRateLimited(req)) {
      return json(res, 429, { ok: false, message: 'Ein kleiner Moment, bby — versuch es gleich noch einmal.' });
    }
    let body;
    try { body = await readJson(req); } catch {
      return json(res, 400, { ok: false, message: 'Das hat gerade nicht geklappt. Versuch es bitte noch einmal.' });
    }
    const candidate = typeof body.code === 'string' ? body.code.trim() : '';
    if (!sameSecret(candidate, ACCESS_CODE)) {
      recordBadAttempt(req);
      return json(res, 401, { ok: false, message: 'Fast, bby — probier den Code noch einmal 💌' });
    }
    const session = createSession(req, res, url);
    session.siteUnlocked = true;
    return json(res, 200, { ok: true, token: session.id });
  }

  if (req.method === 'POST' && url.pathname === '/api/book-unlock') {
    if (isRateLimited(req)) {
      return json(res, 429, { ok: false, message: 'Ein kleiner Moment, bby — versuch es gleich noch einmal.' });
    }
    let body;
    try { body = await readJson(req); } catch {
      return json(res, 400, { ok: false, message: 'Das hat gerade nicht geklappt. Versuch es bitte noch einmal.' });
    }
    const candidate = typeof body.code === 'string' ? body.code.trim().toLowerCase() : '';
    if (!sameSecret(candidate, ALBUM_CODE)) {
      recordBadAttempt(req);
      return json(res, 401, { ok: false, message: 'Das war noch nicht ganz richtig, bby 💗' });
    }
    // The album code is a recovery path too: if a preview/browser lost the
    // first-step session, the correct album code opens the surprise directly.
    let session = sessionFor(req, url);
    if (!session) session = createSession(req, res, url);
    session.siteUnlocked = true;
    session.albumUnlocked = true;
    return json(res, 200, { ok: true, token: session.id, photos: photoManifest(session) });
  }

  if (req.method === 'GET' && url.pathname === '/api/photos') {
    const session = sessionFor(req, url);
    if (!session || !session.siteUnlocked || !session.albumUnlocked) {
      return json(res, 403, { ok: false, message: 'Das Fotoalbum ist noch verschlossen.' });
    }
    return json(res, 200, { photos: photoManifest(session) });
  }

  const photoMatch = url.pathname.match(/^\/api\/photos\/(\d+)$/);
  if (req.method === 'GET' && photoMatch) {
    const session = sessionFor(req, url);
    if (!session || !session.siteUnlocked || !session.albumUnlocked) {
      return json(res, 403, { ok: false, message: 'Das Fotoalbum ist noch verschlossen.' });
    }
    const index = Number(photoMatch[1]);
    const fileName = PHOTO_FILES[index];
    if (!fileName) return json(res, 404, { ok: false, message: 'Dieses Foto gibt es nicht.' });
    const fullPath = path.join(PHOTO_DIR, fileName);
    fs.stat(fullPath, (error, stats) => {
      if (error || !stats.isFile()) return json(res, 404, { ok: false, message: 'Dieses Foto gibt es nicht.' });
      res.writeHead(200, {
        ...securityHeaders(),
        'Content-Type': mimeType(fileName),
        'Content-Length': stats.size,
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': 'inline'
      });
      fs.createReadStream(fullPath).pipe(res);
    });
    return;
  }

  return json(res, 404, { ok: false, message: 'Diese Adresse gibt es nicht.' });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', ...securityHeaders() });
    return res.end('Method not allowed');
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch {
    res.writeHead(400, securityHeaders());
    return res.end('Bad request');
  }
  if (pathname === '/') pathname = '/index.html';
  const relativePath = path.normalize(pathname.replace(/^\/+/, ''));
  const fullPath = path.resolve(PUBLIC_DIR, relativePath);
  if (!fullPath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, securityHeaders());
    return res.end('Forbidden');
  }
  fs.stat(fullPath, (error, stats) => {
    if (error || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders() });
      return res.end('Not found');
    }
    res.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': mimeType(fullPath),
      'Content-Length': stats.size,
      'Cache-Control': ['.html', '.css', '.js'].includes(path.extname(fullPath).toLowerCase()) ? 'no-cache' : 'public, max-age=3600'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(fullPath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch {
    res.writeHead(400, securityHeaders());
    return res.end('Bad request');
  }
  if (url.pathname.startsWith('/api/')) {
    Promise.resolve(handleApi(req, res, url)).catch(error => {
      if (!res.headersSent) json(res, 500, { ok: false, message: 'Gerade ist etwas schiefgelaufen.' });
      else res.destroy(error);
    });
    return;
  }
  serveStatic(req, res, url);
});

// Expire abandoned sessions and rate-limit records so a long-running instance stays tidy.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) if (session.expiresAt < now) sessions.delete(id);
  for (const [ip, state] of badAttempts) if (state.resetAt < now) badAttempts.delete(ip);
}, 30 * 60 * 1000);
cleanupTimer.unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Lily love-book server running on http://0.0.0.0:${PORT}`);
});
