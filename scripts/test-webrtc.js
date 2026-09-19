import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Locate playwright
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  const candidatePaths = [
    path.resolve(__dirname, '../frontend/node_modules/playwright'),
    path.resolve(__dirname, '../node_modules/playwright'),
    path.resolve(__dirname, './node_modules/playwright'),
  ];
  for (const candidate of candidatePaths) {
    try {
      ({ chromium } = require(candidate));
      if (chromium) break;
    } catch (err) {}
  }
}

if (!chromium) {
  console.error('Playwright not found. Please install playwright.');
  process.exit(1);
}

// Check port connectivity and content
async function isVideoChatApp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const text = await res.text();
    return text.toLowerCase().includes('video chat');
  } catch (e) {
    return false;
  }
}

async function findFrontendUrl() {
  const ports = [5174, 5173, 5175, 3000];
  for (const port of ports) {
    if (await isVideoChatApp(`http://localhost:${port}`)) {
      return `http://localhost:${port}`;
    }
  }
  return 'http://localhost:5173';
}

async function findBackendUrl() {
  for (const host of ['127.0.0.1:8000', 'localhost:8000']) {
    try {
      const res = await fetch(`http://${host}/ice-servers`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return `http://${host}`;
    } catch (e) {}
  }
  return 'http://127.0.0.1:8000';
}

async function getRoomCode(backendUrl) {
  // Calls POST /create-room once to get a room code
  try {
    const res = await fetch(`${backendUrl}/create-room`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json();
      const code = data.room || data.roomId || data.code || data.id;
      if (code) return code;
    }
  } catch (e) {}

  // Fallback room code if backend does not implement POST /create-room
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function run() {
  const backendUrl = await findBackendUrl();
  const frontendUrl = await findFrontendUrl();

  const roomCode = await getRoomCode(backendUrl);
  const roomUrl = `${frontendUrl}/room/${roomCode}`;

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });

  const context1 = await browser.newContext({
    permissions: ['camera', 'microphone'],
  });
  const context2 = await browser.newContext({
    permissions: ['camera', 'microphone'],
  });

  const page1 = await context1.newPage();
  const page2 = await context2.newPage();

  // Preset display name in sessionStorage
  await page1.addInitScript(() => {
    sessionStorage.setItem('videochat_display_name', 'Peer 1');
  });
  await page2.addInitScript(() => {
    sessionStorage.setItem('videochat_display_name', 'Peer 2');
  });

  let peer1Connected = false;
  let peer2Connected = false;
  let finished = false;

  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(async () => {
      if (!finished) {
        finished = true;
        console.error(
          `Timed out after 15 seconds. Peer1 connected: ${peer1Connected}, Peer2 connected: ${peer2Connected}`
        );
        await browser.close();
        reject(new Error('Timed out waiting for ICE connected state'));
      }
    }, 15000);

    function checkBothConnected() {
      if (peer1Connected && peer2Connected && !finished) {
        finished = true;
        clearTimeout(timer);
        setTimeout(async () => {
          await browser.close();
          resolve();
        }, 500);
      }
    }

    // Listen to browser console and print lines containing [WebRTC]
    page1.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[WebRTC]')) {
        console.log(`Peer1: ${text}`);
        if (text.includes('ICE connected') || text.includes('ICE completed')) {
          peer1Connected = true;
          checkBothConnected();
        }
      }
    });

    page2.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[WebRTC]')) {
        console.log(`Peer2: ${text}`);
        if (text.includes('ICE connected') || text.includes('ICE completed')) {
          peer2Connected = true;
          checkBothConnected();
        }
      }
    });

    try {
      await page1.goto(roomUrl, { waitUntil: 'domcontentloaded' });
      await page1.waitForTimeout(1500);

      await page2.goto(roomUrl, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        await browser.close();
        reject(err);
      }
    }
  });
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
