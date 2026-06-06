// Vercel serverless endpoint — store and retrieve Claude usage data
// Storage: Vercel KV (Redis). Set up via Vercel dashboard → Storage → KV.
import { kv } from '@vercel/kv';

const KV_KEY = 'claude_usage';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!process.env.API_TOKEN || token !== process.env.API_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionPct, weeklyPct, sessionResets, weeklyResets } = req.body || {};

    if (
      typeof sessionPct !== 'number' ||
      typeof weeklyPct !== 'number' ||
      sessionPct < 0 || sessionPct > 100 ||
      weeklyPct < 0 || weeklyPct > 100
    ) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const data = {
      sessionPct,
      weeklyPct,
      sessionResets: sessionResets || '',
      weeklyResets: weeklyResets || '',
      updatedAt: new Date().toISOString(),
    };

    await kv.set(KV_KEY, data);
    return res.status(200).json({ success: true });
  }

  if (req.method === 'GET') {
    const data = await kv.get(KV_KEY);
    return res.status(200).json(data || {
      sessionPct: 0,
      weeklyPct: 0,
      sessionResets: '',
      weeklyResets: '',
      updatedAt: null,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
