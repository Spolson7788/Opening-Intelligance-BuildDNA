// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as dashIntro from "../dashboard/src/lib/loginIntro";
import * as fieldIntro from "../field-app/src/lib/loginIntro";

const mm = (reduce: boolean) => (q: string) => ({ matches: reduce && q.includes("reduce"), media: q } as MediaQueryList);
function env(reduce = false) { return { document, window: { matchMedia: mm(reduce), setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) } as any }; }

for (const [name, m] of [["dashboard", dashIntro], ["field-app", fieldIntro]] as const) {
  describe(`${name}: login logo intro`, () => {
    it("uses the longer timing (~3s spin, ~0.6s fade, ~0.9s still)", () => { expect(m.INTRO_SPIN_MS).toBe(3000); expect(m.INTRO_FADE_MS).toBe(600); expect(m.INTRO_STILL_MS).toBe(900); });
    beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = '<div id="root"><p id="app">app</p></div>'; });
    afterEach(() => { vi.useRealTimers(); });
    const overlay = () => document.getElementById(m.INTRO_OVERLAY_ID);

    it("shows once after sign-in, spins, fades, then removes itself without touching the app", () => {
      m.playLoginIntro(env());
      expect(document.querySelectorAll(`#${m.INTRO_OVERLAY_ID}`)).toHaveLength(1);
      expect(overlay()!.dataset.motion).toBe("full");
      expect(overlay()!.querySelector("img")!.getAttribute("src")).toMatch(/oi-logo-intro/);
      expect(document.getElementById("app")).not.toBeNull(); // app keeps rendering underneath
      expect(overlay()!.querySelector(".oi-intro-logo")!.classList.contains("oi-intro-run")).toBe(false); // not before paint
      vi.advanceTimersByTime(m.INTRO_START_MAX_MS + 40); // decode fallback + two frames
      expect(overlay()!.dataset.state).toBe("running");
      expect(overlay()!.querySelector(".oi-intro-logo")!.classList.contains("oi-intro-run")).toBe(true);
      expect(overlay()!.parentElement).toBe(document.body); // outside the React root
      vi.advanceTimersByTime(m.INTRO_SPIN_MS);
      expect(overlay()!.classList.contains("oi-intro-fading")).toBe(true);
      vi.advanceTimersByTime(m.INTRO_FADE_MS);
      expect(overlay()).toBeNull();
      expect(document.getElementById("app")).not.toBeNull();
    });

    it("Safari-safe CSS: 3D animation on a wrapper div, not the img, with explicit deg units", () => {
      m.playLoginIntro(env());
      const css = document.getElementById("oi-login-intro-style")!.textContent!;
      expect(overlay()!.querySelector(".oi-intro-logo > img")).not.toBeNull();
      expect(css).toMatch(/\.oi-intro-logo\{[^}]*transform-style:preserve-3d/);
      expect(css).not.toMatch(/ img\{[^}]*(animation|preserve-3d)/);
      expect(css).not.toMatch(/rotate[XY]?\(0\)/);
      expect(css).toMatch(/@-webkit-keyframes oi-intro-spin/);
    });

    it("starts after img.decode() resolves and two animation frames, then spins the full 3s", async () => {
      (HTMLImageElement.prototype as any).decode = () => Promise.resolve();
      const frames: FrameRequestCallback[] = [];
      const e = env(); e.window.requestAnimationFrame = (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; };
      m.playLoginIntro(e);
      await Promise.resolve(); await Promise.resolve();
      expect(frames).toHaveLength(1); frames.shift()!(0);
      expect(overlay()!.dataset.state).toBe("loading");
      frames.shift()!(16);
      expect(overlay()!.dataset.state).toBe("running");
      vi.advanceTimersByTime(m.INTRO_SPIN_MS - 1);
      expect(overlay()!.classList.contains("oi-intro-fading")).toBe(false);
      vi.advanceTimersByTime(1);
      expect(overlay()!.classList.contains("oi-intro-fading")).toBe(true);
      delete (HTMLImageElement.prototype as any).decode;
    });

    it("a failed decode still starts the intro", async () => {
      (HTMLImageElement.prototype as any).decode = () => Promise.reject(new Error("bad"));
      m.playLoginIntro(env());
      await Promise.resolve(); await Promise.resolve();
      vi.advanceTimersByTime(40);
      expect(overlay()!.dataset.state).toBe("running");
      delete (HTMLImageElement.prototype as any).decode;
    });

    it("a second call replaces rather than stacks overlays", () => {
      m.playLoginIntro(env()); m.playLoginIntro(env());
      expect(document.querySelectorAll(`#${m.INTRO_OVERLAY_ID}`)).toHaveLength(1);
    });

    it("tap/click skips it immediately", () => {
      m.playLoginIntro(env());
      overlay()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(overlay()).toBeNull();
      vi.runAllTimers();
      expect(overlay()).toBeNull();
    });

    it("touch also skips it", () => {
      m.playLoginIntro(env());
      overlay()!.dispatchEvent(new Event("touchstart"));
      expect(overlay()).toBeNull();
    });

    it("respects prefers-reduced-motion: still logo, then fade", () => {
      m.playLoginIntro(env(true));
      expect(overlay()!.dataset.motion).toBe("reduced");
      expect(overlay()!.classList.contains("oi-intro-still")).toBe(true);
      const css = document.getElementById("oi-login-intro-style")!.textContent!;
      expect(css).toMatch(/prefers-reduced-motion: reduce/);
      expect(css).toMatch(/oi-intro-still \.oi-intro-logo\{opacity:1;-webkit-animation:none;animation:none\}/);
      vi.advanceTimersByTime(m.INTRO_START_MAX_MS + 40 + m.INTRO_STILL_MS);
      expect(overlay()!.classList.contains("oi-intro-fading")).toBe(true);
      vi.advanceTimersByTime(m.INTRO_FADE_MS);
      expect(overlay()).toBeNull();
    });
  });
}

describe("not shown on reload / session restore", () => {
  const dash = readFileSync("dashboard/src/lib/AuthContext.tsx", "utf8");
  const field = readFileSync("field-app/src/lib/AuthContext.tsx", "utf8");
  const body = (src: string, start: string, end: string) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));
  it("dashboard plays it only inside login(), not in initial auth, adoptToken or logout", () => {
    expect(dash.match(/playLoginIntro\(\)/g)).toHaveLength(1);
    expect(body(dash, "async function login", "function adoptToken")).toContain("playLoginIntro()");
    expect(body(dash, "function readInitialAuth", "export function AuthProvider")).not.toContain("playLoginIntro");
  });
  it("field app plays it only inside login(), not in the stored-session reconcile or company switch", () => {
    expect(field.match(/playLoginIntro\(\)/g)).toHaveLength(1);
    expect(body(field, "async function login", "async function logout")).toContain("playLoginIntro()");
    expect(body(field, "async function reconcile", "async function login")).not.toContain("playLoginIntro");
    expect(body(field, "async function switchCompany", "return (")).not.toContain("playLoginIntro");
  });
  it("module load alone never shows the overlay (a reload with a stored session)", () => {
    document.body.innerHTML = "";
    expect(document.getElementById(dashIntro.INTRO_OVERLAY_ID)).toBeNull();
  });
});

describe("optimized logo asset", () => {
  it("each app ships a small WebP copy", () => {
    for (const a of ["dashboard", "field-app"]) {
      const buf = readFileSync(`${a}/src/assets/oi-logo-intro.webp`);
      expect(buf.subarray(8, 12).toString()).toBe("WEBP");
      expect(buf.length).toBeLessThan(80_000);
    }
  });
});