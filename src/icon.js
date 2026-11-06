import { SaxesParser } from "saxes";
import { imageSize } from "image-size";
import { sha256Hex } from "./util.js";

export const DEFAULT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="16" height="14" rx="4"/><path d="M12 3v3M8 16h8"/><circle cx="8.5" cy="11" r=".75" fill="currentColor"/><circle cx="15.5" cy="11" r=".75" fill="currentColor"/></svg>';
const SVG_NS = "http://www.w3.org/2000/svg";
const elements = new Set("svg g defs path rect circle ellipse line polyline polygon linearGradient radialGradient stop clipPath mask pattern use symbol title desc".split(" "));
const attributes = new Set("id version viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity transform gradientTransform gradientUnits spreadMethod offset stop-color stop-opacity clip-path clip-rule mask maskUnits maskContentUnits patternUnits patternContentUnits patternTransform preserveAspectRatio vector-effect color href".split(" "));
attributes.add("style");
const styleProperties = new Set("fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity stop-color stop-opacity clip-path clip-rule mask vector-effect color".split(" "));

export function iconPath(value) {
  if (typeof value !== "string" || !value || value.length > 512 || /[:\\\s\u0000-\u001f\u007f]/.test(value) || value.startsWith("/")) throw new Error("icon must be a repository-relative SVG, PNG, or WebP path (max 512 characters)");
  const path = value.startsWith("./") ? value.slice(2) : value;
  if (path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")) || !/\.(svg|png|webp)$/i.test(path)) throw new Error("icon must be a repository-relative SVG, PNG, or WebP path without traversal");
  return path;
}

function square(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || width !== height || width > 4096) throw new Error("icon dimensions must be positive, square, and at most 4096 pixels");
}

function svgDimensions(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parser = new SaxesParser({ xmlns: true });
  let root = false;
  let dimensions;
  parser.on("doctype", () => { throw new Error("SVG DOCTYPE and entities are forbidden"); });
  parser.on("processinginstruction", () => { throw new Error("SVG processing instructions are forbidden"); });
  parser.on("error", (error) => { throw error; });
  parser.on("opentag", (node) => {
    if (node.uri !== SVG_NS || !elements.has(node.local)) throw new Error(`unsafe SVG element: ${node.name}`);
    if (!root) {
      root = true;
      if (node.local !== "svg") throw new Error("icon must have an SVG root");
      const values = node.attributes.viewBox?.value.trim().split(/[\s,]+/).map(Number);
      if (!values || values.length !== 4 || !values.every(Number.isFinite)) throw new Error("SVG icon requires a square viewBox");
      square(values[2], values[3]);
      const width = node.attributes.width?.value;
      const height = node.attributes.height?.value;
      if (width !== undefined || height !== undefined) {
        if (!(width === "100%" && height === "100%")) {
          if (!width || !height || !/^\d+(?:\.\d+)?(?:px)?$/.test(width) || !/^\d+(?:\.\d+)?(?:px)?$/.test(height)) throw new Error("SVG viewport must have matching numeric dimensions or 100% dimensions");
          square(Number(width.replace(/px$/, "")), Number(height.replace(/px$/, "")));
        }
      }
      dimensions = { width: values[2], height: values[3] };
    }
    for (const attr of Object.values(node.attributes)) {
      if (attr.uri === "http://www.w3.org/2000/xmlns/") {
        if (attr.value !== SVG_NS && attr.value !== "http://www.w3.org/1999/xlink") throw new Error("unsupported SVG namespace");
        continue;
      }
      if ((attr.uri && !(attr.uri === "http://www.w3.org/1999/xlink" && attr.local === "href")) || !attributes.has(attr.local)) throw new Error(`unsafe SVG attribute: ${attr.name}`);
      const value = attr.value;
      if (attr.local === "style") {
        for (const declaration of value.split(";")) {
          if (!declaration.trim()) continue;
          const colon = declaration.indexOf(":");
          const property = declaration.slice(0, colon).trim().toLowerCase();
          if (colon < 0 || !styleProperties.has(property) || !declaration.slice(colon + 1).trim() || /[{}!]/.test(declaration)) throw new Error("unsafe SVG style declaration");
        }
      }
      if (attr.local === "href" && !/^#[A-Za-z_][\w:.-]*$/.test(value)) throw new Error("SVG references must be local fragments");
      // Reject CSS escapes/comments and anything except literal local paint references.
      if (/[\\@]|\/\*|[\u0000-\u001f]/.test(value)) throw new Error("unsafe SVG attribute value");
      const withoutUrls = value.replace(/url\(\s*(['"]?)#[A-Za-z_][\w:.-]*\1\s*\)/gi, "");
      if (/url\s*\(|(?:https?|data|javascript|file):|\/\//i.test(withoutUrls)) throw new Error("external SVG references are forbidden");
    }
  });
  parser.write(text).close();
  if (!dimensions) throw new Error("icon must contain SVG artwork");
  return dimensions;
}

// Check complete container framing, not just image-size's header dimensions.
function validateRasterContainer(bytes, ext) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (ext === "png") {
    let offset = 8;
    let header = false;
    let data = false;
    let ended = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      const type = tag(offset + 4);
      if (length > bytes.length - offset - 12) throw new Error("truncated PNG icon");
      if (!header && (type !== "IHDR" || length !== 13)) throw new Error("PNG icon requires IHDR");
      header = true;
      if (type === "IDAT" && length > 0) data = true;
      offset += length + 12;
      if (type === "IEND") {
        if (length !== 0 || offset !== bytes.length) throw new Error("invalid PNG end chunk");
        ended = true;
        break;
      }
    }
    if (!header || !data || !ended) throw new Error("incomplete PNG icon");
  } else {
    if (bytes.length < 20 || tag(0) !== "RIFF" || tag(8) !== "WEBP" || view.getUint32(4, true) + 8 !== bytes.length) throw new Error("invalid WebP container length");
    let offset = 12;
    let image = false;
    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset + 4, true);
      if (length > bytes.length - offset - 8) throw new Error("truncated WebP icon");
      const type = tag(offset);
      if ((type === "VP8 " || type === "VP8L" || type === "ANMF") && length > 0) image = true;
      offset += 8 + length + (length % 2);
    }
    if (!image || offset !== bytes.length) throw new Error("incomplete WebP icon");
  }
}

export function validateIcon(path, bytes) {
  path = iconPath(path);
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error("icon asset bytes are missing");
  if (bytes.length > 256 * 1024) throw new Error("icon exceeds the 256 KiB limit");
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  let dimensions;
  if (ext === "svg") dimensions = svgDimensions(bytes);
  else {
    dimensions = imageSize(bytes);
    if (dimensions.type !== ext) throw new Error("icon format does not match its file extension");
    validateRasterContainer(bytes, ext);
    square(dimensions.width, dimensions.height);
    if (dimensions.images?.some((image) => image.width !== dimensions.width || image.height !== dimensions.height)) throw new Error("icon frames must have matching square dimensions");
  }
  return { path, bytes, mime: ext === "svg" ? "image/svg+xml" : `image/${ext}`, sha256: sha256Hex(bytes), size: bytes.length, width: dimensions.width, height: dimensions.height };
}
