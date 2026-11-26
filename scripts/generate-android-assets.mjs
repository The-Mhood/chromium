// Generates the launcher icons and the Android TV home-screen banner from the brand mark.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const res = path.join(root, 'android-tv/app/src/main/res');
const mark = await fs.readFile(path.join(root, 'public/core.svg'), 'utf8');
const inner = mark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const icons = { 'mipmap-mdpi': 48, 'mipmap-hdpi': 72, 'mipmap-xhdpi': 96, 'mipmap-xxhdpi': 144, 'mipmap-xxxhdpi': 192 };
for (const [folder, size] of Object.entries(icons)) {
  await fs.mkdir(path.join(res, folder), { recursive: true });
  await sharp(Buffer.from(mark)).resize(size, size).png().toFile(path.join(res, folder, 'ic_launcher.png'));
}

// Android TV banner: 320x180 px at xhdpi, shown in the launcher row.
const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d2128"/><stop offset="1" stop-color="#12151a"/></linearGradient></defs>
  <rect width="320" height="180" fill="url(#bg)"/>
  <g transform="translate(124 24) scale(1.8)">${inner}</g>
  <text x="160" y="132" text-anchor="middle" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="25" font-weight="700" fill="#ffffff">chromium<tspan fill="#ed7545">core</tspan></text>
  <text x="160" y="154" text-anchor="middle" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" font-size="11" letter-spacing="2" fill="#8d94a0">FOR ANDROID TV</text>
</svg>`;
await fs.mkdir(path.join(res, 'drawable-xhdpi'), { recursive: true });
await sharp(Buffer.from(banner)).png().toFile(path.join(res, 'drawable-xhdpi/tv_banner.png'));
console.log('Android icons and TV banner generated.');
