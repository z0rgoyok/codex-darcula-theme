#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const TARGET_BUNDLE_PATH = ".vite/build/main-CQwPb0Th.js";
const PATCH_MARKER = "/*codex-darcula-patch*/";
const INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;

const DARCULA_CSS = `${PATCH_MARKER}
:root,
html,
body,
#root {
  color-scheme: dark !important;
  background: #2b2b2b !important;
  color: #a9b7c6 !important;
}

* {
  border-color: #4e5254 !important;
}

main,
section,
article,
aside,
header,
footer,
nav,
div[data-panel],
[data-theme="dark"] {
  background-color: #2b2b2b !important;
  color: #a9b7c6 !important;
}

aside,
nav,
[data-sidebar],
[role="complementary"] {
  background-color: #3c3f41 !important;
}

button,
input,
textarea,
select,
[role="button"] {
  background-color: #3c3f41 !important;
  color: #a9b7c6 !important;
  border-color: #5c6164 !important;
}

button:hover,
[role="button"]:hover {
  background-color: #4b5052 !important;
}

a {
  color: #589df6 !important;
}

a:hover {
  color: #73b1ff !important;
}

pre,
code {
  background-color: #313335 !important;
  color: #a9b7c6 !important;
}

::selection {
  background: #214283 !important;
  color: #dfe6ee !important;
}

::-webkit-scrollbar-thumb {
  background: #5c6164 !important;
  border-radius: 8px !important;
}

::-webkit-scrollbar-track {
  background: #2b2b2b !important;
}
`;

function parseArgs(argv) {
  const result = {
    command: argv[2] || "status",
    appPath: "/Applications/Codex.app",
    codeSign: true,
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--app" && argv[i + 1]) {
      result.appPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--no-codesign") {
      result.codeSign = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}

function getPaths(appPath) {
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  return {
    appPath,
    infoPlistPath: path.join(appPath, "Contents", "Info.plist"),
    infoPlistBackupPath: path.join(resourcesDir, "Info.plist.bak-darcula"),
    asarPath: path.join(resourcesDir, "app.asar"),
    backupPath: path.join(resourcesDir, "app.asar.bak-darcula"),
    metaPath: path.join(resourcesDir, "app.asar.darcula-meta.json"),
    tempPath: path.join(resourcesDir, "app.asar.tmp-darcula"),
  };
}

function ensureExists(filePath, description) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${description} not found: ${filePath}`);
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function getAsarHeaderHash(asarBuffer) {
  if (asarBuffer.length < 20) {
    throw new Error("Invalid asar: too small");
  }
  const headerJsonLength = asarBuffer.readUInt32LE(12);
  const headerStart = 16;
  const headerEnd = headerStart + headerJsonLength;
  if (headerEnd > asarBuffer.length) {
    throw new Error("Invalid asar: header length exceeds file size");
  }
  return sha256(asarBuffer.slice(headerStart, headerEnd));
}

function parseAsar(buffer) {
  if (buffer.length < 20) {
    throw new Error("Invalid asar: too small");
  }

  const headerJsonLength = buffer.readUInt32LE(12);
  const headerStart = 16;
  const headerEnd = headerStart + headerJsonLength;

  if (headerEnd > buffer.length) {
    throw new Error("Invalid asar: header length exceeds file size");
  }

  const headerJson = buffer.slice(headerStart, headerEnd).toString("utf8");
  const header = JSON.parse(headerJson);

  return {
    header,
    headerJsonLength,
    dataOffset: headerEnd,
  };
}

function walkLeafEntries(node, prefix, visitor) {
  const files = node && node.files ? node.files : {};
  for (const [name, entry] of Object.entries(files)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (entry && entry.files) {
      walkLeafEntries(entry, rel, visitor);
    } else {
      visitor(rel, entry);
    }
  }
}

function extractFileMap(asarBuffer, header, dataOffset) {
  const map = new Map();

  walkLeafEntries(header, "", (relPath, entry) => {
    if (entry.unpacked === true) {
      return;
    }

    const offset = Number(entry.offset);
    const size = Number(entry.size);
    const start = dataOffset + offset;
    const end = start + size;

    if (!Number.isFinite(offset) || !Number.isFinite(size) || start < 0 || end > asarBuffer.length) {
      throw new Error(`Invalid entry offsets for ${relPath}`);
    }

    map.set(relPath, asarBuffer.slice(start, end));
  });

  return map;
}

function buildAsar(header, fileMap) {
  const chunks = [];
  let runningOffset = 0;

  function computeEntryIntegrity(fileBuffer) {
    const blocks = [];
    for (let offset = 0; offset < fileBuffer.length; offset += INTEGRITY_BLOCK_SIZE) {
      const chunk = fileBuffer.slice(offset, Math.min(offset + INTEGRITY_BLOCK_SIZE, fileBuffer.length));
      blocks.push(sha256(chunk));
    }
    return {
      algorithm: "SHA256",
      hash: sha256(fileBuffer),
      blockSize: INTEGRITY_BLOCK_SIZE,
      blocks,
    };
  }

  function rebuildNode(node, prefix) {
    const out = { ...node };
    if (!node.files) {
      return out;
    }

    out.files = {};

    for (const [name, entry] of Object.entries(node.files)) {
      const relPath = prefix ? `${prefix}/${name}` : name;

      if (entry && entry.files) {
        out.files[name] = rebuildNode(entry, relPath);
        continue;
      }

      if (entry.unpacked === true) {
        out.files[name] = { ...entry };
        continue;
      }

      const fileBuffer = fileMap.get(relPath);
      if (!fileBuffer) {
        throw new Error(`Missing data for file: ${relPath}`);
      }

      const rebuiltEntry = { ...entry };
      rebuiltEntry.offset = String(runningOffset);
      rebuiltEntry.size = fileBuffer.length;
      rebuiltEntry.integrity = computeEntryIntegrity(fileBuffer);

      out.files[name] = rebuiltEntry;
      chunks.push(fileBuffer);
      runningOffset += fileBuffer.length;
    }

    return out;
  }

  const rebuiltHeader = rebuildNode(header, "");
  const headerJsonBuffer = Buffer.from(JSON.stringify(rebuiltHeader), "utf8");

  const prelude = Buffer.alloc(16);
  prelude.writeUInt32LE(4, 0);
  prelude.writeUInt32LE(headerJsonBuffer.length + 8, 4);
  prelude.writeUInt32LE(headerJsonBuffer.length + 4, 8);
  prelude.writeUInt32LE(headerJsonBuffer.length, 12);

  return Buffer.concat([prelude, headerJsonBuffer, ...chunks]);
}

function patchBundleSource(sourceText) {
  if (sourceText.includes(PATCH_MARKER)) {
    return { sourceText, alreadyPatched: true };
  }

  const themeSourceAnchor =
    'function dB(t){t==="light"||t==="dark"?U.nativeTheme.themeSource=t:U.nativeTheme.themeSource="system"}';

  if (!sourceText.includes(themeSourceAnchor)) {
    throw new Error("Could not find nativeTheme anchor in bundle");
  }

  const helperCode =
    `${themeSourceAnchor}const cdpDarculaCss=${JSON.stringify(DARCULA_CSS)};` +
    "function cdpApplyDarcula(win){if(!win||win.isDestroyed())return;const apply=()=>{if(win.isDestroyed())return;try{const wc=win.webContents;if(!wc||wc.isDestroyed())return;wc.insertCSS(cdpDarculaCss).catch(()=>{});}catch{}};win.webContents.once(\"did-finish-load\",apply);if(!win.webContents.isLoadingMainFrame())apply();}";

  let patched = sourceText.replace(themeSourceAnchor, helperCode);

  const windowCreationAnchor =
    "this.installNativeContextMenu(y),l&&this.installLiquidGlass(y,u),!U.app.isPackaged";

  if (!patched.includes(windowCreationAnchor)) {
    throw new Error("Could not find BrowserWindow hook anchor in bundle");
  }

  patched = patched.replace(
    windowCreationAnchor,
    "this.installNativeContextMenu(y),l&&this.installLiquidGlass(y,u),cdpApplyDarcula(y),!U.app.isPackaged",
  );

  if (!patched.includes(PATCH_MARKER) || !patched.includes("cdpApplyDarcula(y)")) {
    throw new Error("Patch verification failed");
  }

  return { sourceText: patched, alreadyPatched: false };
}

function loadBundleSourceFromAsar(asarBuffer) {
  const { header, dataOffset } = parseAsar(asarBuffer);
  const fileMap = extractFileMap(asarBuffer, header, dataOffset);
  const bundle = fileMap.get(TARGET_BUNDLE_PATH);

  if (!bundle) {
    throw new Error(`Target bundle not found: ${TARGET_BUNDLE_PATH}`);
  }

  return {
    header,
    fileMap,
    bundleSource: bundle.toString("utf8"),
  };
}

function ensureBackup(paths, currentAsarBuffer) {
  if (!fs.existsSync(paths.backupPath)) {
    fs.writeFileSync(paths.backupPath, currentAsarBuffer);
    console.log(`Backup created: ${paths.backupPath}`);
  } else {
    console.log(`Backup exists: ${paths.backupPath}`);
  }

  if (!fs.existsSync(paths.infoPlistBackupPath)) {
    fs.copyFileSync(paths.infoPlistPath, paths.infoPlistBackupPath);
    console.log(`Backup created: ${paths.infoPlistBackupPath}`);
  } else {
    console.log(`Backup exists: ${paths.infoPlistBackupPath}`);
  }
}

function tryCodeSign(appPath) {
  const result = spawnSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    console.warn("codesign failed; app may still run, but macOS can reject it in some cases.");
  } else {
    console.log("codesign completed.");
  }
}

function getInfoPlistAsarHash(infoPlistPath) {
  const result = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :ElectronAsarIntegrity:Resources/app.asar:hash", infoPlistPath],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(`Could not read asar hash from Info.plist: ${result.stderr || result.stdout}`.trim());
  }

  return result.stdout.trim();
}

function setInfoPlistAsarHash(infoPlistPath, hash) {
  const result = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`, infoPlistPath],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(`Could not update asar hash in Info.plist: ${result.stderr || result.stdout}`.trim());
  }
}

function writeMeta(paths, payload) {
  fs.writeFileSync(paths.metaPath, JSON.stringify(payload, null, 2));
}

function commandStatus(paths) {
  ensureExists(paths.infoPlistPath, "Info.plist");
  ensureExists(paths.asarPath, "app.asar");
  const asarBuffer = fs.readFileSync(paths.asarPath);
  const { bundleSource } = loadBundleSourceFromAsar(asarBuffer);
  const headerHash = getAsarHeaderHash(asarBuffer);
  const plistHash = getInfoPlistAsarHash(paths.infoPlistPath);

  console.log(`app: ${paths.appPath}`);
  console.log(`asar: ${paths.asarPath}`);
  console.log(`backup: ${fs.existsSync(paths.backupPath) ? "yes" : "no"}`);
  console.log(`plist-backup: ${fs.existsSync(paths.infoPlistBackupPath) ? "yes" : "no"}`);
  console.log(`darcula-patched: ${bundleSource.includes(PATCH_MARKER) ? "yes" : "no"}`);
  console.log(`asar-header-sha256: ${headerHash}`);
  console.log(`plist-sha256: ${plistHash}`);
  console.log(`integrity-match: ${headerHash === plistHash ? "yes" : "no"}`);
}

function commandPatch(paths, codeSign) {
  ensureExists(paths.infoPlistPath, "Info.plist");
  ensureExists(paths.asarPath, "app.asar");

  const originalAsar = fs.readFileSync(paths.asarPath);
  ensureBackup(paths, originalAsar);

  const originalHash = getAsarHeaderHash(originalAsar);
  const originalPlistHash = getInfoPlistAsarHash(paths.infoPlistPath);
  const { header, fileMap, bundleSource } = loadBundleSourceFromAsar(originalAsar);
  const { sourceText: patchedBundleSource, alreadyPatched } = patchBundleSource(bundleSource);

  if (alreadyPatched) {
    if (originalPlistHash !== originalHash) {
      setInfoPlistAsarHash(paths.infoPlistPath, originalHash);
      console.log("Darcula patch already present; Info.plist hash fixed.");
      if (codeSign) {
        tryCodeSign(paths.appPath);
      }
      return;
    }
    console.log("Darcula patch is already applied.");
    return;
  }

  fileMap.set(TARGET_BUNDLE_PATH, Buffer.from(patchedBundleSource, "utf8"));
  const rebuiltAsar = buildAsar(header, fileMap);
  const rebuiltHash = getAsarHeaderHash(rebuiltAsar);

  fs.writeFileSync(paths.tempPath, rebuiltAsar);
  fs.renameSync(paths.tempPath, paths.asarPath);
  setInfoPlistAsarHash(paths.infoPlistPath, rebuiltHash);

  writeMeta(paths, {
    patchedAt: new Date().toISOString(),
    backupPath: paths.backupPath,
    infoPlistBackupPath: paths.infoPlistBackupPath,
    targetBundlePath: TARGET_BUNDLE_PATH,
    marker: PATCH_MARKER,
    oldPlistSha256: originalPlistHash,
    oldSha256: originalHash,
    newPlistSha256: rebuiltHash,
    newSha256: rebuiltHash,
  });

  console.log("Darcula patch applied.");
  console.log(`old sha256: ${originalHash}`);
  console.log(`new sha256: ${rebuiltHash}`);

  if (codeSign) {
    tryCodeSign(paths.appPath);
  }
}

function commandRestore(paths, codeSign) {
  ensureExists(paths.infoPlistPath, "Info.plist");
  ensureExists(paths.backupPath, "Darcula backup");
  const backupAsar = fs.readFileSync(paths.backupPath);

  fs.writeFileSync(paths.tempPath, backupAsar);
  fs.renameSync(paths.tempPath, paths.asarPath);
  if (fs.existsSync(paths.infoPlistBackupPath)) {
    fs.copyFileSync(paths.infoPlistBackupPath, paths.infoPlistPath);
  } else {
    console.warn(`Info.plist backup not found (${paths.infoPlistBackupPath}), keeping current Info.plist.`);
  }

  console.log("Original app.asar restored from backup.");

  if (codeSign) {
    tryCodeSign(paths.appPath);
  }
}

function printUsage() {
  console.log("Usage:");
  console.log("  node codex-darcula-theme.js status [--app /Applications/Codex.app]");
  console.log("  node codex-darcula-theme.js patch  [--app /Applications/Codex.app] [--no-codesign]");
  console.log("  node codex-darcula-theme.js restore [--app /Applications/Codex.app] [--no-codesign]");
}

function main() {
  const { command, appPath, codeSign } = parseArgs(process.argv);
  const paths = getPaths(appPath);

  switch (command) {
    case "status":
      commandStatus(paths);
      break;
    case "patch":
      commandPatch(paths, codeSign);
      break;
    case "restore":
      commandRestore(paths, codeSign);
      break;
    default:
      printUsage();
      throw new Error(`Unknown command: ${command}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
