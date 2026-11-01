import logoUrl from "../assets/oi-logo-intro.webp";

// Post-sign-in logo intro. Called only from a successful interactive login, never on reload or
// session restore. Plain DOM + CSS animation: it is appended to <body> outside the React root,
// so the app keeps mounting and loading underneath. A tap/click skips it; reduced motion shows
// the logo still before fading.
//
// iOS Safari notes: motion is a 2D rotate() on a wrapper <div> (not the <img>), keyframes use explicit
// deg units and 90deg steps, the 3D twist is optional decoration, and the spin only starts
// (via the .oi-intro-run class) after the image has decoded and two animation frames have painted.
// Otherwise the animation can run off-screen while the image decodes and React mounts underneath.

export const INTRO_OVERLAY_ID = "oi-login-intro";
export const INTRO_SPIN_MS = 3000;
export const INTRO_STILL_MS = 900;
export const INTRO_FADE_MS = 600;
/** Longest we wait for the logo to decode before starting anyway. */
export const INTRO_START_MAX_MS = 500;

const STYLE_ID = "oi-login-intro-style";
// Main motion is a plain 2D rotate() on .oi-intro-logo, with a keyframe every 90deg so that even a
// matrix-interpolating compositor (iOS Core Animation) cannot collapse 0deg -> 720deg into "no turn".
// The 3D twist is an extra on an inner .oi-intro-twist (small +/-35deg rotateY via perspective()),
// so if iOS flattens it the logo still visibly spins.
const SPIN_STEPS = [0, 90, 180, 270, 360, 450, 540, 630, 720];
const spinFrames = SPIN_STEPS.map((deg, i) => {
  const pct = Math.round((i / (SPIN_STEPS.length - 1)) * 100);
  const scale = (0.6 + 0.4 * Math.min(1, i / 4)).toFixed(2);
  return `${pct}%{transform:rotate(${deg}deg) scale(${scale})${i === 0 ? ";opacity:0" : i === 1 ? ";opacity:1" : ""}}`;
}).join("");
const twistFrames = "0%{transform:perspective(600px) rotateY(0deg)}25%{transform:perspective(600px) rotateY(35deg)}50%{transform:perspective(600px) rotateY(0deg)}75%{transform:perspective(600px) rotateY(-35deg)}100%{transform:perspective(600px) rotateY(0deg)}";
const EASE = "cubic-bezier(.45,.05,.25,1)";
const CSS = `
#${INTRO_OVERLAY_ID}{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:#fff;cursor:pointer;opacity:1;transition:opacity ${INTRO_FADE_MS}ms ease}
#${INTRO_OVERLAY_ID}.oi-intro-fading{opacity:0}
#${INTRO_OVERLAY_ID} .oi-intro-logo{width:min(60vw,320px);opacity:0}
#${INTRO_OVERLAY_ID} .oi-intro-twist{display:block}
#${INTRO_OVERLAY_ID} .oi-intro-logo img{display:block;width:100%;height:auto}
#${INTRO_OVERLAY_ID} .oi-intro-logo.oi-intro-run{-webkit-animation:oi-intro-spin ${INTRO_SPIN_MS}ms ${EASE} both;animation:oi-intro-spin ${INTRO_SPIN_MS}ms ${EASE} both}
#${INTRO_OVERLAY_ID} .oi-intro-run .oi-intro-twist{-webkit-animation:oi-intro-twist ${INTRO_SPIN_MS}ms ease-in-out both;animation:oi-intro-twist ${INTRO_SPIN_MS}ms ease-in-out both}
#${INTRO_OVERLAY_ID}.oi-intro-still .oi-intro-logo,#${INTRO_OVERLAY_ID}.oi-intro-still .oi-intro-twist{opacity:1;-webkit-animation:none;animation:none}
@-webkit-keyframes oi-intro-spin{${spinFrames.replace(/transform:/g, "-webkit-transform:")}}
@keyframes oi-intro-spin{${spinFrames}}
@-webkit-keyframes oi-intro-twist{${twistFrames.replace(/transform:/g, "-webkit-transform:")}}
@keyframes oi-intro-twist{${twistFrames}}
@media (prefers-reduced-motion: reduce){#${INTRO_OVERLAY_ID} .oi-intro-logo,#${INTRO_OVERLAY_ID} .oi-intro-twist{opacity:1;-webkit-animation:none;animation:none}#${INTRO_OVERLAY_ID}{transition:opacity ${INTRO_FADE_MS}ms linear}}
`;
export interface IntroEnv {
  document: Document;
  window: Pick<Window, "matchMedia" | "setTimeout" | "clearTimeout"> & Partial<Pick<Window, "requestAnimationFrame">>;
}

export function prefersReducedMotion(win: IntroEnv["window"]): boolean {
  try { return !!win.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/** Shows the intro once. Returns a skip function. Never throws: the intro is decoration only. */
export function playLoginIntro(env?: Partial<IntroEnv>): () => void {
  const doc = env?.document ?? (typeof document !== "undefined" ? document : undefined);
  const win = env?.window ?? (typeof window !== "undefined" ? window : undefined);
  if (!doc || !win || !doc.body) return () => {};
  try {
    doc.getElementById(INTRO_OVERLAY_ID)?.remove();
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = STYLE_ID; style.textContent = CSS; doc.head.appendChild(style);
    }
    const reduced = prefersReducedMotion(win);
    const overlay = doc.createElement("div");
    overlay.id = INTRO_OVERLAY_ID;
    overlay.setAttribute("role", "presentation");
    overlay.setAttribute("aria-hidden", "true");
    overlay.dataset.motion = reduced ? "reduced" : "full";
    overlay.dataset.state = "loading";
    if (reduced) overlay.classList.add("oi-intro-still");
    const logo = doc.createElement("div");
    logo.className = "oi-intro-logo";
    const img = doc.createElement("img");
    img.alt = ""; img.decoding = "sync"; img.src = logoUrl;
    const twist = doc.createElement("div");
    twist.className = "oi-intro-twist";
    twist.appendChild(img);
    logo.appendChild(twist);
    overlay.appendChild(logo);

    let done = false; let started = false; const timers: number[] = [];
    const clearAll = () => timers.forEach(t => win.clearTimeout(t));
    const remove = () => { overlay.remove(); };
    const fade = () => {
      if (done) return; done = true;
      clearAll();
      overlay.classList.add("oi-intro-fading");
      timers.push(win.setTimeout(remove, INTRO_FADE_MS) as unknown as number);
    };
    const skip = () => { if (done) { remove(); return; } done = true; clearAll(); remove(); };
    const frame = (cb: () => void) => {
      const raf = win.requestAnimationFrame;
      if (typeof raf === "function") raf.call(win, () => cb());
      else timers.push(win.setTimeout(cb, 16) as unknown as number);
    };
    // Start once, after the image is ready and two frames have painted the overlay.
    const begin = () => {
      if (started || done) return; started = true;
      frame(() => frame(() => {
        if (done) return;
        void logo.offsetWidth; // force style/layout so Safari registers the start state
        logo.classList.add("oi-intro-run");
        overlay.dataset.state = "running";
        timers.push(win.setTimeout(fade, reduced ? INTRO_STILL_MS : INTRO_SPIN_MS) as unknown as number);
      }));
    };
    timers.push(win.setTimeout(begin, INTRO_START_MAX_MS) as unknown as number); // decode never settles
    overlay.addEventListener("click", skip);
    overlay.addEventListener("touchstart", skip, { passive: true });
    doc.body.appendChild(overlay);
    if (typeof img.decode === "function") {
      img.decode().then(begin, begin);
    } else if (img.complete && img.naturalWidth > 0) {
      begin();
    } else {
      img.addEventListener("load", begin, { once: true });
      img.addEventListener("error", begin, { once: true });
    }
    return skip;
  } catch { return () => {}; }
}