// api/events.js — manual family event CRUD
import { kv } from '@vercel/kv';

const MAX_EVENTS = 1000;
const MAX_TEXT = 300;
const TTL = 365 * 24 * 60 * 60;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

function sanitizeEvent(e) {
  if (!e || typeof e !== 'object') return null;
  if (!e.title || !e.start) return null;
  const COLORS = ['coral','blue','green','purple','rose','amber','teal','slate'];
  return {
    id: e.id || Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    title: String(e.title).slice(0, MAX_TEXT).trim(),
    description: e.description ? String(e.description).slice(0, MAX_TEXT) : null,
    location: e.location ? String(e.location).slice(0, MAX_TEXT) : null,
    start: e.start ? String(e.start).slice(0, 30) : null,
    end: e.end ? String(e.end).slice(0, 30) : null,
    allDay: !!e.allDay,
    member: e.member ? String(e.member).slice(0, 50) : null,
    color: COLORS.includes(e.color) ? e.color : 'blue',
    _from: 'manual',
    _created: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const code = sanitizeCode(req.headers['x-steddi-code'] || req.query.code);
  if (!code) return safeError(res, 400, 'Missing family code');

  const key = `steddi:events:${code}`;

  try {
    if (req.method === 'GET') {
      const events = await kv.get(key) || [];
      return res.status(200).json({ ok: true, events });
    }

    if (req.method === 'POST') {
      const event = sanitizeEvent(req.body);
      if (!event) return safeError(res, 400, 'Invalid event data');
      const events = await kv.get(key) || [];
      if (events.length >= MAX_EVENTS) return safeError(res, 400, 'Max events reached');
      events.push(event);
      await kv.set(key, events, { ex: TTL });
      return res.status(201).json({ ok: true, event });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || req.query;
      if (!id) return safeError(res, 400, 'Missing event id');
      const events = (await kv.get(key) || []).filter(e => e.id !== id);
      await kv.set(key, events, { ex: TTL });
      return res.status(200).json({ ok: true });
    }

    return safeError(res, 405, 'Method not allowed');
  } catch(err) {
    console.error('[events] error:', err?.message);
    return safeError(res, 500, 'Storage error');
  }
}
