// Driven screenshot scenarios (loaded by scripts/shots.mjs). Each drives
// the mock venue layer through the real UI and asserts on-page text where
// the state must be visible: a confirm sheet, a pending tag, a rejected
// order, the one-click panel, the phone sheets.
export function scenarios({ DESKTOP, PHONE }) {
  const desk = (name, path, drive, expect, extra = {}) => ({ name, vp: DESKTOP, path, drive, expect, ...extra });
  const phone = (name, path, drive, expect, extra = {}) => ({ name, vp: PHONE, path, drive, expect, mobile: true, ...extra });
  const byRole = (page, name) => page.getByRole("button", { name, exact: true }).first();
  return [
    // Order panel with a preset filled and the confirm sheet open (one-click OFF).
    desk("desktop-order-confirm", "/?mock=1", async (page) => {
      await page.locator("input").first().fill("0.01");
      await page.waitForTimeout(300);
      await byRole(page, "Buy / Long BTC").click();
      await page.waitForTimeout(500);
    }, "Sent once"),
    // Send it: the tag / list show pending, then the fill lands.
    desk("desktop-order-sent", "/?mock=1", async (page) => {
      await page.locator("input").first().fill("0.01");
      await byRole(page, "Buy / Long BTC").click();
      await page.waitForTimeout(300);
      await byRole(page, "Send the order").click();
      await page.waitForTimeout(250);
    }, "in flight", { wait: 2500 }),
    desk("desktop-order-filled", "/?mock=1", async (page) => {
      await page.locator("input").first().fill("0.01");
      await byRole(page, "Buy / Long BTC").click();
      await page.waitForTimeout(300);
      await byRole(page, "Send the order").click();
      await page.waitForTimeout(2500);
    }, "filled"),
    // A lost answer (mock scenario): the write stays in the unsettled strip
    // with Dismiss, Buy waits, and closing stays available.
    desk("desktop-order-unsettled", "/?mock=1&scenario=lost", async (page) => {
      await page.locator("input").first().fill("0.01");
      await byRole(page, "Buy / Long BTC").click();
      await page.waitForTimeout(300);
      await byRole(page, "Send the order").click();
      await page.waitForTimeout(2500);
    }, "not resent; checking the venue"),
    desk("desktop-order-unsettled-dismissed", "/?mock=1&scenario=lost", async (page) => {
      await page.locator("input").first().fill("0.01");
      await byRole(page, "Buy / Long BTC").click();
      await page.waitForTimeout(300);
      await byRole(page, "Send the order").click();
      await page.waitForTimeout(2500);
      await byRole(page, "Dismiss BUY 0.01 BTC").click();
      await page.waitForTimeout(400);
    }, "dismissed by you"),
    // Over the max notional: refused before anything is sent.
    desk("desktop-order-refused", "/?mock=1", async (page) => {
      await byRole(page, "Size $10000").click();
      await page.waitForTimeout(400);
    }, "above this market's max"),
    // Limit with a bad tick (too many significant digits): the mock venue
    // rejects it and history shows rejected, not pending.
    desk("desktop-order-rejected", "/?mock=1", async (page) => {
      await page.getByRole("tab", { name: "Limit" }).click();
      const inputs = page.locator("input");
      await inputs.nth(0).fill("0.01");
      await inputs.nth(1).fill("70000.123456789");
      await byRole(page, "Buy / Long BTC").click();
      await page.waitForTimeout(300);
      await byRole(page, "Send the order").click();
      await page.waitForTimeout(2000);
      await page.getByRole("tab", { name: /Order history/ }).click();
      await page.waitForTimeout(300);
    }, "rejected"),
    // One-click panel open, bid / ask live.
    desk("desktop-one-click", "/?mock=1", async (page) => {
      await byRole(page, "One-click panel").click();
      await page.waitForTimeout(400);
    }, "Sell"),
    // Close 50 percent from the positions tab: one tap, pending, then done.
    desk("desktop-close-half", "/?mock=1", async (page) => {
      await byRole(page, "Close 50% of BTC").click();
      await page.waitForTimeout(250);
    }, "closing 50%"),
    desk("desktop-orders-tab", "/?mock=1", async (page) => {
      await page.getByRole("tab", { name: /Open orders/ }).click();
      await page.waitForTimeout(300);
    }, "take profit"),
    desk("desktop-symbol-picker", "/?mock=1", async (page) => {
      await byRole(page, "Pick a market").click();
      await page.waitForTimeout(400);
    }, "NVDA"),
    desk("desktop-nvda-two-tags", "/?mock=1", async (page) => {
      await byRole(page, "Chart NVDA").first().click();
      await page.waitForTimeout(1500);
    }, "MFP"),
    // A drawing: arm the horizontal line and click the chart.
    desk("desktop-drawing-hline", "/?mock=1", async (page) => {
      await byRole(page, "Horizontal line").click();
      await page.waitForTimeout(200);
      await page.mouse.move(500, 500);
      await page.waitForTimeout(100);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(400);
    }, "Delete"),
    // A TP dropped from the tag (draft, dashed), dragged and
    // released (pending, dashed), then confirmed by the venue (solid).
    desk("desktop-tp-draft", "/?mock=1", async (page) => {
      await byRole(page, "Chart NVDA").first().click();
      await page.waitForTimeout(1500);
      await byRole(page, "Take profit for hl:xyz:NVDA").click();
      await page.waitForTimeout(400);
    }, "drag, release to send"),
    desk("desktop-tp-pending", "/?mock=1", async (page) => {
      await byRole(page, "Chart NVDA").first().click();
      await page.waitForTimeout(1500);
      await byRole(page, "Take profit for hl:xyz:NVDA").click();
      await page.waitForTimeout(400);
      const h = page.getByText("drag, release to send").first();
      const b = await h.boundingBox();
      await page.mouse.move(b.x + 10, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + 10, b.y + b.height / 2 + 60, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(200);
    }, "pending"),
    desk("desktop-tp-confirmed", "/?mock=1", async (page) => {
      await byRole(page, "Chart NVDA").first().click();
      await page.waitForTimeout(1500);
      await byRole(page, "Take profit for hl:xyz:NVDA").click();
      await page.waitForTimeout(400);
      const h = page.getByText("drag, release to send").first();
      const b = await h.boundingBox();
      await page.mouse.move(b.x + 10, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + 10, b.y + b.height / 2 + 60, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(2500);
      await page.getByRole("tab", { name: /Open orders/ }).click();
      await page.waitForTimeout(300);
    }, "take profit"),
    desk("desktop-sl-cancel", "/?mock=1", async (page) => {
      await byRole(page, "Cancel sl").click();
      await page.waitForTimeout(250);
    }, "cancelling sl"),
    // An info line (two points) with the magnet, then all drawings hidden.
    desk("desktop-drawing-info", "/?mock=1", async (page) => {
      await byRole(page, "Info line").click();
      await page.waitForTimeout(200);
      await page.mouse.click(420, 520);
      await page.waitForTimeout(150);
      await page.mouse.move(700, 380, { steps: 5 });
      await page.waitForTimeout(150);
      await page.mouse.click(700, 380);
      await page.waitForTimeout(400);
    }, "Delete"),
    desk("desktop-drawings-hidden", "/?mock=1", async (page) => {
      await byRole(page, "Horizontal line").click();
      await page.mouse.click(500, 500);
      await page.waitForTimeout(300);
      await byRole(page, "Hide all drawings").click();
      await page.waitForTimeout(400);
    }, "Hidden"),
    desk("desktop-magnet-off-hray", "/?mock=1", async (page) => {
      await byRole(page, "Strong magnet on").click();
      await byRole(page, "Horizontal ray").click();
      await page.mouse.click(600, 450);
      await page.waitForTimeout(400);
    }, "Magnet"),
    // Phone: the trade sheet, positions sheet, one-click.
    phone("phone-trade-sheet", "/?mock=1", async (page) => {
      await byRole(page, "Trade").click();
      await page.waitForTimeout(500);
    }, "Buy / Long"),
    phone("phone-positions-sheet", "/?mock=1", async (page) => {
      await byRole(page, "Positions").click();
      await page.waitForTimeout(500);
    }, "Flat"),
    phone("phone-orders-sheet", "/?mock=1", async (page) => {
      await byRole(page, "Orders").click();
      await page.waitForTimeout(500);
    }, "take profit"),
    phone("phone-one-click", "/?mock=1", async (page) => {
      await byRole(page, "Trade").click();
      await page.waitForTimeout(400);
      await byRole(page, "One-click panel").click();
      await page.waitForTimeout(400);
    }, "Flat"),
    // Phone: a lost answer, the trade sheet closed: the unsettled strip sits
    // over the chart with a 40 px Dismiss.
    phone("phone-order-unsettled", "/?mock=1&scenario=lost", async (page) => {
      await byRole(page, "Trade").click();
      await page.waitForTimeout(400);
      await page.locator("input").first().fill("0.01");
      await byRole(page, "Buy / Long BTC").click();
      await page.waitForTimeout(300);
      await byRole(page, "Send the order").click();
      await page.waitForTimeout(2500);
      await byRole(page, "Close Trade BTC").click();
      await page.waitForTimeout(500);
    }, "not resent; checking the venue"),
    phone("phone-symbol-picker", "/?mock=1", async (page) => {
      await byRole(page, "Pick a market").click();
      await page.waitForTimeout(400);
    }, "NVDA"),
  ];
}
