import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const source = join(root, 'assets', 'voxcall-icon.png');
const iconPath = join(root, 'assets', 'icon.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];

const pngBuffers = await Promise.all(
  sizes.map((size) => sharp(source)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()),
);

const ico = await pngToIco(pngBuffers);
writeFileSync(iconPath, ico);
console.log(`Icon generated: ${iconPath}`);
