import logoUrl from "../assets/oi-logo-intro.webp";

// Post-sign-in logo intro. Called only from a successful interactive login, never on reload or
// session restore. Plain DOM + CSS animation: it is appended to <body> outside the React root,
// so the app keeps mounting and loading underneath. A tap/click skips it; reduced motion shows
// the logo still before fading.

export const INTRO_OVERLAY_ID = "oi-login-intro";
export const INTRO_SPIN_MS = 1700;
export const INTRO_STILL_MS = 900;
export const INTRO_FADE_MS = 400;

const STYLE_ID = "oi-login-intro-style";
const CSS = `
#${INTRO_OVERLAY_ID}{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:#fff;perspective:900px;cursor:pointer;opacity:1;transition:opacity ${INTRO_FADE_MS}ms ease}
#${INTRO_OVERLAY_ID}.oi-intro-fading{opacity:0}
#${INTRO_OVERLAY_ID} img{width:min(60vw,320px);height:auto;transform-style:preserve-3d;animation:oi-intro-spin ${INTRO_SPIN_MS}ms cubic-bezier(.45,.05,.25,1) both}
#${INTRO_OVERLAY_ID}.oi-intro-still img{animation:none}
@keyframes oi-intro-spin{0%{transform:rotateY(0) rotate(0) scale(.6);opacity:0}15%{opacity:1}60%{transform:rotateY(540deg) rotate(-20deg) scale(1.05)}100%{transform:rotateY(720deg) rotate(0) scale(1)}}
@media (prefers-reduced-motion: reduce){#${INTRO_OVERLAY_ID} img{animation:none}#${INTRO_OVERLAY_ID}{transition:opacity ${INTRO_FADE_MS}ms linear}}
`;

export interface IntroEnv { document: Document; window: Pick<Window, "matchMedia" | "setTimeout" | "clearTimeout"> }

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
    if (reduced) overlay.classList.add("oi-intro-still");
    const img = doc.createElement("img");
    img.src = logoUrl; img.alt = ""; img.decoding = "async";
    overlay.appendChild(img);

    let done = false; const timers: number[] = [];
    const remove = () => { overlay.remove(); };
    const fade = () => {
      if (done) return; done = true;
      timers.forEach(t => win.clearTimeout(t));
      overlay.classList.add("oi-intro-fading");
      timers.push(win.setTimeout(remove, INTRO_FADE_MS) as unknown as number);
    };
    const skip = () => { if (done) { remove(); return; } done = true; timers.forEach(t => win.clearTimeout(t)); remove(); };
    overlay.addEventListener("click", skip);
    overlay.addEventListener("touchstart", skip, { passive: true });
    timers.push(win.setTimeout(fade, reduced ? INTRO_STILL_MS : INTRO_SPIN_MS) as unknown as number);
    doc.body.appendChild(overlay);
    return skip;
  } catch { return () => {}; }
}