// api/family.js — hardened version
// Public read-only endpoint for family board and widget
import { kv } from '@vercel/kv';

const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 60; // higher for read — boards refresh every 15s

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function setCORS(res) { Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v)); }
function safeError(res, status, msg) { return res.status(status).json({ error: msg }); }

function sanitizeCode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const c = raw.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,32);
  return c.length >= 3 ? c : null;
}

// Strip internal fields before returning to client
function sanitizeForPublic(session) {
  return {
    activeTasks: (session.activeTasks || []).map(t=>({ text:t.text, priority:t.priority, recur:t.recur||null, duration:t.duration||null })),
    allTasks:    (session.allTasks || []).map(t=>({ text:t.text, priority:t.priority })),
    doneTasks:   (session.doneTasks || []).map(t=>({ text:t.text, priority:t.priority })),
    deferred:    (session.deferred || []).map(t=>({ text:t.text, priority:t.priority, date:t.date, time:t.time||null })),
    energy:      session.energy || null,
    intention:   session.intention ? String(session.intention).slice(0,500) : null,
    streak:      typeof session.streak === 'number' ? Math.min(session.streak, 9999) : 0,
  };
}

async function checkRateLimit(ip) {
  const key = `steddi:rate:fam:${ip}`;
  try {
    const count = await kv.incr(key);
    if (count === 1) await kv.expire(key, RATE_LIMIT_WINDOW);
    return count <= RATE_LIMIT_MAX;
  } catch { return true; }
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return safeError(res, 405, 'Method not allowed');

  // Rate limit by IP for read endpoint
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!await checkRateLimit(ip)) {
    res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW));
    return safeError(res, 429, 'Too many requests');
  }

  const code = sanitizeCode(req.query.code);
  if (!code) return safeError(res, 400, 'Missing or invalid ?code= parameter (min 3 alphanumeric characters)');

  try {
    const [session, history] = await Promise.all([
      kv.get(`steddi:${code}`),
      kv.get(`steddi:history:${code}`),
    ]);

    if (!session) {
      // Don't confirm whether code exists — return same shape either way
      return res.status(404).json({ ok: false, error: 'No data found for this code' });
    }

    // Add cache hints — data is soft-realtime, 10s is fine
    res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=20');

    return res.status(200).json({
      ok: true,
      synced: session._synced || null,
      ...sanitizeForPublic(session),
      history: Array.isArray(history)
        ? history.slice(0,30).map(e=>({
            date: e.date,
            dateRaw: e.dateRaw,
            done: (e.done||[]).map(t=>({ text:t.text })),
            deferred: (e.deferred||[]).map(t=>({ text:t.text, date:t.date })),
          }))
        : [],
    });
  } catch (err) {
    console.error('[family] error:', err?.message);
    return safeError(res, 500, 'Storage unavailable');
  }
}
