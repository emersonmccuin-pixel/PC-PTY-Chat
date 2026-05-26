// Section 10 Phase 1 polish — rasterize the Caisson mark (apps/web/public/
// icon.svg, 1024²) into build/icon.png and, on macOS, build/icon.icns.
// electron-builder generates the Windows .ico from the PNG; macOS packaging
// expects an .icns. sharp is a build-time devDep only — never shipped in the
// packaged app.

import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Desktop-specific icon (padding trimmed, brighter edge, centered+scaled mark)
// — kept separate from apps/web/public/icon.svg so the web favicon is untouched.
const SVG = resolve(__dirname, '..', 'build-src', 'icon.svg');
const OUT_DIR = resolve(__dirname, '..', 'build');
const OUT = resolve(OUT_DIR, 'icon.png');
const ICONSET = resolve(OUT_DIR, 'icon.iconset');
const ICNS = resolve(OUT_DIR, 'icon.icns');

const MAC_ICONSET_ENTRIES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

mkdirSync(OUT_DIR, { recursive: true });
await sharp(SVG, { density: 384 }).resize(1024, 1024).png().toFile(OUT);
console.log('icon →', OUT);

if (process.platform === 'darwin') {
  mkdirSync(ICONSET, { recursive: true });
  for (const [name, size] of MAC_ICONSET_ENTRIES) {
    await sharp(SVG, { density: 384 })
      .resize(size, size)
      .png()
      .toFile(join(ICONSET, name));
  }
  execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', ICNS], {
    stdio: 'inherit',
  });
  console.log('icns →', ICNS);
} else {
  console.log('icns skipped — iconutil is only available on macOS');
}
