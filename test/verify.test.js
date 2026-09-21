// node test/verify.test.js
const assert = require("assert");
process.env.GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com";
process.env.RESEND_API_KEY = "test";
const handler = require("../api/signup.js");
const { verifyGoogleIdToken, isGoogleDomain } = handler;

const TOKEN = "x".repeat(64);
const future = String(Math.floor(Date.now() / 1000) + 3000);
function fakeFetch(status, body) {
  return async () => ({ ok: status === 200, status, json: async () => body });
}
const good = { aud: process.env.GOOGLE_CLIENT_ID, iss: "https://accounts.google.com", email: "Rusty@Gmail.com", email_verified: "true", exp: future, sub: "1", name: "Rusty" };

(async () => {
  assert.equal(isGoogleDomain("a@gmail.com"), true);
  assert.equal(isGoogleDomain("a@GoogleMail.com"), true);
  assert.equal(isGoogleDomain("a@yahoo.com"), false);
  assert.equal(isGoogleDomain("nonsense"), false);

  const ok = await verifyGoogleIdToken(TOKEN, fakeFetch(200, good));
  assert.deepEqual(ok, { email: "rusty@gmail.com", name: "Rusty", sub: "1", hd: "" });
  assert.equal(await verifyGoogleIdToken(TOKEN, fakeFetch(200, { ...good, aud: "someone-else" })), null, "wrong aud");
  assert.equal(await verifyGoogleIdToken(TOKEN, fakeFetch(200, { ...good, iss: "evil.example" })), null, "wrong iss");
  assert.equal(await verifyGoogleIdToken(TOKEN, fakeFetch(200, { ...good, email_verified: "false" })), null, "unverified email");
  assert.equal(await verifyGoogleIdToken(TOKEN, fakeFetch(200, { ...good, exp: "1" })), null, "expired");
  assert.equal(await verifyGoogleIdToken(TOKEN, fakeFetch(400, { error: "invalid_token" })), null, "google rejected");
  assert.equal(await verifyGoogleIdToken("short", fakeFetch(200, good)), null, "too short");
  assert.equal(await verifyGoogleIdToken(TOKEN, async () => { throw new Error("net"); }), null, "network error");
  const saved = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  assert.equal(await verifyGoogleIdToken(TOKEN, fakeFetch(200, good)), null, "no client id configured");
  process.env.GOOGLE_CLIENT_ID = saved;

  function mockRes() {
    const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } };
    return r;
  }
  let res = mockRes();
  await handler({ method: "POST", headers: {}, body: { platform: "android", idToken: "junk.".repeat(10) } }, res);
  assert.equal(res.code, 400);
  assert.equal(res.body.code, "bad_token");

  res = mockRes();
  await handler({ method: "POST", headers: {}, body: { platform: "android", email: "bad" } }, res);
  assert.equal(res.code, 400);
  assert.match(res.body.error, /valid email/);

  console.log("verify.test.js: all passed");
})().catch((e) => { console.error(e); process.exit(1); });
