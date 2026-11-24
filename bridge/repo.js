'use strict';
// The project's GitHub repository as owner/name. install.sh (REPO=),
// install.ps1 ($Repo), package.json (repository.url) and the Homebrew formula
// carry the same value; tests/repo_test.js fails on any other repository name
// in the shipped files.

const REPO = 'rdimascio/wowgpt';
const REPO_URL = `https://github.com/${REPO}`;
const API_URL = `https://api.github.com/repos/${REPO}`;

module.exports = { REPO, REPO_URL, API_URL };
