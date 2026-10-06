'use strict';

const RESTORE_PUBLISHES = 3;
const LATE_KEPT_PER_CHAT = 4;

function lateBase(chatKey) {
  return `${chatKey}#late`;
}

function lateKey(chatKey, seq) {
  return `${lateBase(chatKey)}#${seq}`;
}

function nextLateSeq(last, now) {
  return Math.max(Number.isSafeInteger(last) ? last + 1 : 1, Math.floor(now));
}

function trimLate(live, chatKey, keep = LATE_KEPT_PER_CHAT, kept = null) {
  const base = lateBase(chatKey);
  const family = [...live.keys()].filter(k => k === base || k.startsWith(base + '#'));
  const dropped = family.slice(0, Math.max(0, family.length - keep));
  for (const k of dropped) {
    live.delete(k);
    if (kept) delete kept[k];
  }
  return dropped;
}

function place(live, key, record) {
  live.delete(key);
  live.set(key, record);
}

function windowRecords(live, tokenOf) {
  return [...live.entries()].map(([key, record]) => ({ ...record, token: tokenOf(key) }));
}

function restoreAfterPublish(pending, { refresh, restoreSent }) {
  if (!pending || refresh || !restoreSent) return pending;
  pending.published = (pending.published || 0) + 1;
  return pending.published >= RESTORE_PUBLISHES ? null : pending;
}

function republishQueued(publishNow) {
  publishNow(true, { refresh: true });
}

module.exports = { place, windowRecords, restoreAfterPublish, republishQueued, lateKey, nextLateSeq, trimLate, RESTORE_PUBLISHES, LATE_KEPT_PER_CHAT };
