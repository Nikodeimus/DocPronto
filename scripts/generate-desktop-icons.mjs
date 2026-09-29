import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sizes = [16, 32, 48, 128, 256];

function iconSvg({ lab, size }) {
  if (lab && size === 16) {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
      <rect x="1" y="1" width="14" height="14" rx="3" fill="#14251f"/>
      <path d="M4 3h4c2.5 0 4 1.7 4 4.5S10.5 12 8 12H4V3zm3 2v5h1c1.2 0 2-.8 2-2.5S9.2 5 8 5H7z" fill="#c9f36a"/>
      <rect x="1" y="9" width="14" height="6" rx="1" fill="#c9f36a"/>
      <path fill="#14251f" d="M2 10h1v3h2v1H2zm5 0h1v1H7zm-1 1h1v1H6zm2 0h1v1H8zm-2 1h3v1H6zm0 1h1v1H6zm2 0h1v1H8zm2-3h2v1h-2zm0 1h1v1h-1zm2 0h1v1h-1zm-2 1h2v1h-2zm0 1h1v1h-1zm2 0h1v1h-1z"/>
    </svg>`);
  }
  const badge = lab
    ? `<rect x="27" y="43" width="31" height="14" rx="3" fill="#c9f36a" stroke="#14251f" stroke-width="2"/>
       <text x="42.5" y="53.5" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" font-weight="900" fill="#14251f">LAB</text>`
    : "";
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect x="3" y="3" width="58" height="58" rx="14" fill="#14251f"/>
    <path d="M18 13h16c10 0 17 7.5 17 19s-7 19-17 19H18V13zm11 10v18h4.5c4.4 0 7.2-3.1 7.2-9s-2.8-9-7.2-9H29z" fill="#c9f36a"/>
    ${badge}
  </svg>`);
}

async function createIco(lab) {
  const images = await Promise.all(sizes.map(size => (
    sharp(iconSvg({ lab, size })).resize(size, size).png().toBuffer()
  )));
  const headerSize = 6 + (16 * images.length);
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = headerSize;
  images.forEach((image, index) => {
    const entry = 6 + (index * 16);
    const size = sizes[index];
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  return Buffer.concat([header, ...images]);
}

await mkdir(resolve(projectDir, "build"), { recursive: true });
await Promise.all([
  writeFile(resolve(projectDir, "build", "icon.ico"), await createIco(false)),
  writeFile(resolve(projectDir, "build", "icon-lab.ico"), await createIco(true)),
]);
