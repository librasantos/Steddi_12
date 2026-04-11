// api/collab.js — activity log, comments, presence tracking
import { kv } from '@vercel/kv';

const MAX_ACTIVITY = 200;
const MAX_COMMENTS = 500;
const MAX_TEXT = 500;
const TTL = 30 * 24 * 60 * 60;
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 60;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Steddi-Code, X-Steddi-User',
  'Content-Type': 'application/json',
};

function setCORS(res) { Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v)); }
function safeError(res, status, msg) { return res.status(status).json({ error: msg }); }
function sanitizeCode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const c = raw.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,32);
  return c.length >= 3 ? c : null;
}
function sanitizeUser(raw) {
  if (!raw || typeof raw !== 'string') return 'Someone';
  return raw.replace(/[<>]/g,'').slice(0,30).trim() || 'Someone';
}

async function rateLimit(code) {
  const key = `steddi:rate:collab:${code}`;
  try {
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, RATE_LIMIT_WINDOW);
    return n <= RATE_LIMIT_MAX;
  } catch { return true; }
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const code = sanitizeCode(req.headers['x-steddi-code'] || req.query.code);
  if (!code) return safeError(res, 400, 'Missing family code');

  if (!await rateLimit(code)) {
    res.setHeader('Retry-After', String(RATE_LIMIT_WINDOW));
    return safeError(res, 429, 'Too many requests');
  }

  const userName = sanitizeUser(req.headers['x-steddi-user'] || req.query.user);
  const activityKey = `steddi:activity:${code}`;
  const commentsKey = `steddi:comments:${code}`;
  const presenceKey = `steddi:presence:${code}`;

  try {
    // GET — fetch activity, comments, presence
    if (req.method === 'GET') {
      const [activity, comments, presence] = await Promise.all([
        kv.get(activityKey),
        kv.get(commentsKey),
        kv.get(presenceKey),
      ]);

      // Update presence (who's currently online)
      const now = Date.now();
      const presenceMap = presence || {};
      presenceMap[userName] = { lastSeen: now, name: userName };
      // Clean up stale (>2 min)
      Object.keys(presenceMap).forEach(u => {
        if (now - presenceMap[u].lastSeen > 120000) delete presenceMap[u];
      });
      await kv.set(presenceKey, presenceMap, { ex: 300 });

      const activeUsers = Object.values(presenceMap)
        .filter(u => now - u.lastSeen < 120000)
        .map(u => u.name);

      return res.status(200).json({
        ok: true,
        activity: (activity || []).slice(0, 50),
        comments: comments || [],
        activeUsers,
        serverTime: new Date().toISOString(),
      });
    }

    // POST — log activity or add comment
    if (req.method === 'POST') {
      const { type, action, text, taskText, eventTitle, targetId } = req.body || {};

      if (type === 'activity') {
        // Log an activity event
        if (!action) return safeError(res, 400, 'Missing action');
        const entry = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2,5),
          user: userName,
          action: String(action).slice(0, 100),
          taskText: taskText ? String(taskText).slice(0, 100) : null,
          eventTitle: eventTitle ? String(eventTitle).slice(0, 100) : null,
          timestamp: new Date().toISOString(),
        };
        const existing = await kv.get(activityKey) || [];
        const updated = [entry, ...existing].slice(0, MAX_ACTIVITY);
        await kv.set(activityKey, updated, { ex: TTL });
        return res.status(200).json({ ok: true, entry });
      }

      if (type === 'comment') {
        if (!text || !text.trim()) return safeError(res, 400, 'Missing comment text');
        const entry = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2,5),
          user: userName,
          text: String(text).slice(0, MAX_TEXT).trim(),
          targetId: targetId ? String(targetId).slice(0, 100) : 'general',
          timestamp: new Date().toISOString(),
        };
        const existing = await kv.get(commentsKey) || [];
        const updated = [entry, ...existing].slice(0, MAX_COMMENTS);
        await kv.set(commentsKey, updated, { ex: TTL });
        return res.status(200).json({ ok: true, entry });
      }

      if (type === 'presence') {
        // Just update presence
        const presenceMap = await kv.get(presenceKey) || {};
        presenceMap[userName] = { lastSeen: Date.now(), name: userName };
        await kv.set(presenceKey, presenceMap, { ex: 300 });
        return res.status(200).json({ ok: true });
      }

      return safeError(res, 400, 'Unknown type');
    }

    return safeError(res, 405, 'Method not allowed');
  } catch(err) {
    console.error('[collab] error:', err?.message);
    return safeError(res, 500, 'Storage error');
  }
}
