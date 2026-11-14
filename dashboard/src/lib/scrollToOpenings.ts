// iPhone Safari often ignores a hash change and scrollIntoView({ behavior: "smooth" }).
// Scroll with the instant path, then again on the next frame so a menu that just
// collapsed does not leave the section below the fold.

export function scrollToOpenings(doc: Document = document): boolean {
  const section = doc.getElementById("openings");
  if (!section || doc.querySelector(".sidebar.is-open")) return false;
  const win = doc.defaultView;
  const align = () => {
    const top = Math.max(0, section.getBoundingClientRect().top + (win?.scrollY ?? doc.documentElement.scrollTop ?? 0));
    section.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
    const root = (doc.scrollingElement ?? doc.documentElement) as HTMLElement;
    root.scrollTop = top;
    if (doc.body) doc.body.scrollTop = top;
    win?.scrollTo?.(0, top);
  };
  align();
  if (typeof (section as HTMLElement).focus === "function") {
    try { (section as HTMLElement).focus({ preventScroll: false }); } catch { /* older Safari */ }
  }
  win?.setTimeout?.(align, 50);
  return true;
}

export function scrollToOpeningsWhenReady(doc: Document = document, frames = 40): Promise<boolean> {
  const win = doc.defaultView;
  return new Promise((resolve) => {
    let left = frames;
    const tick = () => {
      if (scrollToOpenings(doc)) { resolve(true); return; }
      if (--left <= 0) { resolve(false); return; }
      if (win?.requestAnimationFrame) win.requestAnimationFrame(() => tick());
      else win?.setTimeout?.(() => tick(), 16);
    };
    tick();
  });
}

// Clicks the overview's Export CSV control once it is on the page and enabled.
// A disabled control (empty list, or a company tree the role cannot export) is not bypassed.
export function clickOpeningsExport(doc: Document = document, timeoutMs = 2500): Promise<"clicked" | "unavailable"> {
  const win = doc.defaultView ?? window;
  const start = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      const button = doc.querySelector<HTMLButtonElement>("[data-export-openings]");
      if (button && !button.disabled) { button.click(); resolve("clicked"); return; }
      if (Date.now() - start >= timeoutMs) { resolve("unavailable"); return; }
      if (win.requestAnimationFrame) win.requestAnimationFrame(attempt);
      else win.setTimeout(attempt, 16);
    };
    win.queueMicrotask ? win.queueMicrotask(attempt) : attempt();
  });
}
