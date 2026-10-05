'use strict';

const PER_CHAT_MAX = 5;

function sameJob(a, b) {
  return a.id === b.id && (a.session || '') === (b.session || '');
}

function createChatQueue({ max = PER_CHAT_MAX } = {}) {
  const lines = new Map();

  function push(key, job) {
    const line = lines.get(key) || [];
    if (line.some(j => sameJob(j, job))) return 'present';
    if (line.length >= max) return 'full';
    line.push(job);
    lines.set(key, line);
    return 'queued';
  }

  function has(key, job) {
    return (lines.get(key) || []).some(j => sameJob(j, job));
  }

  function find(key, id) {
    return (lines.get(key) || []).find(j => j.id === id) || null;
  }

  function remove(key, job) {
    const line = lines.get(key);
    const at = line ? line.indexOf(job) : -1;
    if (at < 0) return false;
    line.splice(at, 1);
    if (!line.length) lines.delete(key);
    return true;
  }

  function dropWhere(pred) {
    const dropped = [];
    for (const [key, line] of [...lines]) {
      const kept = line.filter(j => !pred(j));
      dropped.push(...line.filter(pred));
      if (kept.length) lines.set(key, kept);
      else lines.delete(key);
    }
    return dropped;
  }

  return {
    push,
    has,
    find,
    remove,
    dropWhere,
    heads: () => [...lines].map(([key, line]) => [key, line[0]]),
    jobs: () => [...lines.values()].flat(),
    keys: () => [...lines.keys()],
    clear: () => lines.clear(),
  };
}

module.exports = { PER_CHAT_MAX, sameJob, createChatQueue };
