// RackerTracker beta signup endpoint (Vercel serverless function)
//
// Required env vars (set in Vercel dashboard -> Project -> Settings -> Environment Variables):
//   RESEND_API_KEY        - API key from resend.com
//   OWNER_EMAIL           - where Android signup notifications go (Hunter)
//   PLAY_OPTIN_URL        - Google Play internal testing opt-in link
//                           (Play Console -> Testing -> Internal testing -> "Copy link")
//   TESTFLIGHT_URL        - TestFlight public link (App Store Connect -> TestFlight ->
//                           your external group -> enable Public Link), OR leave unset
//                           if using ASC auto-invite below.
// Optional (auto-invite iOS testers via App Store Connect API instead of a public link):
//   ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY (contents of the .p8), ASC_BETA_GROUP_ID
//   FROM_EMAIL            - defaults to "RackerTracker Beta <onboarding@resend.dev>"

const crypto = require("crypto");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// naive in-memory rate limit (per warm lambda) — good enough for a beta page
const recent = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter((t) => now - t < 60_000);
  hits.push(now);
  recent.set(ip, hits);
  return hits.length > 5;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function sendEmail({ to, subject, html }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL || "RackerTracker Beta <onboarding@resend.dev>",
      to: [to],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body}`);
  }
}

// --- Optional: App Store Connect auto-invite -------------------------------
function ascConfigured() {
  return (
    process.env.ASC_KEY_ID &&
    process.env.ASC_ISSUER_ID &&
    process.env.ASC_PRIVATE_KEY &&
    process.env.ASC_BETA_GROUP_ID
  );
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function ascToken() {
  const header = { alg: "ES256", kid: process.env.ASC_KEY_ID, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: process.env.ASC_ISSUER_ID,
    iat: now,
    exp: now + 10 * 60,
    aud: "appstoreconnect-v1",
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = crypto.createPrivateKey(process.env.ASC_PRIVATE_KEY.replace(/\\n/g, "\n"));
  const signature = crypto
    .sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

async function ascInvite(email, firstName) {
  const res = await fetch("https://api.appstoreconnect.apple.com/v1/betaTesters", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ascToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        type: "betaTesters",
        attributes: { email, firstName: firstName || undefined },
        relationships: {
          betaGroups: {
            data: [{ type: "betaGroups", id: process.env.ASC_BETA_GROUP_ID }],
          },
        },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // 409 usually means the tester already exists — treat as success
    if (res.status === 409) return "already";
    throw new Error(`ASC ${res.status}: ${body}`);
  }
  return "invited";
}
// ---------------------------------------------------------------------------

// --- Beta perk: 90-day Organizer trial ------------------------------------
// Tells the RackerTracker Firebase backend about this signup so the account
// gets trialOrganizerUntil (+90 days, clock starts at account creation).
// Non-fatal: a hook failure never blocks the signup emails.
async function registerBetaPerk(email, name, platform) {
  const url = process.env.BETA_HOOK_URL;
  const secret = process.env.BETA_HOOK_SECRET;
  if (!url || !secret) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-beta-hook-secret": secret,
      },
      body: JSON.stringify({ email, name, platform }),
    });
    if (!res.ok) throw new Error(`hook ${res.status}: ${await res.text()}`);
    return await res.json();
  } catch (e) {
    console.error("registerBetaPerk failed:", e.message);
    return null;
  }
}

const PERK_HTML = `<p style="background:#f4ead2;border-radius:8px;padding:12px 16px">
  🏆 <strong>Beta perk:</strong> your account gets <strong>90 days of free
  Organizer access</strong> — create and run your own tournaments. It activates
  automatically when you register in the app with this email address.</p>`;
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "Easy there, shark — try again in a minute." });
  }

  const { email, name, platform } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }
  if (platform !== "android" && platform !== "ios") {
    return res.status(400).json({ error: "Unknown platform." });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: "Signup is not configured yet (missing email key)." });
  }

  const safeName = esc((name || "").slice(0, 80));
  const safeEmail = esc(email.slice(0, 200));
  const greeting = safeName ? `Hey ${safeName},` : "Hey there,";

  try {
    // Register the 90-day Organizer perk (non-fatal, runs for both platforms).
    await registerBetaPerk(email, name, platform);

    if (platform === "android") {
      const playUrl = process.env.PLAY_OPTIN_URL;
      // 1. Confirmation to the tester
      await sendEmail({
        to: email,
        subject: "You're in — RackerTracker Android beta 🎱",
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:auto">
            <h2 style="color:#0b5d3b">Welcome to the RackerTracker beta!</h2>
            <p>${greeting}</p>
            <p>You've been added to the queue for the <strong>Android internal test</strong>.
            Your email is being added to the tester list now (this is a quick manual step
            on our end, usually done within a few hours).</p>
            <p><strong>Once you're on the list</strong>, tap this link on your Android phone
            (signed in with this Google account) to opt in and install:</p>
            ${playUrl ? `<p><a href="${esc(playUrl)}" style="background:#0b5d3b;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;display:inline-block">Join the Android Beta</a></p>` : "<p>(Install link will follow in a second email.)</p>"}
            <p style="font-size:13px;color:#666">If the link says the test isn't available yet,
            give it a few hours and try again — your email may still be propagating.</p>
            ${PERK_HTML}
          <p>Rack 'em up!<br>— RackerTracker</p>
          </div>`,
      });
      // 2. Notify owner to add the tester in Play Console
      await sendEmail({
        to: process.env.OWNER_EMAIL || "hammondhunterc@gmail.com",
        subject: `[RackerTracker] New Android tester: ${safeEmail}`,
        html: `
          <div style="font-family:sans-serif">
            <p><strong>New Android beta signup</strong></p>
            <p>Email: <code>${safeEmail}</code><br>
            Name: ${safeName || "(none)"}<br>
            IP: ${esc(ip)}</p>
            <p>Action: add this email to the internal testing list in
            <a href="https://play.google.com/console">Play Console</a> →
            Testing → Internal testing → Testers.</p>
          </div>`,
      });
      return res.status(200).json({
        message:
          "You're on the list! Check your inbox — we've sent your install link. " +
          "Your email gets added to the Google Play tester list shortly, so if the " +
          "link doesn't work immediately, try again in a few hours.",
      });
    }

    // iOS
    let inviteMode = "link";
    if (ascConfigured()) {
      try {
        await ascInvite(email, name);
        inviteMode = "asc";
      } catch (e) {
        console.error("ASC invite failed, falling back to public link:", e.message);
      }
    }

    const tfUrl = process.env.TESTFLIGHT_URL;
    await sendEmail({
      to: email,
      subject: "You're in — RackerTracker iOS beta 🎱",
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:auto">
          <h2 style="color:#0b5d3b">Welcome to the RackerTracker beta!</h2>
          <p>${greeting}</p>
          <p>You're set up to test RackerTracker on your iPhone/iPad via
          <strong>TestFlight</strong> (Apple's free beta-testing app).</p>
          <ol>
            <li>Install <a href="https://apps.apple.com/app/testflight/id899247664">TestFlight</a> from the App Store.</li>
            ${
              inviteMode === "asc"
                ? "<li>Watch for an official TestFlight invite email from Apple (arriving separately) and tap <strong>View in TestFlight</strong>.</li>"
                : tfUrl
                  ? `<li>Tap this link on your device: <a href="${esc(tfUrl)}" style="background:#0b5d3b;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Join the iOS Beta</a></li>`
                  : "<li>(Install link will follow in a second email.)</li>"
            }
            <li>Install RackerTracker and start potting balls.</li>
          </ol>
          ${PERK_HTML}
          <p>Rack 'em up!<br>— RackerTracker</p>
        </div>`,
    });
    // heads-up to owner (informational; no action needed for iOS)
    await sendEmail({
      to: process.env.OWNER_EMAIL || "hammondhunterc@gmail.com",
      subject: `[RackerTracker] New iOS tester: ${safeEmail}`,
      html: `<div style="font-family:sans-serif"><p><strong>New iOS beta signup</strong> (${inviteMode === "asc" ? "auto-invited via App Store Connect" : "sent TestFlight link"})</p><p>Email: <code>${safeEmail}</code><br>Name: ${safeName || "(none)"}<br>IP: ${esc(ip)}</p></div>`,
    });

    return res.status(200).json({
      message:
        inviteMode === "asc"
          ? "You're in! Check your inbox — instructions are on the way, and Apple will send your official TestFlight invite separately."
          : "You're in! Check your inbox for your TestFlight install link.",
    });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({
      error: "We hit a snag sending your invite. Please try again shortly.",
    });
  }
};
