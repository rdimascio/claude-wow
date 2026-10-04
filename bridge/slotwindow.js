'use strict';

const RESTORE_PUBLISHES = 3;

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

module.exports = { place, windowRecords, restoreAfterPublish, republishQueued, RESTORE_PUBLISHES };
