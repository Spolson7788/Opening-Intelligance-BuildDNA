import { registerSW } from "virtual:pwa-register";

const UPDATE_CHECK_MS = 60 * 60 * 1000;

// registerType is autoUpdate, so a new service worker activates and the page
// reloads. iOS Safari will not look for that worker until something calls
// registration.update(), including when the installed app is opened again.
export function registerFieldUpdates() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  registerSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      const check = () => { registration.update().catch(() => {}); };
      check();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
      window.setInterval(check, UPDATE_CHECK_MS);
    },
  });
}
