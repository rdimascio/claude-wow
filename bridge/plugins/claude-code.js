'use strict';
// The coding plugin: what the bridge did before there were plugins. A chat is
// an agent session in a folder, resolved against the bridge's folder (/claude-wow
// cd, --project, defaultCwd); the folder must exist, and a session belongs to
// the folder that made it, so a chat that changes folder starts a new one.
// Everything else (which agent, the game context, map and macros, transcripts)
// is the core's, shared with every other plugin.

const fs = require('fs');
const P = require('../protocol');
const FACTORY = require('../factory');

// Subfolders of the bridge's folder, for the "folder not found" hint.
function siblingFolders(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => d.name)
      .sort()
      .slice(0, 30);
  } catch {
    return [];
  }
}

function isThread(options, cwd, defaultCwd) {
  const threads = options && Array.isArray(options.threads) ? options.threads : [];
  return threads.some(d => typeof d === 'string' && d.trim() !== '' && P.sameFolder(P.resolveCwd(d.trim(), defaultCwd), cwd));
}

const plugin = {
  id: 'claude-code',
  label: 'Code',
  aliases: ['claude', 'code'],
  tools: '',
  surfaces: ['map', 'macro', 'ui'],
  searchesFiles: true,
  banner: options => {
    const conf = FACTORY.settings(options);
    return conf.enabled
      ? `factory dispatcher: ${conf.skills.length} skill(s), runs on ${conf.model} unless plugins.claude-code.factory.models says otherwise`
      : 'full coding sessions (plugins.claude-code.factory.enabled is off)';
  },
  handle(job, core) {
    const cwd = P.resolveCwd(job.cwd, core.defaultCwd);
    job.cwd = cwd;
    if (!fs.existsSync(cwd)) {
      core.log(`${core.tag(job)} cwd does not exist: ${cwd}`);
      const sibs = siblingFolders(core.defaultCwd);
      core.fail(
        job,
        `Folder does not exist: ${cwd}\n` +
          `Paths are relative to ${core.defaultCwd}.` +
          (sibs.length ? `\nFolders there: ${sibs.join(', ')}` : '') +
          `\nUse /claude cd <folder> to pick one, or /claude cd alone for the default.`,
      );
      return;
    }
    const options = core.options('claude-code');
    const conf = FACTORY.settings(options);
    const thread = isThread(options, cwd, core.defaultCwd);
    const rules = conf.enabled ? FACTORY.dispatcherRules(conf) : '';
    const dispatcher = conf.enabled ? { tools: thread ? '' : rules, factory: conf, deniedTools: [...FACTORY.DISPATCHER_DENIED] } : {};
    core.runAgent(job, {
      ...dispatcher,
      ...(thread ? { thread: true, turnRules: rules } : {}),
      cwd,
      // Agents keep sessions per project folder, so a chat that changed folder starts fresh.
      freshSession: () => {
        const prev = core.sessionFolder(job);
        return prev && !P.sameFolder(prev, cwd) ? `folder changed (${prev} -> ${cwd})` : '';
      },
    });
  },
};

plugin.isThread = isThread;

module.exports = plugin;
