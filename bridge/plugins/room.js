'use strict';

const READ_ONLY_TEXT =
  'This chat follows an agent-room channel and shows what happens there. Talking back from the game comes in the next step; until then, answer in the room or in Slack.';

const plugin = {
  id: 'room',
  label: 'agent-room',
  tools: '',
  surfaces: [],
  achievements: false,
  match: () => false,
  banner: options =>
    options && options.enabled === true
      ? `follows agent-room channels of ${options.workspace || '(no workspace set)'} into game chats (plugins.room)`
      : 'off (plugins.room.enabled in config.json)',
  handle(job, core) {
    core.log(`${core.tag(job)} room: chat is read-only`);
    core.reply(job, READ_ONLY_TEXT);
  },
};

module.exports = plugin;
module.exports.READ_ONLY_TEXT = READ_ONLY_TEXT;
