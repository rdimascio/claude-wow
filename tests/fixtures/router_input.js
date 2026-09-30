'use strict';

const projects = [
  { name: 'ellie', path: '/u/ellie', remote: '', lastCommit: '2026-09-20T10:00:00.000Z', readme: 'Ellie, a desktop assistant', aliases: [] },
  { name: 'wow-ai', path: '/u/wow-ai', remote: 'https://github.com/rdimascio/wow-ai.git', lastCommit: '2026-09-29T10:00:00.000Z', readme: 'claude-wow: Claude in World of Warcraft', aliases: ['wow ai', 'wowai'] },
];

const input = {
  text: 'fix the failing test in wow-ai',
  context: 'Character: Thrall, level 12 Orc Shaman\nZone: Durotar',
  previous: { route: 'chat', folder: '' },
};

module.exports = { projects, input };
