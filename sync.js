// api/sync.js — hardened version
import { kv } from '@vercel/kv';

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_TASKS = 100;
const MAX_TEXT_LENGTH = 500;
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 30;
const TTL_DAYS = 7;

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

function sanitizeText(s) {
  return typeof s === 'string' ? s.slice(0, MAX_TEXT_LENGTH).trim() : '';
}

function sanitizeTask(t) {
  if (!t || typeof t !== 'object') return null;
  return {
    id: typeof t.id === 'number' ? t.id : 0,
    text: sanitizeText(t.text || ''),
    priority: ['must','should','nice','later'].includes(t.priority) ? t.priority : 'should',
    duration: t.duration ? String(t.duration).slice(0,10) : null,
    recur: ['daily','weekdays','weekly',''].includes(t.recur||'') ? (t.recur||null) : null,
    date: t.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : null,
    time: t.time && /^\d{2}:\d{2}$/.test(t.time) ? t.time : null,
  };
}

function sanitizeTasks(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0,MAX_TASKS).map(sanitizeTask).filter(Boolean);
}

function sanitizeBody(b) {
  const VALID_PHASES = ['open','ready','checkin','dump-ask','dump','dump-review','select',
                        'tasks','timer-pick','focus','done','hardday','moment','warmup'];
  return {
    phase: VALID_PHASES.includes(b.phase) ? b.phase : null,
    energy: ['low','okay','good'].includes(b.energy) ? b.energy : null,
    activeTasks: sanitizeTasks(b.activeTasks),
    allTasks: sanitizeTasks(b.allTasks),
    doneTasks: sanitizeTasks(b.doneTasks),
    deferred: sanitizeTasks(b.deferred),
    intention: b.intention ? sanitizeText(b.intention) : null,
    streak: typeof b.streak === 'number' && b.streak >= 0 ? Math.min(b.streak, 9999) : 0,
  };
}

async function checkRateLimit(code) {
  const key = `steddi:rate:${code}`;
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
  if (!code) return safeError(res, 400, 'Invalid or missing family code (min 3 alphanumeric characters)');

  if (!await checkRateLimit(code)) {
    res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW));
    return safeError(res, 429, 'Too many requests');
  }

  const key = `steddi:${code}`;

  try {
    if (req.method === 'GET') {
      const data = await kv.get(key);
      return res.status(200).json({ ok: true, data: data||null, synced: data?._synced||null });
    }

    if (req.method === 'POST') {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
        return safeError(res, 400, 'Invalid request body');

      if (JSON.stringify(req.body).length > MAX_PAYLOAD_BYTES)
        return safeError(res, 413, 'Payload too large');

      const toStore = { ...sanitizeBody(req.body), _synced: new Date().toISOString(), _code: code };
      await kv.set(key, toStore, { ex: TTL_DAYS * 24 * 60 * 60 });
      return res.status(200).json({ ok: true, synced: toStore._synced });
    }

    return safeError(res, 405, 'Method not allowed');
  } catch (err) {
    console.error('[sync] error:', err?.message);
    return safeError(res, 500, 'Storage unavailable — please try again');
  }
}
