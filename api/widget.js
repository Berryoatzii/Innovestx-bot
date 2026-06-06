// Generates a dark-themed SVG widget image with pixel-art character.
// Android widget apps (KWGT, Widgetsmith-style) can display this URL directly.
import { kv } from '@vercel/kv';

const KV_KEY = 'claude_usage';

// ── Pixel art character ───────────────────────────────────────────────────────
// 10 columns × 10 rows; symbols: P=pink, E=eye(dark), W=white, -=transparent
const FRAMES = {
  // Normal — forward facing, small smile
  normal: [
    '-PP---PP--',
    '-PPPPPPPP-',
    'PPPPPPPPPP',
    'PPEPPPPEPP', // eyes at col 2 & 7
    'PPPPPPPPPP',
    'PPPWWPPPPP', // teeth at col 3 & 4
    '-PPPPPPPP-',
    '-PP----PP-',
    '-PP----PP-',
    'PP------PP',
  ],
  // Happy — wider grin
  happy: [
    '-PP---PP--',
    '-PPPPPPPP-',
    'PPPPPPPPPP',
    'PPEPPPPEPP',
    'PPPPPPPPPP',
    'PP-WWWWW-P', // bigger smile
    '-PPPPPPPP-',
    '-PP----PP-',
    '-PP----PP-',
    'PP------PP',
  ],
  // Tired — half-closed eyes
  tired: [
    '-PP---PP--',
    '-PPPPPPPP-',
    'PPPPPPPPPP',
    'PPPPPPPPPP', // no eyes on this row
    'PPEPPPPEPP', // eyes shifted down one row
    'PPPWWPPPPP',
    '-PPPPPPPP-',
    '-PP----PP-',
    '-PP----PP-',
    'PP------PP',
  ],
  // Maxed — X eyes (overloaded)
  maxed: [
    '-PP---PP--',
    '-PPPPPPPP-',
    'PPPPPPPPPP',
    'PPXPPPXPPP', // X eyes (X = different dark cross)
    'PPPEPPEPPP',
    'PPPWWPPPPP',
    '-PPPPPPPP-',
    '-PP----PP-',
    '-PP----PP-',
    'PP------PP',
  ],
};

function renderChar(offsetX, offsetY, pixelSize, pose) {
  const PINK  = '#e87070';
  const DARK  = '#1a1a2e';
  const WHITE = '#ffffff';
  const CROSS = '#cc3333'; // X eye

  const grid = FRAMES[pose] || FRAMES.normal;
  const rects = [];

  grid.forEach((row, r) => {
    [...row].forEach((cell, c) => {
      let fill = null;
      if      (cell === 'P') fill = PINK;
      else if (cell === 'E') fill = DARK;
      else if (cell === 'W') fill = WHITE;
      else if (cell === 'X') fill = CROSS;
      // '-' = transparent, skip

      if (fill) {
        rects.push(
          `<rect x="${offsetX + c * pixelSize}" y="${offsetY + r * pixelSize}" ` +
          `width="${pixelSize}" height="${pixelSize}" fill="${fill}" shape-rendering="crispEdges"/>`
        );
      }
    });
  });

  return rects.join('\n    ');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeSince(isoStr) {
  if (!isoStr) return 'never';
  const diffMin = Math.floor((Date.now() - new Date(isoStr).getTime()) / 60000);
  if (diffMin < 1)  return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusFor(sessionPct, weeklyPct) {
  const m = Math.max(sessionPct, weeklyPct);
  if (m >= 90) return { text: 'maxed out', color: '#ff4444', pose: 'maxed' };
  if (m >= 70) return { text: 'heavy load', color: '#ff8844', pose: 'tired' };
  if (m >= 40) return { text: 'grinding',  color: '#ffcc44', pose: 'happy' };
  if (m >= 10) return { text: 'vibing',    color: '#44dd88', pose: 'happy' };
  return        { text: 'chilling',  color: '#4488ff', pose: 'normal' };
}

function barColor(pct) {
  if (pct >= 90) return '#ff4444';
  if (pct >= 70) return '#ff8844';
  if (pct >= 40) return '#ffcc44';
  return '#4a9fff';
}

// ── SVG builder ───────────────────────────────────────────────────────────────

function buildSVG(data) {
  const {
    sessionPct   = 0,
    weeklyPct    = 0,
    sessionResets = '',
    weeklyResets  = '',
    updatedAt,
  } = data;

  const W = 400, H = 210;
  const DIVIDER = 170;
  const BAR_X   = DIVIDER + 10;
  const BAR_W   = W - BAR_X - 16;

  const { text: statusText, color: statusColor, pose } = statusFor(sessionPct, weeklyPct);

  const PIXEL = 13;
  const CHAR_W = 10 * PIXEL;
  const CHAR_H = 10 * PIXEL;
  const charX  = Math.floor((DIVIDER - CHAR_W) / 2);
  const charY  = Math.floor((H - CHAR_H) / 2) - 16;

  const sPct  = Math.min(Math.max(sessionPct, 0), 100);
  const wPct  = Math.min(Math.max(weeklyPct, 0), 100);
  const sBarW = Math.round(BAR_W * sPct / 100);
  const wBarW = Math.round(BAR_W * wPct / 100);

  const charSvg = renderChar(charX, charY, PIXEL, pose);
  const ago     = timeSince(updatedAt);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">

  <!-- Background -->
  <rect width="${W}" height="${H}" rx="20" fill="#111118"/>

  <!-- Left panel -->
  <rect width="${DIVIDER}" height="${H}" rx="20" fill="#1a1a28"/>
  <rect x="${DIVIDER - 8}" width="8" height="${H}" fill="#1a1a28"/>

  <!-- Pixel-art character -->
  ${charSvg}

  <!-- Status label -->
  <text x="${DIVIDER / 2}" y="${H - 36}"
    font-family="'Courier New',Courier,monospace" font-size="15" font-weight="bold"
    fill="${statusColor}" text-anchor="middle">${statusText}</text>

  <!-- Mini stats under character -->
  <text x="${DIVIDER / 2}" y="${H - 18}"
    font-family="'Courier New',Courier,monospace" font-size="9"
    fill="#555577" text-anchor="middle">5h ${sPct}%  /  7d ${wPct}%</text>

  <!-- ── Right panel ── -->

  <!-- Header row -->
  <text x="${BAR_X}" y="26"
    font-family="'Courier New',Courier,monospace" font-size="10" font-weight="bold"
    fill="#666688" letter-spacing="2">CLAUDE USAGE</text>

  <!-- Status dot -->
  <circle cx="${W - 20}" cy="20" r="5" fill="${statusColor}"/>

  <!-- Separator -->
  <line x1="${BAR_X}" y1="34" x2="${W - 14}" y2="34" stroke="#222238" stroke-width="1"/>

  <!-- 5-hour label + pct -->
  <text x="${BAR_X}" y="60"
    font-family="'Courier New',Courier,monospace" font-size="17" font-weight="bold"
    fill="#ffffff">5-hour</text>
  <text x="${W - 14}" y="60"
    font-family="'Courier New',Courier,monospace" font-size="17" font-weight="bold"
    fill="#ffffff" text-anchor="end">${sPct}%</text>

  ${sessionResets ? `<text x="${BAR_X}" y="76"
    font-family="'Courier New',Courier,monospace" font-size="9"
    fill="#4455aa">resets in ${sessionResets}</text>` : ''}

  <!-- 5-hour bar -->
  <rect x="${BAR_X}" y="82" width="${BAR_W}" height="7" rx="3.5" fill="#222238"/>
  <rect x="${BAR_X}" y="82" width="${sBarW}" height="7" rx="3.5" fill="${barColor(sPct)}"/>

  <!-- Weekly label + pct -->
  <text x="${BAR_X}" y="116"
    font-family="'Courier New',Courier,monospace" font-size="17" font-weight="bold"
    fill="#ffffff">Weekly</text>
  <text x="${W - 14}" y="116"
    font-family="'Courier New',Courier,monospace" font-size="17" font-weight="bold"
    fill="#ffffff" text-anchor="end">${wPct}%</text>

  ${weeklyResets ? `<text x="${BAR_X}" y="132"
    font-family="'Courier New',Courier,monospace" font-size="9"
    fill="#4455aa">resets in ${weeklyResets}</text>` : ''}

  <!-- Weekly bar -->
  <rect x="${BAR_X}" y="138" width="${BAR_W}" height="7" rx="3.5" fill="#222238"/>
  <rect x="${BAR_X}" y="138" width="${wBarW}" height="7" rx="3.5" fill="${barColor(wPct)}"/>

  <!-- Updated timestamp -->
  <text x="${BAR_X}" y="${H - 14}"
    font-family="'Courier New',Courier,monospace" font-size="9"
    fill="#333355">updated ${ago}</text>

</svg>`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const data = (await kv.get(KV_KEY)) || {};
  const svg  = buildSVG(data);

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).send(svg);
}
