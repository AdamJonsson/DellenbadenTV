'use strict';

var https   = require('https');
var http    = require('http');
var fs      = require('fs');
var path    = require('path');
var cheerio = require('cheerio');

var PROGRAMS_URL = 'https://dellenbaden.se/program';
var MENU_URL     = 'https://dellenbaden.se/meny';
var DATA_DIR     = path.join(__dirname, '..', 'docs', 'data');

// Match the day-name + date portion of a program line, e.g.:
//   "Lördag 13/6 19.00"  or  "Midsommarafton 19/6 19.00"
var DATE_RE = new RegExp(
  '^(' + [
    'm[åa]ndag','tisdag','onsdag','torsdag','fredag',
    'l[öo]rdag','s[öo]ndag',
    'midsommarafton','midsommardagen',
    'p[åa]skafton','p[åa]skdagen',
    'kristi\\s+himmelsfärdsdag','pingstdagen'
  ].join('|') + ')' +
  '\\s+(\\d{1,2})\\/(\\d{1,2})' +
  '(?:\\s+(\\d{1,2})[.:]?(\\d{2}))?',
  'i'
);

var EVENT_TYPE_RE = /^(Musikkväll|Gudstjänst|Sommargudstjänst|Musikprogram|Sommarprogram|Lyskvälls?konsert)\s*/i;

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function fetchUrl(targetUrl) {
  return new Promise(function (resolve, reject) {
    var parsed = new URL(targetUrl);
    var client = parsed.protocol === 'https:' ? https : http;
    var opts = {
      hostname : parsed.hostname,
      path     : parsed.pathname + (parsed.search || ''),
      headers  : {
        'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Accept'          : 'text/html,application/xhtml+xml',
        'Accept-Language' : 'sv-SE,sv;q=0.9,en;q=0.8'
      }
    };
    var req = client.get(opts, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchUrl(res.headers.location));
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      res.setEncoding('utf8');
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end',  function ()  { resolve(body); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, function () { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveUrl(src, base) {
  if (!src) return null;
  src = src.trim();
  if (!src || src.startsWith('data:')) return null;
  try {
    var u = new URL(src, base);
    u.search = '';  // strip image-processor resize/crop params → full resolution
    return u.href;
  } catch (e) { return null; }
}

// Store dates as UTC midnight to avoid timezone shift when formatting later
function toISODate(day, month) {
  var year = new Date().getUTCFullYear();
  var d = new Date(Date.UTC(year, parseInt(month, 10) - 1, parseInt(day, 10)));
  // If date is already more than ~6 months ago, assume next year
  if (Date.now() - d.getTime() > 6 * 30 * 24 * 60 * 60 * 1000) {
    d = new Date(Date.UTC(year + 1, parseInt(month, 10) - 1, parseInt(day, 10)));
  }
  return d.toISOString();
}

// Decode common HTML entities and collapse whitespace
function cleanText(t) {
  return (t || '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Split a span's innerHTML into lines by treating <br> as newlines,
// stripping all other tags, and filtering empty results.
function spanLines(innerHtml) {
  return (innerHtml || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map(cleanText)
    .filter(Boolean);
}

// ─── Programs parser ──────────────────────────────────────────────────────────
//
// Structure (per event — all within one <p> element):
//
//   <span bold>Day D/M HH.MM [EventType]<br>ArtistName<br></span>
//   [<span bold>ArtistName<br></span>]       ← sometimes split across bold spans
//   [<span bold italic><a>Smakprov!</a></span>]  ← YouTube preview link — skip
//   <span normal>Description text</span>
//
// Images for events are in DOM order (program2x/ folder), 1-to-1 with events.

function parsePrograms(html) {
  var $      = cheerio.load(html);
  var events = [];

  // ── 1. Collect event images in DOM order ─────────────────────────────────
  var images = [];
  $('img').each(function () {
    var src = $(this).attr('src') || '';
    var w   = parseInt($(this).attr('width')  || '0', 10);
    var h   = parseInt($(this).attr('height') || '0', 10);
    if ((w > 0 && w < 60) || (h > 0 && h < 60) || w > 300) return;
    if (!/\/program\d/i.test(src)) return;
    var resolved = resolveUrl(src, PROGRAMS_URL);
    if (resolved) images.push(resolved);
  });

  // ── 2. Parse events from <p> elements ────────────────────────────────────
  $('p').each(function () {
    var el = $(this);

    // Require at least one bold span
    var boldSpans = el.find('span').filter(function () {
      return /font-weight\s*:\s*bold/i.test($(this).attr('style') || '');
    });
    if (!boldSpans.length) return;

    // Full text must contain a date pattern
    var fullText = cleanText(el.text());
    var m = fullText.match(DATE_RE);
    if (!m) return;

    // ── Extract name lines from bold spans ──
    // Skip wrapper bold spans (those containing nested child spans) — they are
    // styling containers like <span bold><span normal>description</span></span>
    // and would pollute the name extraction with description text.
    var allBoldLines = [];
    var seenLine = {};
    boldSpans.each(function () {
      if ($(this).find('span').length > 0) return; // nested wrapper — skip
      spanLines($(this).html() || '').forEach(function (line) {
        if (!seenLine[line]) { seenLine[line] = true; allBoldLines.push(line); }
      });
    });

    // Walk the lines: everything after the DATE line is the artist name
    var afterDate  = false;
    var nameParts  = [];
    allBoldLines.forEach(function (line) {
      if (!afterDate) {
        if (DATE_RE.test(line)) afterDate = true;
      } else {
        if (/smakprov/i.test(line)) return;       // skip YouTube preview links
        if (/^[.\s!?,;:–—]+$/.test(line)) return; // skip pure punctuation lines
        var name = line.replace(EVENT_TYPE_RE, '').trim();
        if (name) nameParts.push(name);
      }
    });
    // Strip any stray trailing punctuation that leaked from adjacent spans
    var artistName = nameParts.join(' ').trim().replace(/\s*[.\s!?,;:–—]+\s*$/, '').trim();

    // ── Extract description from normal-weight spans ──
    var descParts = [];
    var seenDesc  = {};
    el.find('span').filter(function () {
      return /font-weight\s*:\s*normal/i.test($(this).attr('style') || '');
    }).each(function () {
      var t = cleanText($(this).text());
      if (t && !seenDesc[t] && !/smakprov/i.test(t)) {
        seenDesc[t] = true;
        descParts.push(t);
      }
    });
    var desc = descParts.join(' ').replace(/\s+/g, ' ').trim();

    // Fallback: remaining text not in any bold span
    if (!desc) {
      var boldText  = allBoldLines.join(' ');
      var remaining = fullText.replace(boldText, '').replace(/\s+/g, ' ').trim();
      remaining = remaining.replace(/smakprov[!]?/gi, '').trim();
      if (remaining.length > 10) desc = remaining;
    }

    // Fallback: no artist name → lift first sentence of desc as title
    if (!artistName && desc) {
      var dot = desc.indexOf('.');
      if (dot > 2 && dot < 70) {
        artistName = desc.substring(0, dot + 1).trim();
        desc       = desc.substring(dot + 1).trim();
      } else {
        artistName = desc;
        desc       = '';
      }
    }

    // Ultimate fallback: use event type label
    if (!artistName) {
      var et = fullText.substring(m[0].length).trim().match(EVENT_TYPE_RE);
      artistName = et ? et[1] : 'Program';
    }

    events.push({
      date       : toISODate(m[2], m[3]),
      time       : m[4] ? m[4] + ':' + m[5] : null,
      title      : artistName,
      description: desc,
      imageUrl   : null
    });
  });

  // ── 3. Assign images in order (1-to-1 with events) ───────────────────────
  events.forEach(function (e, i) {
    if (i < images.length) e.imageUrl = images[i];
  });

  // ── 4. Keep only future events with a real title ──────────────────────────
  var today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  return events.filter(function (e) {
    return e.date && new Date(e.date) >= today && e.title;
  }).sort(function (a, b) {
    var da = new Date(a.date) - new Date(b.date);
    if (da !== 0) return da;
    return (a.time || '').localeCompare(b.time || '');
  });
}

// ─── Menu parser ──────────────────────────────────────────────────────────────
//
// Structure (per item):
//   <img>                                    ← photo
//   <p>
//     <span bold>Name [* NYHET 2025 *]</span>
//     <br>
//     [inline description]
//   </p>
//   [<p>description if in a separate paragraph</p>]
//   <h3>XX kr</h3>
//
// OR (for "Jollen"):
//   <img>
//   <p>Jollen</p>                            ← plain text, no bold span
//   <p>Barnbägare med…</p>
//   <h3>51 kr</h3>

function parseMenu(html) {
  var $      = cheerio.load(html);
  var items  = [];
  var cur    = null;
  var pendingImg = null;

  var PRICE_RE    = /^(\d+)\s*kr$/i;
  var NYHET_RE    = /\s*\*?\s*(ny(het)?|new)\s+\d{4}\s*\*?\s*/gi;
  // Lines that are clearly from the simple price list (end with a bare price)
  var PRICE_LIST_RE = /\d+kr\s*$/i;
  var SKIP_RE       = /^(Vi (är|har|presenterar)|Priser|Glass:|Topping:|Strössel:|@|Copyright)/i;

  $('p, h3, img').each(function () {
    var el  = $(this);
    var tag = this.tagName.toLowerCase();

    // ── Image ──────────────────────────────────────────────────────────────
    if (tag === 'img') {
      var src = el.attr('src') || '';
      var w   = parseInt(el.attr('width')  || '0', 10);
      var h   = parseInt(el.attr('height') || '0', 10);
      if ((w > 0 && w < 60) || (h > 0 && h < 60) || w > 300) return;
      var resolved = resolveUrl(src, MENU_URL);
      if (!resolved) return;
      if (cur && !cur.imageUrl) { cur.imageUrl = resolved; }
      else                       { pendingImg   = resolved; }
      return;
    }

    var rawText = cleanText(el.text());
    if (!rawText) return;

    // ── Price H3 → close current item ─────────────────────────────────────
    if (tag === 'h3') {
      if (PRICE_RE.test(rawText)) {
        if (cur) { cur.price = rawText; items.push(cur); cur = null; }
      } else {
        // Section header
        if (cur) { items.push(cur); cur = null; }
        pendingImg = null;
      }
      return;
    }

    // ── Paragraph ──────────────────────────────────────────────────────────
    if (SKIP_RE.test(rawText) || PRICE_LIST_RE.test(rawText)) return;
    if (rawText.length < 2) return;

    // Does this <p> have a bold span? → start a new item
    var boldSpan = el.find('span').filter(function () {
      return /font-weight\s*:\s*bold/i.test($(this).attr('style') || '');
    }).first();

    if (boldSpan.length) {
      if (cur) items.push(cur);

      var name = cleanText(boldSpan.text())
        .replace(NYHET_RE, '')
        .replace(/\s+/g, ' ')
        .trim();

      // Everything in the <p> beyond the bold span text = inline description
      var boldText  = cleanText(boldSpan.text()).replace(NYHET_RE, '').replace(/\s+/g, ' ').trim();
      var remaining = rawText.replace(boldText, '').replace(NYHET_RE, '').replace(/\s+/g, ' ').trim();

      cur = { name: name, description: remaining, price: '', imageUrl: pendingImg || null };
      pendingImg = null;

    } else if (!cur) {
      // Plain-text name paragraph (like "Jollen") — short, no excessive spaces
      if (rawText.length < 60 && !/\s{3,}/.test(rawText)) {
        cur = { name: rawText, description: '', price: '', imageUrl: pendingImg || null };
        pendingImg = null;
      }

    } else if (!cur.description && rawText.length >= 15) {
      cur.description = rawText;
    }
  });

  if (cur) items.push(cur);

  return items.filter(function (item) { return item.name; });
}

// ─── I/O ──────────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  console.log('  → saved ' + path.basename(filePath) + ' (' + data.length + ' items)');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Dellenbaden data fetcher\n' + '─'.repeat(44));
  ensureDir(DATA_DIR);

  console.log('\nFetching programs…');
  try {
    var pHtml    = await fetchUrl(PROGRAMS_URL);
    var programs = parsePrograms(pHtml);
    programs.forEach(function (p) {
      var img = p.imageUrl ? '📷' : '  ';
      console.log('  ' + img + ' ' + p.date.slice(0, 10) + '  ' + (p.time || '     ') + '  ' + p.title);
    });
    saveJson(path.join(DATA_DIR, 'programs.json'), programs);
  } catch (e) {
    console.error('  ERROR:', e.message);
    saveJson(path.join(DATA_DIR, 'programs.json'), []);
  }

  console.log('\nFetching menu…');
  try {
    var mHtml = await fetchUrl(MENU_URL);
    var menu  = parseMenu(mHtml);
    menu.forEach(function (m) {
      var img = m.imageUrl ? '📷' : '  ';
      console.log('  ' + img + ' ' + m.name + (m.price ? '  ' + m.price : ''));
    });
    saveJson(path.join(DATA_DIR, 'menu.json'), menu);
  } catch (e) {
    console.error('  ERROR:', e.message);
    saveJson(path.join(DATA_DIR, 'menu.json'), []);
  }

  console.log('\n✓ Done. Serve the public/ folder to preview the TV page.\n');
}

main();
