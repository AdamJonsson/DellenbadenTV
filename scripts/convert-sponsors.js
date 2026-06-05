'use strict';

/**
 * convert-sponsors.js
 *
 * Converts every non-PNG image in docs/images/sponsors/ to PNG, then
 * resizes anything larger than MAX_PX so logos stay crisp but lightweight.
 *
 * Uses the built-in macOS `sips` tool — no extra npm packages needed.
 *
 * Usage:
 *   node scripts/convert-sponsors.js
 *
 * After running, update docs/data/sponsors.json so each imageUrl points
 * to the new .png filename.
 */

var { execSync } = require('child_process');
var fs           = require('fs');
var path         = require('path');

var SPONSORS_DIR = path.join(__dirname, '..', 'docs', 'images', 'sponsors');
var MAX_PX       = 1280;
var IMAGE_EXT    = /\.(jpe?g|png|gif|tiff?|bmp|webp|pdf)$/i;

if (!fs.existsSync(SPONSORS_DIR)) {
  fs.mkdirSync(SPONSORS_DIR, { recursive: true });
  console.log('Created docs/images/sponsors/  (no images yet)');
  process.exit(0);
}

var files = fs.readdirSync(SPONSORS_DIR).filter(function (f) {
  return IMAGE_EXT.test(f);
});

if (files.length === 0) {
  console.log('No images found in docs/images/sponsors/ — nothing to do.');
  process.exit(0);
}

var converted = 0;
var resized   = 0;
var already   = 0;

console.log('Convert & resize sponsor images\n' + '─'.repeat(50));

files.forEach(function (f) {
  var ext      = path.extname(f).toLowerCase();
  var base     = path.basename(f, ext);
  var fullPath = path.join(SPONSORS_DIR, f);
  var pngPath  = path.join(SPONSORS_DIR, base + '.png');

  /* ── Convert to PNG if needed ─── */
  if (ext !== '.png') {
    try {
      execSync(
        'sips -s format png ' + JSON.stringify(fullPath) +
        ' --out ' + JSON.stringify(pngPath),
        { stdio: 'ignore' }
      );
      fs.unlinkSync(fullPath);
      console.log('  ✓ Converted  ' + f + '  →  ' + base + '.png');
      converted++;
    } catch (e) {
      console.error('  ERR converting ' + f + ': ' + e.message);
      return;
    }
    fullPath = pngPath;
  }

  /* ── Resize if too large ─── */
  var info;
  try {
    info = execSync(
      'sips -g pixelWidth -g pixelHeight ' + JSON.stringify(fullPath),
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (e) {
    return;
  }

  var wm = info.match(/pixelWidth\s*:\s*(\d+)/);
  var hm = info.match(/pixelHeight\s*:\s*(\d+)/);
  if (!wm || !hm) return;

  var w = parseInt(wm[1], 10);
  var h = parseInt(hm[1], 10);

  if (w > MAX_PX || h > MAX_PX) {
    try {
      execSync(
        'sips -Z ' + MAX_PX + ' ' + JSON.stringify(fullPath),
        { stdio: 'ignore' }
      );
      var after = execSync(
        'sips -g pixelWidth -g pixelHeight ' + JSON.stringify(fullPath),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      var wm2 = after.match(/pixelWidth\s*:\s*(\d+)/);
      var hm2 = after.match(/pixelHeight\s*:\s*(\d+)/);
      console.log('  ✓ Resized    ' + base + '.png  ' +
        w + 'x' + h + '  →  ' + (wm2 ? wm2[1] : '?') + 'x' + (hm2 ? hm2[1] : '?'));
      resized++;
    } catch (e) {
      console.error('  ERR resizing ' + base + '.png: ' + e.message);
    }
  } else {
    if (ext === '.png') {
      console.log('  OK           ' + f + '  (' + w + 'x' + h + ')');
      already++;
    }
  }
});

console.log(
  '\n' + converted + ' converted to PNG, ' +
  resized + ' resized, ' +
  already + ' already OK.\n'
);
