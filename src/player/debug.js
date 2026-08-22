export function serializePayload(value) {
  const seen = new WeakSet();

  function visit(input, depth = 0) {
    if (input === null || ['string', 'number', 'boolean'].includes(typeof input)) {
      if (typeof input === 'string' && input.length > 2048) return `${input.slice(0, 2048)}… [truncated]`;
      if (typeof input === 'number' && !Number.isFinite(input)) return String(input);
      return input;
    }
    if (typeof input === 'undefined') return '[undefined]';
    if (typeof input === 'bigint') return `${input}n`;
    if (typeof input === 'function') return `[Function ${input.name || 'anonymous'}]`;
    if (typeof input === 'symbol') return String(input);
    if (depth >= 4) return '[MaxDepth]';
    if (input?.nodeType) {
      return { type: 'DOMNode', nodeName: input.nodeName || input.tagName || 'unknown', id: input.id || undefined };
    }
    if (input instanceof Error) return { name: input.name, message: input.message, stack: input.stack };
    if (seen.has(input)) return '[Circular]';
    seen.add(input);

    if (Array.isArray(input)) {
      const values = input.slice(0, 50).map((item) => visit(item, depth + 1));
      if (input.length > 50) values.push(`[${input.length - 50} items truncated]`);
      return values;
    }

    const result = {};
    const keys = Object.keys(input);
    Object.entries(input).slice(0, 50).forEach(([key, item]) => { result[key] = visit(item, depth + 1); });
    if (keys.length > 50) result.__truncated__ = `${keys.length - 50} keys`;
    return result;
  }

  let safe;
  try {
    safe = visit(value);
  } catch (error) {
    safe = { __unserializable__: error?.message || String(error) };
  }
  try {
    const json = JSON.stringify(safe);
    if (json.length > 16384) return { preview: `${json.slice(0, 16384)}…`, __truncated__: '16KB' };
  } catch {
    return '[Unserializable]';
  }
  return safe;
}

export function createDebugLog({ now, onDebug = () => {} } = {}) {
  let debugSequence = 0;
  let debugEntries = [];

  function push(source, level, event, payload = {}) {
    const entry = Object.freeze({
      sequence: ++debugSequence,
      time: new Date(now()).toISOString(),
      source,
      level,
      event,
      payload: serializePayload(payload),
    });
    debugEntries.push(entry);
    if (debugEntries.length > 500) debugEntries = debugEntries.slice(-500);
    try { onDebug({ count: debugEntries.length, entry }); } catch { /* Debug observers are isolated. */ }
    return entry;
  }

  function getEntries({ source = '', level = '', text = '' } = {}) {
    const needle = String(text).trim().toLocaleLowerCase('zh-TW');
    return debugEntries.filter((entry) => {
      if (source && entry.source !== source) return false;
      if (level && entry.level !== level) return false;
      if (!needle) return true;
      return JSON.stringify(entry).toLocaleLowerCase('zh-TW').includes(needle);
    });
  }

  function clear() {
    debugEntries = [];
    try { onDebug({ count: 0, entry: null }); } catch { /* Debug observers are isolated. */ }
  }

  function exportJson({ snapshot = null } = {}) {
    return JSON.stringify({
      version: 1,
      exportedAt: new Date(now()).toISOString(),
      snapshot,
      entries: debugEntries,
    }, null, 2);
  }

  return {
    push,
    getEntries,
    clear,
    exportJson,
    get entries() { return debugEntries; },
    get count() { return debugEntries.length; },
  };
}
