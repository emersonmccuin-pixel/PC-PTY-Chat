// Section 10 Phase 1 polish — rasterize the Caisson mark (apps/web/public/
// icon.svg, 1024²) into build/icon.png. electron-builder generates the Windows
// .ico from this PNG; the BrowserWindow taskbar icon uses it directly. sharp is
// a build-time devDep only — never shipped in the packaged app.

import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Desktop-specific icon (padding trimmed, brighter edge, centered+scaled mark)
// — kept separate from apps/web/public/icon.svg so the web favicon is untouched.
const SVG = resolve(__dirname, '..', 'build-src', 'icon.svg');
const OUT_DIR = resolve(__dirname, '..', 'build');
const OUT = resolve(OUT_DIR, 'icon.png');

mkdirSync(OUT_DIR, { recursive: true });
await sharp(SVG, { density: 384 }).resize(1024, 1024).png().toFile(OUT);
console.log('icon →', OUT);
