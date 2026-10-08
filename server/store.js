const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const dbFile = path.join(dataDir, 'applications.json');
const baseResumeFile = path.join(dataDir, 'base-resume.json');
const promptSettingsFile = path.join(dataDir, 'prompt-settings.json');
function read() {
  fs.mkdirSync(dataDir, { recursive: true });
  try { return JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch { return []; }
}
function write(rows) { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(dbFile, JSON.stringify(rows, null, 2)); }
function readBaseResume() {
  fs.mkdirSync(dataDir, { recursive: true });
  try { return JSON.parse(fs.readFileSync(baseResumeFile, 'utf8')); } catch { return null; }
}
function writeBaseResume(baseResume) {
  fs.mkdirSync(dataDir, { recursive: true });
  if (baseResume) fs.writeFileSync(baseResumeFile, JSON.stringify(baseResume, null, 2));
  else if (fs.existsSync(baseResumeFile)) fs.unlinkSync(baseResumeFile);
}
function readPromptSettings() {
  fs.mkdirSync(dataDir, { recursive: true });
  try { return JSON.parse(fs.readFileSync(promptSettingsFile, 'utf8')); } catch { return null; }
}
function writePromptSettings(settings) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(promptSettingsFile, JSON.stringify(settings, null, 2));
}
module.exports = {
  all: () => read().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  get: id => read().find(row => row.id === id),
  add: row => { const rows = read(); rows.push(row); write(rows); return row; },
  update: (id, changes) => { const rows = read(); const i = rows.findIndex(row => row.id === id); if (i < 0) return null; rows[i] = { ...rows[i], ...changes, updatedAt: new Date().toISOString() }; write(rows); return rows[i]; },
  remove: id => { const rows = read(); const next = rows.filter(row => row.id !== id); if (rows.length === next.length) return false; write(next); return true; },
  getBaseResume: readBaseResume,
  saveBaseResume: writeBaseResume,
  getPromptSettings: readPromptSettings,
  savePromptSettings: writePromptSettings
};
