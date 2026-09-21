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
//   GOOGLE_CLIENT_ID      - OAuth web client ID used by the page's "Continue with
//                           Google" button; must equal GOOGLE_CLIENT_ID in index.html.
//                           Without it, idTokens are rejected and only the manual
//                           (typed-email) path works.
// (TESTFLIGHT_URL / ASC_* / PLAY_OPTIN_URL are obsolete: iOS goes to the live
//  App Store listing since 2026-09-02, and Android uses the closed-track link.)

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Domains that are always Google accounts. Anything else *may* still be one
// (Workspace, custom domains, "use my current email" Google accounts).
function isGoogleDomain(email) {
  const m = /@([^@]+)$/.exec(String(email || "").toLowerCase());
  return !!m && (m[1] === "gmail.com" || m[1] === "googlemail.com");
}

// --- Google sign-in verification ------------------------------------------
// The page sends the GIS ID token when the tester used "Continue with Google".
// We confirm it with Google's tokeninfo endpoint (signature + expiry checked
// server-side by Google) and then require: issued for OUR client, issued by
// Google, and the email verified. Returns { email, name, sub, hd } or null.
async function verifyGoogleIdToken(idToken, fetchImpl = fetch) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId || typeof idToken !== "string" || idToken.length < 20 || idToken.length > 4096) return null;
  try {
    const r = await fetchImpl(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken)
    );
    if (!r.ok) return null;
    const p = await r.json();
    if (p.aud !== clientId) return null;
    if (p.iss !== "accounts.google.com" && p.iss !== "https://accounts.google.com") return null;
    if (String(p.email_verified) !== "true") return null;
    if (!p.exp || Number(p.exp) * 1000 < Date.now()) return null;
    if (!p.email || !EMAIL_RE.test(p.email)) return null;
    return { email: String(p.email).toLowerCase(), name: p.name || "", sub: p.sub || "", hd: p.hd || "" };
  } catch (e) {
    console.error("verifyGoogleIdToken failed:", e.message);
    return null;
  }
}
// ---------------------------------------------------------------------------

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

// --- Beta perk: 7-day Organizer trial ------------------------------------
// Tells the RackerTracker Firebase backend about this signup so the account
// gets trialOrganizerUntil (+7 days, clock starts at account creation).
// Non-fatal: a hook failure never blocks the signup emails.
async function registerBetaPerk(email, name, platform, extra) {
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
      body: JSON.stringify(Object.assign({ email, name, platform }, extra || {})),
    });
    if (!res.ok) throw new Error(`hook ${res.status}: ${await res.text()}`);
    return await res.json();
  } catch (e) {
    console.error("registerBetaPerk failed:", e.message);
    return null;
  }
}

const PERK_HTML = `<p style="background:#f4ead2;border-radius:8px;padding:12px 16px">
  🏆 <strong>Beta perk:</strong> your account gets <strong>7 days of free
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

  const { email: rawEmail, name: rawName, platform, source, idToken, ack } = req.body || {};
  const safeSource = esc(String(source || "web").slice(0, 40).replace(/[^\w.-]/g, "")) || "web";
  if (platform !== "android" && platform !== "ios") {
    return res.status(400).json({ error: "Unknown platform." });
  }

  // Google-verified path: the token's email is authoritative — whatever was in
  // the text box is ignored. A token that doesn't check out is an error (not a
  // silent fallback) so the page can drop its "verified" state and ask again.
  let google = null;
  if (idToken) {
    google = await verifyGoogleIdToken(idToken);
    if (!google) {
      return res.status(400).json({
        code: "bad_token",
        error: "Google sign-in didn't check out. Tap Continue with Google again, or type your Google account email.",
      });
    }
  }

  // Normalize before validating: trim, and strip trailing dots — "user@gmail.com."
  // passes EMAIL_RE but Resend rejects it with a 422 (real tester hit this).
  const email = google ? google.email : String(rawEmail || "").trim().replace(/\.+$/, "");
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: "Signup is not configured yet (missing email key)." });
  }

  const name = (rawName || (google && google.name) || "").toString();
  const safeName = esc(name.slice(0, 80));
  const safeEmail = esc(email.slice(0, 200));
  const greeting = safeName ? `Hey ${safeName},` : "Hey there,";

  // How sure are we this is a Google account? Only matters for Android (the
  // Play closed track can't add anything else).
  //   google   - proven via Google sign-in
  //   gmail    - typed, but a gmail.com/googlemail.com address
  //   typed    - typed, non-Google domain, tester ticked the "yes it's my Play
  //              Store account" box (may still bounce from the Group)
  const emailSource = google ? "google" : isGoogleDomain(email) ? "gmail" : "typed";
  const googleVerified = !!google;
  const androidRisky = platform === "android" && emailSource === "typed";

  // Diagnostic: a tester's iPhone auto-detected as Android (QR-scanner in-app
  // browser with a junk UA). Log platform + UA so misdetections are traceable.
  console.log(`signup: platform=${platform} source=${safeSource} emailSource=${emailSource} ack=${!!ack} ua=${String(req.headers["user-agent"] || "").slice(0, 300)}`);

  try {
    // Register the 7-day Organizer perk (non-fatal, runs for both platforms).
    await registerBetaPerk(email, name, platform, { googleVerified, emailSource });

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
            <p><strong>Step 1:</strong> Join the tester group, signed in as
            <code>${safeEmail}</code> (tap &ldquo;Join group&rdquo;):</p>
            <p><a href="${esc(groupUrl)}" style="${btnStyle}">Join the Tester Group</a></p>
            <p><strong>Step 2:</strong> Become a tester and install from Google Play:</p>
            <p><a href="${esc(playUrl)}" style="${btnStyle}">Join the Android Beta</a></p>
            <p style="font-size:13px;color:#666">${
              googleVerified
                ? `You verified <code>${safeEmail}</code> with Google, so as long as that's the
                   account signed into the Play Store on your phone, both links just work.`
                : `Both links must be opened with the Google account your phone's Play Store
                   uses — check Play Store &rarr; your profile picture. If that's not
                   <code>${safeEmail}</code>, just sign up again with the right one.`
            } If step 2 says the test isn't available yet, give it a couple of minutes
            after joining the group and retry.</p>
            ${
              androidRisky
                ? `<p style="background:#fdecea;border:1px solid #f3b4ad;border-radius:8px;padding:10px 14px;font-size:13px;color:#7a1c14">
                   Heads up: <code>${safeEmail}</code> isn't a Gmail address. It only works if it's
                   the login of a <em>Google</em> account. If &ldquo;Join group&rdquo; asks you to
                   create a Google account, that's the tell — reply to this email and we'll sort it out.</p>`
                : ""
            }
            ${PERK_HTML}
          <p>Rack 'em up!<br>— RackerTracker</p>
          </div>`,
      });
      // 2. Heads-up to owner (informational; testers self-join via the Google Group)
      const accountNote =
        emailSource === "google"
          ? "✅ verified via Google sign-in" + (google && google.hd ? ` (Workspace: ${esc(google.hd)})` : "")
          : emailSource === "gmail"
            ? "typed — Gmail domain, almost certainly fine"
            : `⚠ typed — NOT a Google domain; tester ${ack ? "confirmed" : "did not confirm"} it's their Play Store account. May fail to join the Group.`;
      await sendEmail({
        to: process.env.OWNER_EMAIL || "hammondhunterc@gmail.com",
        subject: `[RackerTracker] ${androidRisky ? "⚠ Android tester (unverified email)" : "New Android tester"}: ${safeEmail}`,
        html: `
          <div style="font-family:sans-serif">
            <p><strong>New Android beta signup</strong> (self-serve — no action needed;
            they join the RackerTracker Beta Google Group themselves)</p>
            <p>Email: <code>${safeEmail}</code><br>
            Google account: ${accountNote}<br>
            Name: ${safeName || "(none)"}<br>
            Source: <strong>${safeSource}</strong><br>
            IP: ${esc(ip)}</p>
          </div>`,
      });
      const linkStyle = "color:#d9a441;font-weight:700";
      return res.status(200).json({
        message:
          (googleVerified ? `Verified <b>${safeEmail}</b> &mdash; you're in! Two taps to install:<br>` : "You're in! Two taps to install:<br>") +
          `1. <a href="${esc(groupUrl)}" target="_blank" rel="noopener" style="${linkStyle}">Join the tester group</a>` +
          ` &mdash; tap &ldquo;Join group&rdquo; signed in as <b>${safeEmail}</b>.<br>` +
          `2. <a href="${esc(playUrl)}" target="_blank" rel="noopener" style="${linkStyle}">Become a tester &amp; install</a>` +
          " from Google Play.<br>" +
          "We also emailed you the same links.",
      });
    }

    // iOS. The app is LIVE on the App Store (1.1.0, since 2026-09) — same build
    // TestFlight was serving — so iOS "beta" signups go straight to the store
    // listing. No TestFlight, no ASC invite, no owner action. The signup still
    // earns the 7-day Organizer perk (registerBetaPerk above).
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
        "and register with this email to activate your 7-day free Organizer access. " +
        "We also emailed you the link.",
    });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({
      error: "We hit a snag sending your invite. Please try again shortly.",
    });
  }
};

// exposed for tests
module.exports.verifyGoogleIdToken = verifyGoogleIdToken;
module.exports.isGoogleDomain = isGoogleDomain;
