import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBotFiles, validateFiles, scaffoldBotFiles, scaffoldBot, validateSource, exportBotFiles } from "../src/index.js";
import { DEFAULT_ICON } from "../src/icon.js";

const svg = (body = '<rect width="24" height="24" fill="#e23"/>', viewBox = '0 0 24 24') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;
function files(bytes = svg(), path = "assets/icon.svg") {
  const source = scaffoldBotFiles({ name: "Icon" });
  source["bot.yaml"] = source["bot.yaml"].replace("./assets/icon.svg", `./${path}`);
  delete source["assets/icon.svg"];
  if (bytes !== undefined) source[path] = bytes;
  return source;
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

describe("repository icons", () => {
  it("provisions the exact default glyph and validates a new repository", async () => {
    const source = scaffoldBotFiles({ name: "Provisioned" });
    assert.equal(source["assets/icon.svg"], DEFAULT_ICON);
    const dir = await mkdtemp(join(tmpdir(), "librebot-icon-"));
    try {
      await scaffoldBot(dir, { name: "Provisioned" });
      const result = await validateSource(dir);
      assert.equal(result.ok, true);
      assert.equal(result.draft.icon, "./assets/icon.svg");
      assert.equal(result.icon.width, 24);
      assert.equal(result.icon.mime, "image/svg+xml");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("round-trips original asset bytes separately from knowledge", async () => {
    const initial = await parseBotFiles(files(svg(), "knowledge/icon.svg"));
    assert.equal(initial.assets.length, 0);
    assert.equal(initial.draft.knowledge.some((entry) => entry.name === "icon.svg"), false);
    assert.throws(() => exportBotFiles(initial.draft), /missing/);
    const exported = exportBotFiles(initial.draft, { icon: initial.icon });
    assert.deepEqual(exported["knowledge/icon.svg"], initial.icon.bytes);
    const again = await parseBotFiles(exported);
    assert.deepEqual(again.icon, initial.icon);
    assert.equal(again.draft.icon, "./knowledge/icon.svg");
  });
  it("accepts ordinary colored gradients and local references", async () => {
    const result = await validateFiles(files(svg('<defs><linearGradient id="paint"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#00ff00"/></linearGradient><path id="shape" d="M0 0h24v24z"/></defs><g transform="translate(1 1)" opacity=".8"><use href="#shape" fill="url(#paint)"/></g>')));
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });
  for (const [extension, bytes] of [["png", png], ["webp", webp]]) {
    it(`accepts actual square ${extension} bytes and preserves them`, async () => {
      const parsed = await parseBotFiles(files(bytes, `assets/icon.${extension}`));
      assert.equal(parsed.icon.width, 1);
      assert.equal(parsed.icon.height, 1);
      assert.equal(parsed.icon.mime, `image/${extension}`);
      assert.deepEqual(exportBotFiles(parsed.draft, { icon: parsed.icon })[`assets/icon.${extension}`], bytes);
    });
  }
  it("accepts safe inline presentation styles and square rendered viewport", async () => {
    const source = svg('<path style="fill:#e23;stroke:rgb(0,0,0);opacity:.8" d="M0 0h24v24z"/>').replace('viewBox=', 'width="512px" height="512px" viewBox=');
    assert.equal((await validateFiles(files(source))).ok, true);
    assert.equal((await validateFiles(files(svg().replace('viewBox=', 'width="100%" height="100%" viewBox=')))).ok, true);
  });
  for (const edge of [1, 256, 512, 4096]) {
    it(`accepts square viewBox edge ${edge}`, async () => {
      assert.equal((await validateFiles(files(svg("", `0 0 ${edge} ${edge}`)))).ok, true);
    });
  }
  it("rejects truncated raster containers despite valid dimensions", async () => {
    assert.equal((await validateFiles(files(png.subarray(0, 24), "assets/icon.png"))).ok, false);
    assert.equal((await validateFiles(files(webp.subarray(0, 30), "assets/icon.webp"))).ok, false);
  });
  it("accounts for the derived icon data URL in the total draft cap", async () => {
    const source = files(svg(" ".repeat(200000)));
    for (let i = 0; i < 6; i++) source[`knowledge/part${i}.txt`] = "x".repeat(90000);
    assert.equal((await validateFiles(source)).ok, false);
  });
  it("rejects URL-like, whitespace, hidden, and overlong paths", async () => {
    for (const path of ["assets/a:b.svg", "assets/a b.svg", ".hidden/icon.svg", `assets/${"a".repeat(510)}.svg`]) {
      assert.equal((await validateFiles(files(svg(), path))).ok, false);
    }
  });
  const invalid = [
    ["non-square viewport", svg().replace('viewBox=', 'width="20" height="24" viewBox=')],
    ["style external reference", svg('<path style="fill:url(&#104;ttps://example.org/a)"/>')],
    ["style custom property", svg('<path style="--fill:red;fill:var(--fill)"/>')],
    ["style escaped property", svg('<path style="f\\\\69ll:red"/>')],
    ["style import", svg('<path style="@import:https://example.org/a"/>')],
    ["non-square", svg("", "0 0 24 23")],
    ["zero", svg("", "0 0 0 0")],
    ["oversize dimensions", svg("", "0 0 4097 4097")],
    ["missing viewBox", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ["malformed XML", svg("<g>")],
    ["script", svg("<script>alert(1)</script>")],
    ["foreignObject", svg("<foreignObject/>")],
    ["animation", svg('<animate attributeName="fill"/>')],
    ["event", svg('<path onload="alert(1)"/>')],
    ["encoded external href", svg('<use href="&#104;ttps://example.org/a.svg#x"/>')],
    ["encoded external paint", svg('<path fill="url(&#104;ttps://example.org/a)"/>')],
    ["external image", svg('<image href="https://example.org/a.png"/>')],
    ["CSS font", svg('<style>@font-face {src:url(https://example.org/a)}</style>')],
    ["escaped CSS", svg('<path fill="u\\72l(https://example.org/a)"/>')],
    ["DOCTYPE", '<!DOCTYPE svg [<!ENTITY x "test">]>' + svg("&x;")],
    ["oversize bytes", svg(" ".repeat(256 * 1024))],
    ["format mismatch", png],
  ];
  for (const [name, bytes] of invalid) {
    it(`rejects ${name}`, async () => {
      const result = await validateFiles(files(bytes));
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.field === "icon"));
    });
  }
  it("rejects non-square raster dimensions and mismatched raster types", async () => {
    const rectangle = Buffer.from(png);
    rectangle.writeUInt32BE(2, 16);
    assert.equal((await validateFiles(files(rectangle, "assets/icon.png"))).ok, false);
    assert.equal((await validateFiles(files(png, "assets/icon.webp"))).ok, false);
  });
  it("rejects missing and traversing icon paths", async () => {
    const missing = files();
    delete missing["assets/icon.svg"];
    assert.equal((await validateFiles(missing)).ok, false);
    for (const path of ["../icon.svg", "/icon.svg", "assets/../icon.svg", "https://example.org/icon.svg"]) {
      const source = files();
      source["bot.yaml"] = source["bot.yaml"].replace("./assets/icon.svg", path);
      assert.equal((await validateFiles(source)).ok, false);
    }
  });
  it("rejects filesystem symlink assets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "librebot-icon-link-"));
    try {
      await mkdir(join(dir, "assets"));
      await symlink("../outside.svg", join(dir, "assets/icon.svg"));
      await assert.rejects(validateSource(dir), /symlinks/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
