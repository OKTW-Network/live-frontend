export function serializePayload(value) {
  const seen = new WeakSet();
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return `${item}n`;
      if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`;
      if (typeof item === 'symbol') return String(item);
      if (typeof item === 'undefined') return '[undefined]';
      if (typeof item === 'number' && !Number.isFinite(item)) return String(item);
      if (typeof item === 'string' && item.length > 2048) return `${item.slice(0, 2048)}… [truncated]`;
      if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
      if (item?.nodeType) return { type: 'DOMNode', nodeName: item.nodeName || item.tagName || 'unknown', id: item.id || undefined };
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }));
  } catch (error) {
    return { __unserializable__: error?.message || String(error) };
  }
}

export function createDebugLog({ now, onDebug = () => {} } = {}) {
  let debugSequence = 0;
  let debugEntries = [];

  function push(source, level, event, payload = {}) {
    const entry = {
      sequence: ++debugSequence,
      time: new Date(now()).toISOString(),
      source,
      level,
      event,
      payload: serializePayload(payload),
    };
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
