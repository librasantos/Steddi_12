// api/history.js — hardened version
import { kv } from '@vercel/kv';

const MAX_ENTRY_TEXT = 500;
const MAX_TASKS_PER_ENTRY = 50;
const MAX_HISTORY_DAYS = 90;
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 20;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Steddi-Code',
  'Content-Type': 'application/json',
};

function setCORS(res) { Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v)); }
function safeError(res, status, msg) { return res.status(status).json({ error: msg }); }

function sanitizeCode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const c = raw.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,32);
  return c.length >= 3 ? c : null;
}

function sanitizeTask(t) {
  if (!t || typeof t !== 'object') return null;
  const text = typeof t.text === 'string' ? t.text.slice(0,MAX_ENTRY_TEXT).trim() : '';
  if (!text) return null;
  return {
    text,
    priority: ['must','should','nice','later'].includes(t.priority) ? t.priority : 'should',
  };
}

function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  // Validate date format
  if (!entry.dateRaw || typeof entry.dateRaw !== 'string') return null;
  // Ensure done/deferred are valid task arrays
  return {
    date: typeof entry.date === 'string' ? entry.date.slice(0,40) : '',
    dateRaw: entry.dateRaw.slice(0,40),
    done: Array.isArray(entry.done)
      ? entry.done.slice(0,MAX_TASKS_PER_ENTRY).map(sanitizeTask).filter(Boolean)
      : [],
    deferred: Array.isArray(entry.deferred)
      ? entry.deferred.slice(0,MAX_TASKS_PER_ENTRY).map(sanitizeTask).filter(Boolean)
      : [],
  };
}

async function checkRateLimit(code) {
  const key = `steddi:rate:hist:${code}`;
  try {
    const count = await kv.incr(key);
    if (count === 1) await kv.expire(key, RATE_LIMIT_WINDOW);
    return count <= RATE_LIMIT_MAX;
  } catch { return true; }
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const code = sanitizeCode(req.headers['x-steddi-code'] || req.query.code);
  if (!code) return safeError(res, 400, 'Invalid or missing family code');

  if (!await checkRateLimit(code)) {
    res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW));
    return safeError(res, 429, 'Too many requests');
  }

  const key = `steddi:history:${code}`;

  try {
    if (req.method === 'GET') {
      const history = await kv.get(key);
      return res.status(200).json({ ok: true, history: history || [] });
    }

    if (req.method === 'POST') {
      const entry = sanitizeEntry(req.body?.entry);
      if (!entry) return safeError(res, 400, 'Invalid history entry');

      const existing = await kv.get(key) || [];
      const filtered = Array.isArray(existing)
        ? existing.filter(e => e.dateRaw !== entry.dateRaw)
        : [];
      const updated = [{ ...entry, _saved: new Date().toISOString() }, ...filtered]
        .slice(0, MAX_HISTORY_DAYS);

      await kv.set(key, updated, { ex: MAX_HISTORY_DAYS * 24 * 60 * 60 });
      return res.status(200).json({ ok: true, count: updated.length });
    }

    return safeError(res, 405, 'Method not allowed');
  } catch (err) {
    console.error('[history] error:', err?.message);
    return safeError(res, 500, 'Storage unavailable');
  }
}
