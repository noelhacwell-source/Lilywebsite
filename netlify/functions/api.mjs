'use strict';

// Netlify Function version of server.js — the whole /api/* surface lives here.
//
// Differences to the long-running server.js, by necessity:
// * Sessions are signed tokens (HMAC) instead of server-side in-memory ids, so
//   they survive across serverless instances. The HttpOnly cookie plus the
//   bearer/ticket fallback work exactly like in server.js.
// * The photo originals ship inside the function bundle (netlify.toml →
//   included_files) and are never published as static files.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ACCESS_CODE = process.env.ACCESS_CODE || '3.4.2026';
const ALBUM_CODE = process.env.ALBUM_CODE || 'ilysm';
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'lily-love-book-token-secret';
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

// private/photos/ is bundled via included_files (paths relative to the project
// root). Resolve the directory for the deployed bundle and for local runs.
function resolvePhotoDir() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.cwd(), 'private', 'photos'),
    path.join(moduleDir, '..', '..', 'private', 'photos'),
    path.join(moduleDir, 'private', 'photos')
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

const PHOTO_DIR = resolvePhotoDir();
const badAttempts = new Map();

function json(status, payload, extraHeaders) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(extraHeaders || {})
    }
  });
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
  const authorization = String(req.headers.get('authorization') || '');
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  const bearer = match && match[1];
  // Query tickets are a fallback for image requests and preview proxies which
  // may not retain cookies or forward custom authorization headers.
  return bearer || (url && url.searchParams.get('ticket')) || cookieValue(req.headers.get('cookie'), 'lily_session');
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || token.length < 1 || token.length > 4096) return null;
  const separator = token.indexOf('.');
  if (separator <= 0 || separator === token.length - 1) return null;
  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.t !== 'number' || !Number.isFinite(payload.t)) return null;
  const age = Date.now() - payload.t;
  if (age < -60 * 1000 || age > SESSION_TTL_MS) return null;
  return {
    siteUnlocked: Boolean(payload.s),
    albumUnlocked: Boolean(payload.a)
  };
}

function sessionFor(req, url) {
  const id = requestSessionId(req, url);
  if (!id) return null;
  const state = verifyToken(id);
  if (!state) return null;
  return { id, siteUnlocked: state.siteUnlocked, albumUnlocked: state.albumUnlocked };
}

function issueToken({ siteUnlocked, albumUnlocked }) {
  return signToken({
    s: siteUnlocked ? 1 : 0,
    a: albumUnlocked ? 1 : 0,
    t: Date.now()
  });
}

function sessionCookie(token, req) {
  const forwardedProto = String(req.headers.get('x-forwarded-proto') || '').split(',')[0].trim();
  const secure = forwardedProto === 'https' ? '; Secure' : '';
  return `lily_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

function sameSecret(candidate, expected) {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function rateStateFor(ip) {
  const now = Date.now();
  let state = badAttempts.get(ip);
  if (!state || state.resetAt <= now) {
    state = { count: 0, resetAt: now + RATE_WINDOW_MS };
    badAttempts.set(ip, state);
  }
  return state;
}

function isRateLimited(ip) {
  return rateStateFor(ip).count >= MAX_BAD_ATTEMPTS;
}

function recordBadAttempt(ip) {
  rateStateFor(ip).count += 1;
}

async function readJson(req) {
  const body = await req.text();
  if (body.length > 8192) throw new Error('Request too large');
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error('Invalid JSON');
  }
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

function photoManifest(token) {
  return PHOTO_FILES.map((file, index) => ({
    id: index,
    title: `Erinnerung ${String(index + 1).padStart(2, '0')}`,
    src: `/api/photos/${index}?ticket=${encodeURIComponent(token)}`
  }));
}

async function handleApi(req, context) {
  const url = new URL(req.url);
  const ip = (context && context.ip) || String(req.headers.get('x-nf-client-connection-ip') || '').split(',')[0].trim() || 'unknown';

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const session = sessionFor(req, url);
    return json(200, {
      siteUnlocked: Boolean(session && session.siteUnlocked),
      albumUnlocked: Boolean(session && session.siteUnlocked && session.albumUnlocked),
      token: session ? session.id : ''
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/unlock') {
    if (isRateLimited(ip)) {
      return json(429, { ok: false, message: 'Ein kleiner Moment, bby — versuch es gleich noch einmal.' });
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      return json(400, { ok: false, message: 'Das hat gerade nicht geklappt. Versuch es bitte noch einmal.' });
    }
    const candidate = typeof body.code === 'string' ? body.code.trim() : '';
    if (!sameSecret(candidate, ACCESS_CODE)) {
      recordBadAttempt(ip);
      return json(401, { ok: false, message: 'Fast, bby — probier den Code noch einmal 💌' });
    }
    // Keep a previously earned album unlock, like server.js keeps its session.
    const previous = sessionFor(req, url);
    const token = issueToken({ siteUnlocked: true, albumUnlocked: Boolean(previous && previous.albumUnlocked) });
    return json(200, { ok: true, token }, { 'Set-Cookie': sessionCookie(token, req) });
  }

  if (req.method === 'POST' && url.pathname === '/api/book-unlock') {
    if (isRateLimited(ip)) {
      return json(429, { ok: false, message: 'Ein kleiner Moment, bby — versuch es gleich noch einmal.' });
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      return json(400, { ok: false, message: 'Das hat gerade nicht geklappt. Versuch es bitte noch einmal.' });
    }
    const candidate = typeof body.code === 'string' ? body.code.trim().toLowerCase() : '';
    if (!sameSecret(candidate, ALBUM_CODE)) {
      recordBadAttempt(ip);
      return json(401, { ok: false, message: 'Das war noch nicht ganz richtig, bby 💗' });
    }
    // The album code is a recovery path too: if a preview/browser lost the
    // first-step session, the correct album code opens the surprise directly.
    const token = issueToken({ siteUnlocked: true, albumUnlocked: true });
    return json(200, { ok: true, token, photos: photoManifest(token) }, { 'Set-Cookie': sessionCookie(token, req) });
  }

  if (req.method === 'GET' && url.pathname === '/api/photos') {
    const session = sessionFor(req, url);
    if (!session || !session.siteUnlocked || !session.albumUnlocked) {
      return json(403, { ok: false, message: 'Das Fotoalbum ist noch verschlossen.' });
    }
    return json(200, { photos: photoManifest(session.id) });
  }

  const photoMatch = url.pathname.match(/^\/api\/photos\/(\d+)$/);
  if (req.method === 'GET' && photoMatch) {
    const session = sessionFor(req, url);
    if (!session || !session.siteUnlocked || !session.albumUnlocked) {
      return json(403, { ok: false, message: 'Das Fotoalbum ist noch verschlossen.' });
    }
    const index = Number(photoMatch[1]);
    const fileName = PHOTO_FILES[index];
    if (!fileName) return json(404, { ok: false, message: 'Dieses Foto gibt es nicht.' });
    const fullPath = path.join(PHOTO_DIR, fileName);
    let stats;
    try {
      stats = await fs.promises.stat(fullPath);
      if (!stats.isFile()) throw new Error('not a file');
    } catch {
      return json(404, { ok: false, message: 'Dieses Foto gibt es nicht.' });
    }
    const data = await fs.promises.readFile(fullPath);
    return new Response(data, {
      status: 200,
      headers: {
        ...securityHeaders(),
        'Content-Type': mimeType(fileName),
        'Content-Length': String(stats.size),
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': 'inline'
      }
    });
  }

  return json(404, { ok: false, message: 'Diese Adresse gibt es nicht.' });
}

export default async function handler(req, context) {
  try {
    return await handleApi(req, context);
  } catch {
    return json(500, { ok: false, message: 'Gerade ist etwas schiefgelaufen.' });
  }
}

export const config = {
  // URLPattern-style routes; the handler routes internally exactly like
  // server.js, so overlapping patterns are harmless. The explicit entries
  // keep every endpoint reachable even if a wildcard only spans one segment.
  path: [
    '/api/*',
    '/api/status',
    '/api/unlock',
    '/api/book-unlock',
    '/api/photos',
    '/api/photos/:id'
  ]
};
