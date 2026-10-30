// Developer-only adapter for the source formats accepted by the standard skills CLI.
// The server never calls this module: it consumes committed, content-locked files.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { canonicalJson, sha256Hex } from './util.js';

const execute = promisify(execFile);
export const SKILLS_CLI_VERSION = '1.7.4';

export function vendorContentHash(files, prefix) {
  const entries = Object.entries(files).filter(([name]) => name.startsWith(prefix)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return sha256Hex(new TextEncoder().encode(canonicalJson(entries.map(([name, bytes]) => [name.slice(prefix.length), sha256Hex(bytes)]))));
}

export async function importSkillSource(source, { sourceBaseDir = process.cwd() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'librebot-skills-'));
  try {
    let locator = source.repo.source;
    if (locator.startsWith('.') || isAbsolute(locator)) locator = resolve(sourceBaseDir, locator);
    const args = ['--yes', `--package=skills@${SKILLS_CLI_VERSION}`, '--', 'skills', 'add', locator, '--copy', '--yes', '--agent', 'codex', ...(source.skills.length ? ['--skill', ...source.skills] : [])];
    await execute(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
      cwd: directory, timeout: 180_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', CI: '1' },
    });
    const files = {};
    let size = 0;
    const prefix = `skills/.vendor/${source.name}/`;
    const walk = async (root, rel = '') => {
      for (const name of (await readdir(root)).sort()) {
        const path = join(root, name);
        const relative = rel ? `${rel}/${name}` : name;
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) throw new Error(`Installed skill contains a symbolic link: ${relative}`);
        if (stat.isDirectory()) await walk(path, relative);
        else if (stat.isFile()) {
          if (stat.size > 1024 * 1024) throw new Error(`Skill file exceeds 1 MiB: ${relative}`);
          if (Object.keys(files).length >= 5000 || size + stat.size > 20 * 1024 * 1024) throw new Error('Installed skills exceed file or byte limits');
          files[prefix + relative] = new Uint8Array(await readFile(path));
          size += stat.size;
        } else throw new Error(`Installed skill is not a regular file: ${relative}`);
      }
    };
    await walk(join(directory, '.agents', 'skills'));
    if (!Object.keys(files).some(path => path.endsWith('/SKILL.md'))) throw new Error('The skills CLI installed no SKILL.md files');
    return { files, contentSha256: vendorContentHash(files, prefix) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
