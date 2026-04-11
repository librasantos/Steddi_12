// api/ical.js — fetch and parse iCal feeds, store events in KV
import { kv } from '@vercel/kv';

const RATE_LIMIT_WINDOW = 300; // 5 min between refreshes per code
const MAX_FEEDS = 10;
const MAX_EVENTS_PER_FEED = 500;
const TTL = 30 * 24 * 60 * 60; // 30 days

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

// Minimal iCal parser — handles VEVENT blocks
function parseICal(text) {
  const events = [];
  const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n')
    // Unfold continuation lines
    .replace(/\n[ \t]/g,'').split('\n');

  let inEvent = false;
  let current = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { inEvent = true; current = {}; continue; }
    if (line === 'END:VEVENT') {
      inEvent = false;
      if (current.summary && (current.dtstart || current.dtstart_date)) {
        events.push(current);
        if (events.length >= MAX_EVENTS_PER_FEED) break;
      }
      continue;
    }
    if (!inEvent) continue;

    const [rawKey, ...valueParts] = line.split(':');
    const value = valueParts.join(':').trim();
    const key = rawKey.split(';')[0].toLowerCase();
    const params = rawKey.includes(';') ? rawKey.split(';').slice(1).join(';').toLowerCase() : '';

    if (key === 'summary') current.summary = value.slice(0,300);
    else if (key === 'description') current.description = value.slice(0,500);
    else if (key === 'location') current.location = value.slice(0,200);
    else if (key === 'uid') current.uid = value.slice(0,100);
    else if (key === 'dtstart') {
      if (params.includes('value=date') || value.length === 8) {
        current.allDay = true;
        current.dtstart_date = value.slice(0,8);
      } else {
        current.dtstart = value;
      }
    }
    else if (key === 'dtend') {
      if (params.includes('value=date') || value.length === 8) current.dtend_date = value.slice(0,8);
      else current.dtend = value;
    }
    else if (key === 'rrule') current.rrule = value.slice(0,200);
  }

  return events;
}

function parseICalDate(s) {
  if (!s) return null;
  try {
    // Format: 20240115T143000Z or 20240115T143000 or 20240115
    const clean = s.replace('Z','').replace('T',' ');
    if (clean.length === 8) return new Date(
      clean.slice(0,4)+'-'+clean.slice(4,6)+'-'+clean.slice(6,8)+'T00:00:00Z');
    return new Date(
      clean.slice(0,4)+'-'+clean.slice(4,6)+'-'+clean.slice(6,8)+'T'+
      clean.slice(9,11)+':'+clean.slice(11,13)+':'+clean.slice(13,15)+(s.endsWith('Z')?'Z':''));
  } catch { return null; }
}

function eventToJson(e, feedName, memberColor) {
  const start = parseICalDate(e.dtstart || e.dtstart_date);
  const end = parseICalDate(e.dtend || e.dtend_date);
  if (!start) return null;
  return {
    uid: e.uid || Math.random().toString(36).slice(2),
    title: e.summary || 'Untitled',
    description: e.description || null,
    location: e.location || null,
    start: start.toISOString(),
    end: end ? end.toISOString() : null,
    allDay: !!e.allDay,
    rrule: e.rrule || null,
    source: feedName,
    color: memberColor || null,
    _from: 'ical',
  };
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const code = sanitizeCode(req.headers['x-steddi-code'] || req.query.code);
  if (!code) return safeError(res, 400, 'Missing family code');

  const feedsKey = `steddi:ical:feeds:${code}`;
  const eventsKey = `steddi:ical:events:${code}`;

  try {
    // GET — return stored feeds + events
    if (req.method === 'GET') {
      const [feeds, events] = await Promise.all([
        kv.get(feedsKey),
        kv.get(eventsKey),
      ]);
      return res.status(200).json({ ok: true, feeds: feeds||[], events: events||[] });
    }

    // POST — add a new feed or refresh
    if (req.method === 'POST') {
      const { action, url, name, color } = req.body || {};

      if (action === 'refresh' || action === 'add') {
        const feeds = await kv.get(feedsKey) || [];

        if (action === 'add') {
          if (!url || typeof url !== 'string') return safeError(res, 400, 'Missing url');
          if (!url.startsWith('http')) return safeError(res, 400, 'URL must start with http');
          if (feeds.length >= MAX_FEEDS) return safeError(res, 400, 'Max feeds reached');
          const existing = feeds.find(f => f.url === url);
          if (!existing) {
            feeds.push({
              url: url.slice(0, 500),
              name: (name || 'Calendar').slice(0, 50),
              color: color || null,
              added: new Date().toISOString(),
            });
            await kv.set(feedsKey, feeds, { ex: TTL });
          }
        }

        // Fetch all feeds
        const allEvents = [];
        for (const feed of feeds) {
          try {
            const r = await fetch(feed.url, {
              headers: { 'User-Agent': 'Steddi-Family-Board/1.0' },
              signal: AbortSignal.timeout(8000),
            });
            if (!r.ok) continue;
            const text = await r.text();
            const parsed = parseICal(text);
            const mapped = parsed.map(e => eventToJson(e, feed.name, feed.color)).filter(Boolean);
            allEvents.push(...mapped);
          } catch(e) {
            console.warn('Feed fetch error:', feed.name, e?.message);
          }
        }

        await kv.set(eventsKey, allEvents.slice(0, 2000), { ex: TTL });
        return res.status(200).json({ ok: true, count: allEvents.length, feeds });
      }

      if (action === 'remove') {
        const { feedUrl } = req.body;
        const feeds = (await kv.get(feedsKey) || []).filter(f => f.url !== feedUrl);
        await kv.set(feedsKey, feeds, { ex: TTL });
        return res.status(200).json({ ok: true, feeds });
      }

      return safeError(res, 400, 'Unknown action');
    }

    return safeError(res, 405, 'Method not allowed');
  } catch(err) {
    console.error('[ical] error:', err?.message);
    return safeError(res, 500, 'Error processing request');
  }
}
