import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBotFiles, scaffoldBotFiles, exportBotFiles } from "../src/index.js";
import { CRON_TRIGGER_EVENT_TYPES } from "../src/contract.js";

const trigger = (overrides = {}) => ({ key: "morning-triage", label: "Morning triage", kind: "cron", eventTypes: ["cron.tick"], deciderInstructions: "Decide whether to act", ...overrides });
const source = (triggers) => ({ ...scaffoldBotFiles({ name: "Triggers" }), "bot.yaml": `formatVersion: 1\nname: Triggers\ndescription: D\nmodelRoles: [{role: default, label: Main}]\ntriggers: ${JSON.stringify(triggers)}\n` });

describe("Cron trigger authoring", () => {
  it("exposes the single cron.tick semantic event", () => {
    assert.deepEqual([...CRON_TRIGGER_EVENT_TYPES], ["cron.tick"]);
  });

  it("accepts a cron trigger without a schedule and round-trips it", async () => {
    const initial = await parseBotFiles(source([trigger()]));
    assert.equal(initial.draft.triggers[0].kind, "cron");
    assert.deepEqual(initial.draft.triggers[0].eventTypes, ["cron.tick"]);
    assert.equal(initial.draft.triggers[0].schedule, undefined);
    const roundtrip = await parseBotFiles(exportBotFiles(initial.draft));
    assert.deepEqual(roundtrip.draft.triggers, initial.draft.triggers);
  });

  it("accepts and normalizes an author-suggested schedule", async () => {
    const initial = await parseBotFiles(source([trigger({ schedule: { expression: "  0  9  *  *  1-5 ", timeZone: "America/New_York" } })]));
    assert.deepEqual(initial.draft.triggers[0].schedule, { expression: "0 9 * * 1-5", timeZone: "America/New_York" });
    const roundtrip = await parseBotFiles(exportBotFiles(initial.draft));
    assert.deepEqual(roundtrip.draft.triggers, initial.draft.triggers);
  });

  it("rejects non-cron events, extra events, schedules on other kinds, and bad schedules", async () => {
    const invalid = [
      trigger({ eventTypes: ["issue.opened"] }),
      trigger({ eventTypes: ["cron.tick", "issue.opened"] }),
      trigger({ eventTypes: ["cron.tick", "cron.tick"] }),
      trigger({ kind: "gitrepo", eventTypes: ["issue.opened"], schedule: { expression: "0 9 * * *", timeZone: "UTC" } }),
      trigger({ kind: "whatsapp", eventTypes: ["message.created"], schedule: { expression: "0 9 * * *", timeZone: "UTC" } }),
      trigger({ schedule: { expression: "not a cron", timeZone: "UTC" } }),
      trigger({ schedule: { expression: "0 9 * *", timeZone: "UTC" } }),
      trigger({ schedule: { expression: "0 9 * * *", timeZone: "Mars/Olympus" } }),
      trigger({ schedule: { expression: "0 9 * * *", timeZone: "UTC", extra: true } }),
      trigger({ schedule: "0 9 * * *" }),
      trigger({ schedule: { expression: "", timeZone: "UTC" } }),
    ];
    for (const entry of invalid) {
      await assert.rejects(parseBotFiles(source([entry])), undefined, JSON.stringify(entry));
    }
  });
});
