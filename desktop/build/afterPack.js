"use strict";

/**
 * Shrinks the packaged app without touching behaviour.
 *
 * Electron ships a locale pack for 55 languages (43 MB in 38.x) even though
 * this window only ever renders Chinese or English — Electron falls back to
 * en-US for anything missing. Everything else (the 200 MB runtime exe, ANGLE's
 * DirectX compilers, ICU data, SwiftShader, the Chromium licence) is required
 * and stays.
 */

const fs = require("node:fs");
const path = require("node:path");

const KEEP = new Set(["zh-CN.pak", "en-US.pak"]);

exports.default = async function afterPack(context) {
  const dir = path.join(context.appOutDir, "locales");
  let removed = 0;
  let freed = 0;
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const f of files) {
    if (KEEP.has(f)) continue;
    const p = path.join(dir, f);
    try {
      freed += fs.statSync(p).size;
      fs.rmSync(p, { force: true });
      removed++;
    } catch {
      /* ignore */
    }
  }
  console.log(`afterPack: removed ${removed} locale packs (${(freed / 1048576).toFixed(1)} MB freed)`);
};
