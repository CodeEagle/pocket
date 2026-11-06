// Browser execution probe. The GATT object below is explicitly test-only IO.
import { test, expect } from 'bun:test';
import { chromium } from 'playwright';

test('browser import runs Web Crypto and input-driven TFTC writes without Electron globals', async () => {
  const build = await Bun.build({ entrypoints: [new URL('../src/index.js', import.meta.url).pathname], target: 'browser' });
  expect(build.success).toBe(true);
  const bundle = await build.outputs[0].text();
  const server = Bun.serve({ port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/tftc.js') return new Response(bundle, { headers: { 'content-type': 'application/javascript' } });
    return new Response(`<!doctype html><button>Vibrate</button><output>ready</output><script type="module">
      import { TftcClient, getDeviceProfile, deriveV1Material, buildProtocolFrame } from '/tftc.js';
      const client = new TftcClient();
      client.profile = getDeviceProfile('DK-META2');
      client.device = { gatt: { connected: true } };
      client.businessReady = true;
      window.writes = [];
      client.writeChar = { async writeValueWithResponse(frame) { window.writes.push([...frame]); } };
      client.on('state', e => document.querySelector('output').textContent = 'battery=' + e.detail.battery);
      document.querySelector('button').onclick = async () => {
        await client.setVibration(35);
        client.handleStandardNotify(buildProtocolFrame(1, [0x20, 0xa8], { includeChecksum: true }));
      };
      const material = await deriveV1Material({productSecret:'10101010101010101010101010101010',mac:[32,33,34,35,36,37],appNonce:Array(8).fill(48),deviceNonce:Array(8).fill(64)});
      window.auth = [...material.authPayload];
    </script>`, { headers: { 'content-type': 'text/html' } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.waitForFunction(() => Array.isArray(window.auth));
    expect(await page.evaluate(() => window.auth)).toEqual([2,1,0,242,252,48,154,53,194]);
    await page.getByRole('button', { name: 'Vibrate' }).click();
    await page.waitForFunction(() => document.querySelector('output')?.textContent === 'battery=42');
    expect(await page.evaluate(() => window.writes)).toEqual([[1,2,0,3,8,35,213]]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 30000);
