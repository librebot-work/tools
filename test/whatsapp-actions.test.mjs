import { it } from 'node:test';
import assert from 'node:assert/strict';
import { validateFiles } from '../src/index.js';
const files = (kind, capabilities) => ({
  'bot.yaml': `formatVersion: 1\nname: Messenger\ndescription: Replies with permission\nmodelRoles:\n  - {role: default, label: Main}\nactions:\n  - {key: messaging, kind: ${kind}, capabilities: [${capabilities.join(', ')}]}\n`,
  'instructions.md': 'Use only owner-bound messaging authority.',
});
it('parses portable WhatsApp reads, text and reaction declarations', async () => {
  const result = await validateFiles(files('whatsapp', ['read_messages', 'send_text', 'set_reaction', 'remove_reaction']));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.draft.actions, [{ key: 'messaging', kind: 'whatsapp', capabilities: ['read_messages', 'send_text', 'set_reaction', 'remove_reaction'] }]);
});
it('rejects crossing repository and WhatsApp capabilities', async () => {
  assert.equal((await validateFiles(files('gitrepo', ['send_text']))).ok, false);
  assert.equal((await validateFiles(files('whatsapp', ['push_branch']))).ok, false);
  assert.equal((await validateFiles(files('whatsapp', ['send_text', 'send_text']))).ok, false);
});
const triggered = (kind, events) => {
  const source = files('whatsapp', ['read_messages']);
  source['bot.yaml'] += `triggers:\n  - key: incoming\n    label: Incoming messaging\n    kind: ${kind}\n    eventTypes: [${events.join(', ')}]\n    deciderInstructions: Decide whether to assist.\n`;
  return source;
};
it('validates complete portable WhatsApp triggers and rejects event crossovers', async () => {
  const result = await validateFiles(triggered('whatsapp', ['message.created', 'reaction.changed']));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.draft.triggers[0].kind, 'whatsapp');
  assert.deepEqual(result.draft.triggers[0].eventTypes, ['message.created', 'reaction.changed']);
  assert.equal((await validateFiles(triggered('gitrepo', ['message.created']))).ok, false);
  assert.equal((await validateFiles(triggered('whatsapp', ['issue.opened']))).ok, false);
});
