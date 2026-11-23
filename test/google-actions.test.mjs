import { it } from 'node:test';
import assert from 'node:assert/strict';
import { validateFiles } from '../src/index.js';
import { GOOGLE_DOCS_CAPABILITIES, GOOGLE_SHEETS_CAPABILITIES, GOOGLE_CALENDAR_CAPABILITIES } from '../src/index.js';
const files = (kind, capabilities) => ({
  'bot.yaml': `formatVersion: 1\ndescription: Uses owner-bound Google authority\nmodelRoles:\n  - {role: default, label: Main}\nactions:\n  - {key: work, kind: ${kind}, capabilities: [${capabilities.join(', ')}]}\n`,
  'instructions.md': 'Use only owner-bound Google authority.',
  'README.md': '# Researcher',
});
it('parses portable Google Docs, Sheets, and Calendar declarations', async () => {
  assert.deepEqual([...GOOGLE_DOCS_CAPABILITIES], ['search_documents', 'read_document', 'create_document', 'edit_document_content', 'format_document']);
  assert.deepEqual([...GOOGLE_SHEETS_CAPABILITIES], ['search_spreadsheets', 'read_spreadsheet', 'create_spreadsheet', 'write_values', 'append_values', 'write_formulas', 'format_cells']);
  assert.deepEqual([...GOOGLE_CALENDAR_CAPABILITIES], ['search_events', 'read_event', 'create_event', 'edit_event', 'cancel_event', 'manage_attendees']);
  for (const [kind, capabilities] of [['google_docs', GOOGLE_DOCS_CAPABILITIES], ['google_sheets', GOOGLE_SHEETS_CAPABILITIES], ['google_calendar', GOOGLE_CALENDAR_CAPABILITIES]]) {
    const result = await validateFiles(files(kind, [...capabilities]));
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(result.draft.actions, [{ key: 'work', kind, capabilities: [...capabilities] }]);
  }
});
it('rejects crossing Google and repository/WhatsApp capabilities', async () => {
  assert.equal((await validateFiles(files('google_docs', ['send_text']))).ok, false);
  assert.equal((await validateFiles(files('google_sheets', ['read_issue']))).ok, false);
  assert.equal((await validateFiles(files('google_calendar', ['read_document']))).ok, false);
  assert.equal((await validateFiles(files('google_docs', ['read_document', 'read_document']))).ok, false);
  assert.equal((await validateFiles(files('google_docs', ['edit_document']))).ok, false);
  assert.equal((await validateFiles(files('google_docs', ['edit_document_content', 'format_document']))).ok, true);
});
