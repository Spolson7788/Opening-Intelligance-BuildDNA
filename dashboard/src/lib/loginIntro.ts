import logoUrl from "../assets/oi-logo-intro.webp";

// Post-sign-in logo intro. Called only from a successful interactive login, never on reload or
// session restore. Plain DOM + CSS animation: it is appended to <body> outside the React root,
// so the app keeps mounting and loading underneath. A tap/click skips it; reduced motion shows
// the logo still before fading.
//
// iOS Safari notes: the 3D transform lives on a wrapper <div>, not on the <img> (Safari flattens
// preserve-3d on replaced elements), keyframes use explicit "0deg" units, and the spin only starts
// (via the .oi-intro-run class) after the image has decoded and two animation frames have painted.
// Otherwise the animation can run off-screen while the image decodes and React mounts underneath.

export const INTRO_OVERLAY_ID = "oi-login-intro";
export const INTRO_SPIN_MS = 3000;
export const INTRO_STILL_MS = 900;
export const INTRO_FADE_MS = 600;
/** Longest we wait for the logo to decode before starting anyway. */
export const INTRO_START_MAX_MS = 500;

const STYLE_ID = "oi-login-intro-style";
const CSS = `
#${INTRO_OVERLAY_ID}{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:#fff;cursor:pointer;opacity:1;transition:opacity ${INTRO_FADE_MS}ms ease;-webkit-perspective:900px;perspective:900px}
#${INTRO_OVERLAY_ID}.oi-intro-fading{opacity:0}
#${INTRO_OVERLAY_ID} .oi-intro-logo{width:min(60vw,320px);opacity:0;-webkit-transform-style:preserve-3d;transform-style:preserve-3d;-webkit-backface-visibility:visible;backface-visibility:visible;will-change:transform,opacity}
#${INTRO_OVERLAY_ID} .oi-intro-logo img{display:block;width:100%;height:auto}
#${INTRO_OVERLAY_ID} .oi-intro-logo.oi-intro-run{-webkit-animation:oi-intro-spin ${INTRO_SPIN_MS}ms cubic-bezier(.45,.05,.25,1) both;animation:oi-intro-spin ${INTRO_SPIN_MS}ms cubic-bezier(.45,.05,.25,1) both}
#${INTRO_OVERLAY_ID}.oi-intro-still .oi-intro-logo{opacity:1;-webkit-animation:none;animation:none}
@-webkit-keyframes oi-intro-spin{0%{-webkit-transform:rotateY(0deg) rotate(0deg) scale(.6);opacity:0}15%{opacity:1}60%{-webkit-transform:rotateY(540deg) rotate(-20deg) scale(1.05);opacity:1}100%{-webkit-transform:rotateY(720deg) rotate(0deg) scale(1);opacity:1}}
@keyframes oi-intro-spin{0%{transform:rotateY(0deg) rotate(0deg) scale(.6);opacity:0}15%{opacity:1}60%{transform:rotateY(540deg) rotate(-20deg) scale(1.05);opacity:1}100%{transform:rotateY(720deg) rotate(0deg) scale(1);opacity:1}}
@media (prefers-reduced-motion: reduce){#${INTRO_OVERLAY_ID} .oi-intro-logo{opacity:1;-webkit-animation:none;animation:none}#${INTRO_OVERLAY_ID}{transition:opacity ${INTRO_FADE_MS}ms linear}}
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
    logo.appendChild(img);
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