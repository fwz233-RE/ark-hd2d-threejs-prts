import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const assetsRoot = new URL('../public/assets/', import.meta.url);
const configs = [
  ['char_1041_angel2', 'char_1041_angel2-source'],
  ['char_1050_chen3', 'char_1050_chen3-source'],
  ['char_2025_shu', 'char_2025_shu-source'],
  ['char_245_cello', 'char_245_cello-source'],
];
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5183, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:5183/tools/convert.html');
  for (const [id, source] of configs) {
    const manifest = JSON.parse(await readFile(new URL(`${source}/manifest.json`, assetsRoot), 'utf8'));
    for (const model of manifest.models) {
      const atlasPath = `${source}/${model.relativeStem}.atlas`;
      const atlas = await readFile(new URL(`${atlasPath}`, assetsRoot), 'utf8');
      const pageMatch = atlas.match(/^[^\r\n]+\r?\nsize:\s*(\d+)\s*,\s*(\d+)/m);
      if (!pageMatch) throw new Error(`无法读取 atlas 尺寸: ${atlasPath}`);
      const targetWidth = Number(pageMatch[1]);
      const targetHeight = Number(pageMatch[2]);
      for (const referenced of model.atlas.referencedPngs) {
        const relative = referenced.path;
        const urlPath = `/assets/${source}/${relative}`;
        const result = await page.evaluate(async ({ urlPath, targetWidth, targetHeight }) => {
          const image = new Image();
          image.src = urlPath;
          await image.decode();
          if (image.naturalWidth === targetWidth && image.naturalHeight === targetHeight) {
            return { changed: false, width: image.naturalWidth, height: image.naturalHeight };
          }
          const canvas = document.createElement('canvas');
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const context = canvas.getContext('2d');
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = 'high';
          context.clearRect(0, 0, targetWidth, targetHeight);
          context.drawImage(image, 0, 0, targetWidth, targetHeight);
          return { changed: true, width: image.naturalWidth, height: image.naturalHeight, png: canvas.toDataURL('image/png').split(',')[1] };
        }, { urlPath, targetWidth, targetHeight });
        if (!result.changed) {
          console.log(`${id} ${model.direction}: ${relative} already ${targetWidth}x${targetHeight}`);
          continue;
        }
        await writeFile(new URL(`${source}/${relative}`, assetsRoot), Buffer.from(result.png, 'base64'));
        console.log(`${id} ${model.direction}: ${relative} ${result.width}x${result.height} -> ${targetWidth}x${targetHeight}`);
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}
