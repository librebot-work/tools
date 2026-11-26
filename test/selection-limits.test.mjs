import assert from "node:assert/strict";
import { it } from "node:test";
import { exportBotFiles, parseBotFiles, scaffoldBotFiles, validateFiles } from "../src/index.js";
import { SELECTION_LIMIT_CAPS } from "../src/contract.js";

const source = (sections) => ({
  ...scaffoldBotFiles({ name: "Selection limits" }),
  "bot.yaml": `formatVersion: 1\ndescription: Limits\nmodelRoles: [{role: default, label: Main}]\n${sections}`,
});
const action = (kind, capabilities, limits) => ({ key: "test", kind, capabilities, ...limits });
const trigger = (limits) => ({
  key: "inbound", label: "Inbound", kind: "whatsapp", eventTypes: ["message.created"],
  deciderInstructions: "Decide.", deciderActions: [], ...limits,
});
const definitions = (actions, triggers = []) => source(`actions: ${JSON.stringify(actions)}\ntriggers: ${JSON.stringify(triggers)}\n`);

it("parses the connector limits example and round-trips its selections", async () => {
  const { draft } = await parseBotFiles(source(`actions:
  - key: intake
    kind: google_drive
    capabilities: [list_files, download_file, upload_file]
    folderAccess: { allow: [selected_folders], maxFolders: 1 }
  - key: budget
    kind: google_sheets
    capabilities: [read_spreadsheet, write_values]
    fileAccess: { allow: [selected_files], maxFiles: 1 }
  - key: reply
    kind: whatsapp
    capabilities: [read_messages, send_text]
    context: { allow: [originating_chat] }
    outbound: { allow: [originating_chat, triggering_sender], chatKinds: [private] }
triggers:
  - key: inbound
    kind: whatsapp
    label: Inbound
    eventTypes: [message.created]
    deciderInstructions: Decide.
    deciderActions: []
    audience: { allow: [specific], chatTypes: [group], maxChats: 1 }
    context: { allow: [originating_chat] }
`));
  assert.deepEqual(draft.actions[0].folderAccess, { allow: ["selected_folders"], maxFolders: 1 });
  assert.deepEqual(draft.actions[1].fileAccess, { allow: ["selected_files"], maxFiles: 1 });
  assert.deepEqual(draft.actions[2].context, { allow: ["originating_chat"] });
  assert.deepEqual(draft.actions[2].outbound, { allow: ["originating_chat", "triggering_sender"], chatKinds: ["private"] });
  assert.deepEqual(draft.triggers[0].audience, { allow: ["specific"], chatTypes: ["group"], maxChats: 1 });
  assert.deepEqual(draft.triggers[0].context, { allow: ["originating_chat"] });
  const roundtrip = await parseBotFiles(exportBotFiles(draft));
  assert.deepEqual(roundtrip.draft.actions, draft.actions);
  assert.deepEqual(roundtrip.draft.triggers, draft.triggers);
});

it("round-trips full and partial WhatsApp outbound recommendations", async () => {
  const { draft } = await parseBotFiles(source(`actions:
  - key: reply
    kind: whatsapp
    capabilities: [send_text, set_reaction]
    outboundDefaults: { maxActionsPerRun: 10, rateLimit: { maxActions: 20, windowSeconds: 60 }, reactionTargets: associated_messages }
  - key: notify
    kind: whatsapp
    capabilities: [send_text]
    outboundDefaults: { maxActionsPerRun: 100 }
`));
  assert.deepEqual(draft.actions.map(group => group.outboundDefaults), [
    { maxActionsPerRun: 10, rateLimit: { maxActions: 20, windowSeconds: 60 }, reactionTargets: "associated_messages" },
    { maxActionsPerRun: 100 },
  ]);
  assert.deepEqual((await parseBotFiles(exportBotFiles(draft))).draft.actions, draft.actions);
});

it("rejects invalid outbound recommendations in bot YAML", async () => {
  for (const [outboundDefaults, suffix] of [
    [null, ""], [[], ""], [{ chatIds: ["chat"] }, ""],
    [{ maxActionsPerRun: 0 }, ".maxActionsPerRun"], [{ maxActionsPerRun: 101 }, ".maxActionsPerRun"],
    [{ maxActionsPerRun: 1.5 }, ".maxActionsPerRun"], [{ reactionTargets: "any_message" }, ".reactionTargets"],
    [{ rateLimit: { maxActions: 10 } }, ".rateLimit.windowSeconds"],
    [{ rateLimit: { maxActions: 1001, windowSeconds: 60 } }, ".rateLimit.maxActions"],
    [{ rateLimit: { maxActions: 1, windowSeconds: 86401 } }, ".rateLimit.windowSeconds"],
  ]) {
    await rejects(definitions([action("whatsapp", ["send_text"], { outboundDefaults })]), `actions[0].outboundDefaults${suffix}`);
  }
  const outboundDefaults = { maxActionsPerRun: 10 };
  await rejects(definitions([action("whatsapp", ["read_messages"], { outboundDefaults })]), "actions[0].outboundDefaults");
  await rejects(definitions([action("gitrepo", ["read_issue"], { outboundDefaults })]), "actions[0].outboundDefaults");
});

async function rejects(files, field) {
  const result = await validateFiles(files);
  assert.equal(result.ok, false, field);
  assert.ok(result.errors.some(issue => issue.field === field), JSON.stringify(result.errors));
}

it("accepts -1 and each count cap, rejecting other negatives, zero, fractions, and cap + 1", async () => {
  for (const [key, max, build, path] of [
    ["folderAccess", "maxFolders", limits => definitions([action("google_drive", ["list_files"], limits)]), "actions[0]"],
    ["fileAccess", "maxFiles", limits => definitions([action("google_docs", ["read_document"], limits)]), "actions[0]"],
    ["calendars", "maxCalendars", limits => definitions([action("google_calendar", ["read_event"], limits)]), "actions[0]"],
    ["context", "maxChats", limits => definitions([action("whatsapp", ["read_messages"], limits)]), "actions[0]"],
    ["outbound", "maxChats", limits => definitions([action("whatsapp", ["send_text"], limits)]), "actions[0]"],
    ["context", "maxChats", limits => definitions([], [trigger(limits)]), "triggers[0]"],
    ["audience", "maxChats", limits => definitions([], [trigger(limits)]), "triggers[0]"],
  ]) {
    const cap = SELECTION_LIMIT_CAPS[max];
    for (const count of [-1, 1, cap]) await parseBotFiles(build({ [key]: { [max]: count } }));
    for (const count of [-2, 0, 1.5, cap + 1]) await rejects(build({ [key]: { [max]: count } }), `${path}.${key}.${max}`);
  }
});

it("rejects unsupported kinds, unavailable modes and incompatible capabilities", async () => {
  const docs = limits => action("google_docs", ["create_document"], limits);
  const drive = limits => action("google_drive", ["list_files"], limits);
  const whatsapp = (caps, limits) => action("whatsapp", caps, limits);
  for (const [entry, field] of [
    [docs({ folderAccess: { maxFolders: 1 } }), "folderAccess"],
    [drive({ folderAccess: { allow: ["any_folder"], maxFolders: 1 } }), "folderAccess.maxFolders"],
    [docs({ fileAccess: { allow: ["selected_files"] } }), "fileAccess.allow"],
    [action("google_sheets", ["create_spreadsheet"], { fileAccess: { allow: ["selected_files"] } }), "fileAccess.allow"],
    [whatsapp(["send_text"], { context: { maxChats: 1 } }), "context"],
    [whatsapp(["read_messages"], { outbound: { maxChats: 1 } }), "outbound"],
    [whatsapp(["send_text"], { outbound: { allow: ["triggering_sender"], chatKinds: ["group"] } }), "outbound.chatKinds"],
    [whatsapp(["send_text"], { outbound: { allow: ["triggering_sender"], maxChats: -1 } }), "outbound.maxChats"],
  ]) await rejects(definitions([entry]), `actions[0].${field}`);
  await rejects(definitions([], [trigger({ kind: "gitrepo", eventTypes: ["issue.opened"], audience: { maxChats: 1 } })]), "triggers[0].audience");
  await rejects(definitions([], [trigger({ audience: { allow: ["anyone"], maxChats: 1 } })]), "triggers[0].audience.maxChats");
});

it("rejects empty limits, unexpected keys, and invalid mode or chat lists", async () => {
  for (const [folderAccess, field] of [
    [{}, "folderAccess"],
    [{ fileIds: ["pinned"] }, "folderAccess"],
    [{ allow: [] }, "folderAccess.allow"],
    [{ allow: ["selected_folders", "selected_folders"] }, "folderAccess.allow"],
    [{ allow: ["selected_files"] }, "folderAccess.allow"],
  ]) await rejects(definitions([action("google_drive", ["list_files"], { folderAccess })]), `actions[0].${field}`);
  await rejects(definitions([action("google_calendar", ["read_event"], { calendars: {} })]), "actions[0].calendars.maxCalendars");
  await rejects(definitions([], [trigger({ audience: { chatTypes: ["private", "private"] } })]), "triggers[0].audience.chatTypes");
});
