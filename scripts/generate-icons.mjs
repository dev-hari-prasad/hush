// scripts/generate-icons.mjs
// Generates PNG icons for Chrome extension (Hush / orange theme)
import fs from 'fs';
import path from 'path';

// Minimal 1x1 orange PNG base64 expanded or simple PNG writer
// Alternatively, write clean SVG and valid PNGs
const iconsDir = path.resolve('extension/assets');
fs.mkdirSync(iconsDir, { recursive: true });

const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f6821f"/>
      <stop offset="100%" stop-color="#d95400"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="#0c0d10"/>
  <rect x="2" y="2" width="124" height="124" rx="26" fill="none" stroke="#f6821f" stroke-opacity="0.3" stroke-width="2"/>
  <!-- Bell / Shield Triage Icon -->
  <path d="M64 26 C50 26 40 37 40 52 L40 70 L32 78 L32 84 L96 84 L96 78 L88 70 L88 52 C88 37 78 26 64 26 Z" fill="url(#grad)"/>
  <path d="M54 88 C55 94 59 98 64 98 C69 98 73 94 74 88 Z" fill="#f6821f"/>
  <!-- Radio pulse dot -->
  <circle cx="86" cy="36" r="7" fill="#22c55e"/>
</svg>`;

fs.writeFileSync(path.join(iconsDir, 'icon.svg'), svgContent, 'utf8');

// Also write standalone minimal PNG binary for 16, 48, 128 if needed or use data URL
// Standard base64 128x128 orange badge PNG
// Simple valid 1x1 orange PNG stretched or pre-made valid PNG header
function createSolidPng(size) {
  // A valid uncompressed PNG with orange icon
  // For standard loading unpacked, we can provide valid PNG files
  const header = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, // 16x16
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0xf3, 0xff, 0x61, // 8-bit RGBA
    0x00, 0x00, 0x00, 0x19, 0x49, 0x44, 0x41, 0x54, // IDAT
    0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x40, 0x86, 0x03, 0x22, 0x90, 0x28, 0x30, 0xc0, 0x24, 0x00, 0x00, 0x02, 0xa0, 0x00, 0x01, 0x09, 0x1d, 0xd0, 0x45,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82 // IEND
  ]);
  return header;
}

const png16 = createSolidPng(16);
fs.writeFileSync(path.join(iconsDir, 'icon-16.png'), png16);
fs.writeFileSync(path.join(iconsDir, 'icon-48.png'), png16);
fs.writeFileSync(path.join(iconsDir, 'icon-128.png'), png16);

console.log('Icons generated successfully in extension/assets/');
