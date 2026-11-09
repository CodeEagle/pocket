import { startEditor } from '../server.ts';
import { test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

test('Editor builds the complete System catalog and opens a snapshot child through native input', { timeout: 150_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pocket-editor-system-resource-proof-'));
  const server = await startEditor({ port: 0, workspace,
    projectRoot: resolve(import.meta.dir, '../../../demo/js') });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const origin = `http://127.0.0.1:${server.port}`;
  async function api(path: string, body?: unknown) {
    const response = await fetch(origin + path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pocket-editor': '1' }, body: JSON.stringify(body),
    });
    const value = await response.json() as any;
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  }
  try {
    const health = await api('/health');
    const base = `/api/projects/${health.projectId}`;
    const catalog = await api(base + '/resources');
    const system = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../demo/js/pocket.system.json'), 'utf8'));
    const expectedPackages = system.applications.catalog.map((entry: { package: string }) => entry.package).sort();
    assert.deepEqual(catalog.packages.map((pkg: { id: string }) => pkg.id).sort(), expectedPackages);
    await api(base + '/build', {});
    const deadline = Date.now() + 120_000;
    let status: any;
    while (Date.now() < deadline) {
      status = await api(base + '/status');
      if (!status.busy) break;
      await Bun.sleep(100);
    }
    assert.equal(status.busy, false, 'build timeout');
    assert.equal(status.error, undefined, JSON.stringify(status));
    const resources = await api(base + '/resources');
    assert.deepEqual(resources.packages.map((pkg: { id: string }) => pkg.id).sort(), expectedPackages);
    for (const pkg of resources.packages) assert.ok(pkg.resources.length > 0, pkg.id);
    const stream = await fetch(origin + base + '/preview/stream');
    assert.equal(stream.status, 200, stream.status === 200 ? '' : await stream.text());
    reader = stream.body!.getReader();
    await reader.read();
    await api(base + '/preview/input', { type: 'resize', width: 390, height: 1800 });
    let snapshot = await api(base + '/preview/snapshot');
    const button = snapshot.frame.ops.find((op: any) => op.type === 'text' && op.text === 'Open profile app');
    assert.ok(button, 'real Showcase did not expose Open profile app');
    const point = { x: button.x + button.w / 2, y: button.y + button.h / 2, id: 1, type: 'pointer' };
    await api(base + '/preview/input', { ...point, phase: 'down' });
    await api(base + '/preview/input', { ...point, phase: 'up' });
    const openDeadline = Date.now() + 8_000;
    while (Date.now() < openDeadline) {
      snapshot = await api(base + '/preview/snapshot');
      if (snapshot.frame.ops.some((op: any) => op.type === 'text' && op.text === 'Pocket Profile')) break;
      await Bun.sleep(40);
    }
    assert.equal(snapshot.status.state, 'ready', JSON.stringify(snapshot.status));
    assert.ok(snapshot.frame.ops.some((op: any) => op.type === 'text' && op.text === 'Pocket Profile'), 'snapshot child did not open');
    console.log(JSON.stringify({ acceptance: 'editor-system-resources', result: 'PASS', revision: status.builtRevision, packages: resources.packages.map((pkg: any) => ({ id: pkg.id, resources: pkg.resources.length })), opened: 'Pocket Profile', frame: snapshot.frame.frame }));
  } finally {
    await reader?.cancel().catch(() => {});
    await server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }

});
