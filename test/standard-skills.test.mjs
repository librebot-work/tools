import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSourcesYaml, sourcesHash, resolveSkillsLock, serializeLock, scaffoldBotFiles, writeFiles, parseBotSource } from '../src/index.js';
import { vendorContentHash } from '../src/skills-import.js';

describe('standard skills source locking', () => {
  it('requires explicit installation consent for non-GitHub locators', async () => {
    const sink = { errors: [], warnings: [] };
    const sources = parseSourcesYaml({ version: 1, sources: ['https://gitlab.com/team/skills', './local-skills', 'owner/repo@review'] }, sink);
    assert.deepEqual(sink.errors, []);
    const result = await resolveSkillsLock({ sources });
    assert.equal(result.errors.length, 3);
    assert.ok(result.errors.every(error => error.message.includes('--network --vendor')));
  });

  it('loads content-locked vendor files from disk offline and rejects edited content', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'standard-skills-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const doc = { version: 1, sources: [{ name: 'local', source: './local-skills' }] };
    const sources = parseSourcesYaml(doc, { errors: [], warnings: [] });
    const prefix = 'skills/.vendor/local/';
    const vendorFiles = {
      [prefix + 'review/SKILL.md']: new TextEncoder().encode('---\nname: review\ndescription: Review changes.\n---\nRead references/guide.md.\n'),
      [prefix + 'review/references/guide.md']: new TextEncoder().encode('Check behavior, not implementation details.\n'),
    };
    const lock = { version: 1, sourcesHash: sourcesHash(sources.sources), resolved: [{ name: 'local', repo: 'skills-cli/./local-skills', contentSha256: vendorContentHash(vendorFiles, prefix), skills: [] }] };
    const files = { ...scaffoldBotFiles({ name: 'Locked skills', description: 'Offline content lock' }), ...vendorFiles, 'skills/sources.yaml': JSON.stringify(doc), 'skills/sources.lock': serializeLock(lock) };
    await writeFiles(directory, files);
    const parsed = await parseBotSource(directory);
    assert.ok(parsed.draft.skills.some(skill => skill.name === 'review'));
    assert.ok(parsed.skillFiles.some(file => file.path === 'references/guide.md'));
    const retained = await resolveSkillsLock({ sources, existingLock: lock, currentFiles: vendorFiles, vendor: true });
    assert.deepEqual(retained.errors, []);
    assert.equal(serializeLock(retained.lock), serializeLock(lock));
    await appendFile(join(directory, prefix, 'review/references/guide.md'), 'Unreviewed changes.');
    await assert.rejects(parseBotSource(directory), /locked digest/);
  });
});
