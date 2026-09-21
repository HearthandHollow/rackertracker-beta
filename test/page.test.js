// node test/page.test.js  — drives index.html in headless Chromium with phone UAs.
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { chromium } = require("playwright");

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const posts = [];
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/signup")) {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      posts.push(JSON.parse(b));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: "ok <b>test</b>" }));
    });
    return;
  }
  res.setHeader("Content-Type", "text/html"); res.end(HTML);
});

const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const ANDROID_FB = "Mozilla/5.0 (Linux; Android 14; SM-S928U Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.40.108;]";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

(async () => {
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const exe = process.env.CHROMIUM_PATH || undefined;
  const browser = await chromium.launch(exe ? { executablePath: exe, headless: true } : { headless: true });
  const shots = path.join(__dirname, "shots"); fs.mkdirSync(shots, { recursive: true });

  async function open(ua) {
    const ctx = await browser.newContext({ userAgent: ua, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    await ctx.route("https://accounts.google.com/**", (r) => r.abort());
    const page = await ctx.newPage();
    await page.goto(url);
    return { ctx, page };
  }
  const vis = (page, sel) => page.locator(sel).isVisible();

  {
    const { ctx, page } = await open(ANDROID_CHROME);
    assert.equal(await vis(page, "#gbox"), true, "gbox visible on Android");
    assert.equal(await vis(page, "#webviewNote"), false, "no webview note in Chrome");
    assert.match(await page.locator("#emailHint").innerText(), /Play Store/);
    await page.fill("#email", "rusty@hotmail.com");
    await page.click("#submitBtn");
    assert.equal(await vis(page, "#gaWarn"), true, "warning shown for hotmail");
    assert.equal(posts.length, 0, "no POST before acknowledgement");
    await page.screenshot({ path: path.join(shots, "android-warn.png"), fullPage: true });
    await page.check("#gaAck");
    await page.click("#submitBtn");
    await page.waitForSelector("#result.ok");
    assert.deepEqual(posts[0], { email: "rusty@hotmail.com", name: "", platform: "android", source: "web", ack: true });
    await page.waitForTimeout(5200);
    assert.equal(await vis(page, "#gsiWrap"), false, "GIS wrap hidden when script blocked");
    await ctx.close();
  }
  {
    const { ctx, page } = await open(ANDROID_CHROME);
    await page.fill("#email", "amy@gmail.com");
    await page.fill("#pname", "Amy");
    await page.click("#submitBtn");
    await page.waitForSelector("#result.ok");
    assert.equal(await vis(page, "#gaWarn"), false);
    assert.deepEqual(posts[1], { email: "amy@gmail.com", name: "Amy", platform: "android", source: "web", ack: false });
    await ctx.close();
  }
  {
    const { ctx, page } = await open(ANDROID_FB);
    assert.equal(await vis(page, "#webviewNote"), true, "webview note for FB");
    assert.match(await page.locator("#webviewNote").innerText(), /Facebook browser/);
    assert.equal(await vis(page, "#gsiWrap"), false, "GIS hidden in webview");
    assert.equal(await vis(page, "#gDivider"), false);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(IPHONE);
    assert.equal(await vis(page, "#gbox"), false, "gbox hidden on iOS");
    await page.click('button[data-platform="android"]');
    assert.equal(await vis(page, "#gbox"), true);
    await page.click('button[data-platform="ios"]');
    assert.equal(await vis(page, "#gbox"), false);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(ANDROID_CHROME);
    const payload = Buffer.from(JSON.stringify({ email: "david@gmail.com", name: "David P" })).toString("base64url");
    const fake = `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
    await page.evaluate((t) => onGoogleCredential({ credential: t }), fake);
    await page.waitForSelector("#result.ok");
    assert.equal(await vis(page, "#verifiedBox"), true);
    assert.equal(await page.locator("#verifiedEmail").innerText(), "david@gmail.com");
    assert.equal(await page.locator("#email").getAttribute("readonly"), "");
    const last = posts[posts.length - 1];
    assert.equal(last.idToken, fake);
    assert.equal(last.email, "david@gmail.com");
    assert.equal("ack" in last, false, "no ack when token present");
    await ctx.close();
  }

  await browser.close(); server.close();
  console.log("page.test.js: all passed");
})().catch((e) => { console.error(e); process.exit(1); });
