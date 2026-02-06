#!/usr/bin/env node

const { spawn } = require("child_process");

const STYLE_ID = "cdp-darcula-runtime-style";
const DEFAULT_PORT = 9222;
const DEFAULT_APP_PATH = "/Applications/Codex.app";
const POLL_INTERVAL_MS = 1200;

const DARCULA_CSS = `
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
  const out = {
    port: DEFAULT_PORT,
    appPath: DEFAULT_APP_PATH,
    startApp: false,
    once: false,
    remove: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port" && argv[i + 1]) {
      out.port = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--app" && argv[i + 1]) {
      out.appPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--start-app") {
      out.startApp = true;
      continue;
    }
    if (arg === "--once") {
      out.once = true;
      continue;
    }
    if (arg === "--remove") {
      out.remove = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(out.port) || out.port <= 0) {
    throw new Error("Invalid --port value");
  }

  return out;
}

function printUsage() {
  console.log("Usage:");
  console.log("  node codex-darcula-runtime-inject.js [--port 9222] [--start-app] [--once]");
  console.log("  node codex-darcula-runtime-inject.js --remove [--port 9222]");
  console.log("");
  console.log("Options:");
  console.log("  --start-app          Launch Codex.app with --remote-debugging-port");
  console.log("  --app <path>         Path to Codex.app (default: /Applications/Codex.app)");
  console.log("  --port <number>      CDP port (default: 9222)");
  console.log("  --once               Inject once and exit");
  console.log("  --remove             Remove runtime style instead of injecting");
}

function startApp(appPath, port) {
  const args = ["-na", appPath, "--args", `--remote-debugging-port=${port}`];
  const child = spawn("open", args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTargets(port) {
  const url = `http://127.0.0.1:${port}/json/list`;
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(
      `CDP endpoint is unavailable on port ${port}. Start Codex with --remote-debugging-port=${port} (or run with --start-app).`,
    );
  }
  if (!response.ok) {
    throw new Error(`CDP endpoint ${url} returned ${response.status}`);
  }
  return response.json();
}

async function cdpEval(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  const send = (method, params) => {
    const id = ++seq;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const onMessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.id !== id) {
          return;
        }
        ws.removeEventListener("message", onMessage);
        if (message.error) {
          reject(new Error(JSON.stringify(message.error)));
          return;
        }
        resolve(message.result);
      };
      ws.addEventListener("message", onMessage);
      ws.send(payload);
    });
  };

  try {
    await send("Runtime.enable", {});
    await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
  } finally {
    ws.close();
  }
}

function buildInjectExpression() {
  const cssLiteral = JSON.stringify(DARCULA_CSS);
  return `(() => {
    const id = ${JSON.stringify(STYLE_ID)};
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      document.documentElement.appendChild(style);
    }
    style.textContent = ${cssLiteral};
    return 'injected';
  })()`;
}

function buildRemoveExpression() {
  return `(() => {
    const id = ${JSON.stringify(STYLE_ID)};
    const style = document.getElementById(id);
    if (style) style.remove();
    return 'removed';
  })()`;
}

async function injectToTargets(port, remove, processedTargets) {
  const targets = await fetchTargets(port);
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);

  for (const target of pages) {
    if (processedTargets.has(target.id) && !remove) {
      continue;
    }

    try {
      await cdpEval(
        target.webSocketDebuggerUrl,
        remove ? buildRemoveExpression() : buildInjectExpression(),
      );
      processedTargets.add(target.id);
      console.log(`${remove ? "removed" : "injected"}: ${target.title || target.id}`);
    } catch (error) {
      console.warn(`failed on ${target.title || target.id}: ${error.message}`);
    }
  }

  return pages.length;
}

async function main() {
  const options = parseArgs(process.argv);

  if (options.startApp) {
    startApp(options.appPath, options.port);
    await sleep(1600);
  }

  const processedTargets = new Set();

  if (options.once || options.remove) {
    await injectToTargets(options.port, options.remove, processedTargets);
    return;
  }

  console.log(`watch mode: CDP http://127.0.0.1:${options.port}`);
  while (true) {
    try {
      await injectToTargets(options.port, false, processedTargets);
    } catch (error) {
      console.warn(`waiting for Codex CDP endpoint: ${error.message}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
