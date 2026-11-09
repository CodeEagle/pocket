/* Diagnostics read the actual owning runtime in either execution mode. */
function observeRenderHost(host, mode) {
  let frameCount = 0, frameDurationMs = 0;
  const advance = host.advance.bind(host);
  host.advance = (...args) => {
    const start = performance.now();
    try { const value = advance(...args); frameCount++; return value; }
    finally { frameDurationMs += performance.now() - start; }
  };
  return {
    inspect() {
      if (!host.exports || !host.host || host.disposed) throw new Error("PocketJS runtime is not mounted");
      const ex = host.exports, nodes = [], queue = [0, 1], seen = new Set();
      while (queue.length && seen.size < 16384) {
        const id = queue.shift();
        if (seen.has(id)) continue;
        seen.add(id);
        if (ex.web_inspect(host.host, id) !== 0) throw new Error("PocketJS node inspection failed");
        const bytes = new Uint8Array(ex.memory.buffer, ex.web_result_ptr(host.host), ex.web_result_len(host.host));
        const node = JSON.parse(new TextDecoder().decode(bytes));
        if (!node) continue;
        nodes.push({ ...node, id });
        if (Array.isArray(node.children)) queue.push(...node.children);
      }
      return { nodes };
    },
    stats() {
      return { mode, thread: mode === "worker" ? "worker" : "main", frameCount, frameDurationMs,
        width: host.logicalWidth, height: host.logicalHeight, pixelWidth: host.canvas.width,
        pixelHeight: host.canvas.height, visible: host.visible, disposed: host.disposed };
    },
  };
}
module.exports = { observeRenderHost };
