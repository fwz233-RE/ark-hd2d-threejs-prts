import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const baseURL = process.env.APP_URL || 'http://127.0.0.1:5173';
const rootURL = new URL('../public/assets/', import.meta.url);
const configs = [
  { id: 'char_1041_angel2', name: '新约能天使', source: 'char_1041_angel2-source', heights: { front: 237.142, build: 256.865 }, ground: { front: .54, build: .696 } },
  { id: 'char_1050_chen3', name: '赤刃明霄陈', source: 'char_1050_chen3-source', heights: { front: 263.198, build: 264.458 }, ground: { front: .24, build: .24 } },
  { id: 'char_2025_shu', name: '黍', source: 'char_2025_shu-source', heights: { front: 259.055, build: 260.822 }, ground: { front: 6.025, build: 6.52 } },
  { id: 'char_245_cello', name: '塑心', source: 'char_245_cello-source', heights: { front: 269.094, build: 269.769 }, ground: { front: -1.481, build: -1.478 } },
];
const safe = value => value.replace(/[^\w.-]+/g, '_');
const sourceManifest = async config => JSON.parse(await readFile(new URL(`${config.source}/manifest.json`, rootURL), 'utf8'));
const modelConfig = (config, model) => {
  const fileStem = model.relativeStem.split('/').pop();
  const direction = model.direction;
  return {
    sourceRoot: `/assets/${config.source}/${model.relativeStem.slice(0, -fileStem.length)}`,
    skeleton: `${fileStem}.skel`, atlas: `${fileStem}.atlas`, character: config.name,
    bodyHeight: config.heights[direction], groundY: config.ground[direction], cellSize: 320, fps: 30,
  };
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  page.on('pageerror', error => console.error(error.message));
  await page.goto(`${baseURL}/tools/convert.html`);
  await page.waitForFunction(() => typeof window.convertAnimation === 'function');

  for (const config of configs) {
    const source = await sourceManifest(config);
    const byDirection = Object.fromEntries(['front', 'build'].map(direction => [direction, source.models.find(model => model.skin === '默认' && model.direction === direction)]));
    const inspected = {};
    const sourceCatalog = [];
    for (const model of source.models) {
      const info = await page.evaluate(model => window.inspectModel(model), modelConfig(config, model));
      sourceCatalog.push({
        skin: model.relativeStem.startsWith('defaultskin/') ? '默认' : model.skin,
        direction: model.direction, relativeStem: model.relativeStem,
        animations: info.animations.map(item => item.name),
      });
      if (model.relativeStem.startsWith('defaultskin/') && ['front', 'build'].includes(model.direction)) {
        inspected[model.direction] = info;
        console.log(`${config.id} ${model.direction} actions: ${info.animations.map(item => item.name).join(', ')}`);
      }
      await page.evaluate(() => window.disposeModels());
    }
    const outputDir = new URL(`characters/${config.id}/`, rootURL);
    await mkdir(outputDir, { recursive: true });
    const animations = {};
    for (const direction of ['front', 'build']) {
      const model = byDirection[direction];
      const modelCfg = modelConfig(config, model);
      for (const item of inspected[direction].animations) {
        const result = await page.evaluate(({ modelCfg, animation }) => window.convertAnimation(modelCfg, animation), { modelCfg, animation: item.name });
        const key = `${direction}/${item.name}`;
        const pages = [];
        for (const pageData of result.pages) {
          const image = `${direction}-${safe(item.name)}-${pageData.startFrame}.png`;
          await writeFile(new URL(image, outputDir), Buffer.from(pageData.png, 'base64'));
          pages.push({ image, startFrame: pageData.startFrame, frames: pageData.frames, columns: pageData.columns, rows: pageData.rows });
        }
        animations[key] = { ...result.metadata, model: direction, pages };
        console.log(`${config.id} ${key}: ${result.metadata.frames} frames / ${pages.length} pages`);
      }
      await page.evaluate(() => window.disposeModels());
    }
    const models = {};
    for (const direction of ['front', 'build']) {
      models[direction] = {
        bodyHeight: config.heights[direction], groundY: config.ground[direction],
        availableAnimations: inspected[direction].animations.map(item => item.name),
      };
    }
    await writeFile(new URL('manifest.json', outputDir), JSON.stringify({
      id: config.id, name: config.name, targetHeight: 1.65, animations, models, sourceCatalog,
    }, null, 2));
    console.log(`${config.id}: wrote ${Object.keys(animations).length} animations and ${sourceCatalog.length} source groups`);
  }
} finally {
  await browser.close();
}
