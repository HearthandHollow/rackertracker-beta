// RackerTracker beta signup endpoint (Vercel serverless function)
//
// Required env vars (set in Vercel dashboard -> Project -> Settings -> Environment Variables):
//   RESEND_API_KEY        - API key from resend.com
//   OWNER_EMAIL           - where signup notifications go (Hunter)
// Optional:
//   GROUP_JOIN_URL        - Android tester Google Group join page (has a default)
//   CLOSED_OPTIN_URL      - Play closed-testing opt-in link (has a default)
//   APP_STORE_URL         - live App Store listing for iOS (has a default)
//   FROM_EMAIL            - defaults to "RackerTracker Beta <onboarding@resend.dev>"
// (TESTFLIGHT_URL / ASC_* / PLAY_OPTIN_URL are obsolete: iOS goes to the live
//  App Store listing since 2026-09-02, and Android uses the closed-track link.)

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

  const { email: rawEmail, name, platform, source } = req.body || {};
  const safeSource = esc(String(source || "web").slice(0, 40).replace(/[^\w.-]/g, "")) || "web";
  // Normalize before validating: trim, and strip trailing dots — "user@gmail.com."
  // passes EMAIL_RE but Resend rejects it with a 422 (real tester hit this).
  const email = String(rawEmail || "").trim().replace(/\.+$/, "");
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

  // Diagnostic: a tester's iPhone auto-detected as Android (QR-scanner in-app
  // browser with a junk UA). Log platform + UA so misdetections are traceable.
  console.log(`signup: platform=${platform} source=${safeSource} ua=${String(req.headers["user-agent"] || "").slice(0, 300)}`);

  try {
    // Register the 90-day Organizer perk (non-fatal, runs for both platforms).
    await registerBetaPerk(email, name, platform);

    if (platform === "android") {
      // Self-serve flow: the Play closed-testing track's testers are the
      // "RackerTracker Beta" Google Group (anyone can join), so the tester adds
      // themselves — no manual Play Console step, no waiting on us.
      const groupUrl = process.env.GROUP_JOIN_URL || "https://groups.google.com/g/rackertracker-beta";
      // NOT process.env.PLAY_OPTIN_URL — that env var holds the *internal* track
      // link (apps/internaltest/...), but the Google Group gates the *closed*
      // track, whose opt-in URL is the app-level testing link below.
      const playUrl = process.env.CLOSED_OPTIN_URL || "https://play.google.com/apps/testing/com.racktrack.pool";
      const btnStyle = "background:#0b5d3b;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;display:inline-block";
      // 1. Confirmation to the tester
      await sendEmail({
        to: email,
        subject: "You're in — RackerTracker Android beta 🎱",
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:auto">
            <h2 style="color:#0b5d3b">Welcome to the RackerTracker beta!</h2>
            <p>${greeting}</p>
            <p>Two taps on your Android phone and you're in — no waiting:</p>
            <p><strong>Step 1:</strong> Join the tester group with the Google account
            signed in on your phone (tap &ldquo;Join group&rdquo;):</p>
            <p><a href="${esc(groupUrl)}" style="${btnStyle}">Join the Tester Group</a></p>
            <p><strong>Step 2:</strong> Become a tester and install from Google Play:</p>
            <p><a href="${esc(playUrl)}" style="${btnStyle}">Join the Android Beta</a></p>
            <p style="font-size:13px;color:#666">Both links must be opened with the same
            Google account your phone's Play Store uses. If step 2 says the test isn't
            available yet, give it a couple of minutes after joining the group and retry.</p>
            ${PERK_HTML}
          <p>Rack 'em up!<br>— RackerTracker</p>
          </div>`,
      });
      // 2. Heads-up to owner (informational; testers self-join via the Google Group)
      await sendEmail({
        to: process.env.OWNER_EMAIL || "hammondhunterc@gmail.com",
        subject: `[RackerTracker] New Android tester: ${safeEmail}`,
        html: `
          <div style="font-family:sans-serif">
            <p><strong>New Android beta signup</strong> (self-serve — no action needed;
            they join the RackerTracker Beta Google Group themselves)</p>
            <p>Email: <code>${safeEmail}</code><br>
            Name: ${safeName || "(none)"}<br>
            Source: <strong>${safeSource}</strong><br>
            IP: ${esc(ip)}</p>
          </div>`,
      });
      const linkStyle = "color:#d9a441;font-weight:700";
      return res.status(200).json({
        message:
          "You're in! Two taps to install:<br>" +
          `1. <a href="${esc(groupUrl)}" target="_blank" rel="noopener" style="${linkStyle}">Join the tester group</a>` +
          " &mdash; tap &ldquo;Join group&rdquo; with the Google account signed in on this phone.<br>" +
          `2. <a href="${esc(playUrl)}" target="_blank" rel="noopener" style="${linkStyle}">Become a tester &amp; install</a>` +
          " from Google Play.<br>" +
          "We also emailed you the same links.",
      });
    }

    // iOS. The app is LIVE on the App Store (1.1.0, since 2026-09) — same build
    // TestFlight was serving — so iOS "beta" signups go straight to the store
    // listing. No TestFlight, no ASC invite, no owner action. The signup still
    // earns the 90-day Organizer perk (registerBetaPerk above).
    const storeUrl = process.env.APP_STORE_URL || "https://apps.apple.com/us/app/id6785885046";
    const storeBtn = `<a href="${esc(storeUrl)}" style="background:#0b5d3b;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;display:inline-block">Get RackerTracker on the App Store</a>`;
    await sendEmail({
      to: email,
      subject: "You're in — RackerTracker is live on the App Store 🎱",
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:auto">
          <h2 style="color:#0b5d3b">Welcome to the RackerTracker beta!</h2>
          <p>${greeting}</p>
          <p>Good news — RackerTracker is <strong>live on the App Store</strong>, so
          there's no TestFlight hoop to jump through. Just install it like any
          other app:</p>
          <p>${storeBtn}</p>
          ${PERK_HTML}
          <p>Rack 'em up!<br>— RackerTracker</p>
        </div>`,
    });
    // Owner heads-up (informational; nothing to do for iOS).
    await sendEmail({
      to: process.env.OWNER_EMAIL || "hammondhunterc@gmail.com",
      subject: `[RackerTracker] New iOS tester: ${safeEmail}`,
      html: `<div style="font-family:sans-serif"><p><strong>New iOS beta signup</strong> — pointed to the live App Store listing; no action needed.</p><p>Email: <code>${safeEmail}</code><br>Name: ${safeName || "(none)"}<br>Source: <strong>${safeSource}</strong><br>IP: ${esc(ip)}</p></div>`,
    });

    const linkStyleIos = "color:#d9a441;font-weight:700";
    return res.status(200).json({
      message:
        "You're in! RackerTracker is live on the App Store &mdash; no TestFlight needed. " +
        `<a href="${esc(storeUrl)}" target="_blank" rel="noopener" style="${linkStyleIos}">Download it here</a> ` +
        "and register with this email to activate your 90-day free Organizer access. " +
        "We also emailed you the link.",
    });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({
      error: "We hit a snag sending your invite. Please try again shortly.",
    });
  }
};
