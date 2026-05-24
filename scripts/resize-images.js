'use strict';

/**
 * resize-images.js
 *
 * Resizes every image in docs/images/ so that neither dimension exceeds
 * MAX_PX pixels (default 1280, suitable for a 720p screen).
 *
 * Uses the built-in macOS `sips` tool — no extra npm packages needed.
 *
 * Usage:
 *   node scripts/resize-images.js          # resize to 1280 px max
 *   node scripts/resize-images.js 960      # custom max size
 */

var { execSync } = require('child_process');
var fs           = require('fs');
var path         = require('path');

var MAX_PX     = parseInt(process.argv[2], 10) || 1280;
var QUALITY    = 82;   // JPEG quality (0-100)
var IMAGES_DIR = path.join(__dirname, '..', 'docs', 'images');

/* Images that should never be resized (logos, wordmarks, etc.) */
var SKIP = new Set(['Dellenbaden.png', 'DellenbadenLogo.jpg']);

var IMAGE_EXT = /\.(jpe?g|png|gif|tiff?|bmp|webp)$/i;

var files = fs.readdirSync(IMAGES_DIR).filter(function (f) {
  return IMAGE_EXT.test(f) && !SKIP.has(f);
});

var resized = 0;
var skipped = 0;

console.log('Resize images in docs/images/  (max ' + MAX_PX + ' px)\n' + '─'.repeat(50));

files.forEach(function (f) {
  var fullPath = path.join(IMAGES_DIR, f);

  /* Read current dimensions */
  var info;
  try {
    info = execSync(
      'sips -g pixelWidth -g pixelHeight ' + JSON.stringify(fullPath),
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (e) {
    console.log('  SKIP (unreadable): ' + f);
    skipped++;
    return;
  }

  var wm = info.match(/pixelWidth\s*:\s*(\d+)/);
  var hm = info.match(/pixelHeight\s*:\s*(\d+)/);
  if (!wm || !hm) { skipped++; return; }

  var w = parseInt(wm[1], 10);
  var h = parseInt(hm[1], 10);

  if (w <= MAX_PX && h <= MAX_PX) {
    console.log('  OK  ' + f + '  (' + w + 'x' + h + ')');
    skipped++;
    return;
  }

  try {
    execSync(
      'sips -Z ' + MAX_PX + ' --setProperty formatOptions ' + QUALITY +
      ' ' + JSON.stringify(fullPath) + ' --out ' + JSON.stringify(fullPath),
      { stdio: 'ignore' }
    );

    var after = execSync(
      'sips -g pixelWidth -g pixelHeight ' + JSON.stringify(fullPath),
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    var wm2 = after.match(/pixelWidth\s*:\s*(\d+)/);
    var hm2 = after.match(/pixelHeight\s*:\s*(\d+)/);
    var newDims = (wm2 && hm2) ? wm2[1] + 'x' + hm2[1] : '?';

    console.log('  ✓   ' + f + '  ' + w + 'x' + h + '  →  ' + newDims);
    resized++;
  } catch (e) {
    console.error('  ERR ' + f + ': ' + e.message);
  }
});

console.log('\n' + resized + ' resized, ' + skipped + ' already small enough.\n');
