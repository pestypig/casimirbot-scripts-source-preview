const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const css = fs.readFileSync(path.join(__dirname, "../client/src/components/helix/ask-console/HelixConsoleConversationWorkspace.css"), "utf8");

async function check(page, width, height, channel) {
  await page.setViewportSize({ width, height });
  const lines = Array.from({ length: 45 }, (_, index) => `<p>Conversation answer line ${index + 1}: a complete thought that needs to remain readable.</p>`).join("");
  const ask = channel === "ask";
  await page.setContent(`<style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #020617; color: white; }
    .dock { display: flex; flex-direction: column; height: ${height}px; width: ${width}px; padding: 8px; }
    .stack { display: flex; flex-direction: column; min-height: 0; height: 100%; }
    .pill { flex: none; height: 148px; }
    ${css}
  </style><div class="dock"><div class="stack"><div class="pill">Helix pill</div>
    <section class="helix-console-conversations" data-layout-variant="dock">
      <div class="helix-console-conversations__layout">
        <nav class="helix-console-conversations__channels"><button># Private Ask</button><button># Room</button></nav>
        <div class="helix-console-conversations__pane">
          <header class="helix-console-conversations__header">${ask ? "Private Ask" : "Room"}</header>
          <div class="helix-console-conversations__body helix-console-conversations__body--${ask ? "ask" : "scroll"}">
            <div ${ask ? 'data-testid="helix-ask-turn-list-scroll"' : 'role="log"'}>${lines}</div>
          </div>
        </div>
      </div>
    </section></div></div>`);
  const result = await page.evaluate((ask) => {
    const pane = document.querySelector(".helix-console-conversations__pane");
    const header = document.querySelector(".helix-console-conversations__header");
    const scroll = document.querySelector(ask ? "[data-testid='helix-ask-turn-list-scroll']" : ".helix-console-conversations__body");
    const before = header.getBoundingClientRect().top;
    const extent = { client: scroll.clientHeight, content: scroll.scrollHeight };
    scroll.scrollTop = scroll.scrollHeight;
    return { ...extent, scrollTop: scroll.scrollTop, paneBottom: pane.getBoundingClientRect().bottom,
      headerBefore: before, headerAfter: header.getBoundingClientRect().top,
      overflow: getComputedStyle(scroll).overflowY };
  }, ask);
  assert.ok(result.content > result.client, `${channel} must overflow at ${width}x${height}: ${JSON.stringify(result)}`);
  assert.ok(result.scrollTop > 0, `${channel} must scroll at ${width}x${height}: ${JSON.stringify(result)}`);
  assert.ok(result.paneBottom <= height + 1, `${channel} must stay inside dock at ${width}x${height}: ${JSON.stringify(result)}`);
  assert.equal(result.headerAfter, result.headerBefore, `${channel} header should stay visible`);
  assert.equal(result.overflow, "scroll");
  console.log(`PASS ${channel} ${width}x${height}: ${result.client}px viewport, ${result.content}px content`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const [width, height] of [[1427, 810], [375, 667]]) {
      await check(page, width, height, "ask");
      await check(page, width, height, "room");
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
