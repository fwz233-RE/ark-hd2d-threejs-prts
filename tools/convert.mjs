import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const baseURL = process.env.APP_URL || 'http://127.0.0.1:5173';
const outputDir = new URL('../public/assets/exusiai/', import.meta.url);
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error(error.message));
  await page.goto(`${baseURL}/tools/convert.html`);
  await page.waitForFunction(() => typeof window.convertAnimation === 'function');
  const manifest = { character: 'char_1041_angel2', sourceVersion: '3.8.99', animations: {} };
  for (const name of ['Idle', 'Attack_Loop', 'Skill_1_Loop']) {
    const { png, metadata } = await page.evaluate(name => window.convertAnimation(name), name);
    await writeFile(new URL(`${name}.png`, outputDir), Buffer.from(png, 'base64'));
    manifest.animations[name] = { ...metadata, image: `${name}.png` };
    console.log(`${name}: ${metadata.frames} frames, ${metadata.columns * metadata.cellSize}x${metadata.rows * metadata.cellSize}, PNG ${Math.round(png.length * 0.75 / 1024)} KB`);
  }
  await writeFile(new URL('manifest.json', outputDir), JSON.stringify(manifest, null, 2));
} finally {
  await browser.close();
}
