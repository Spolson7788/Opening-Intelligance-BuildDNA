export function scrollPageToTop() {
  const scrolling = document.scrollingElement;
  if (scrolling) scrolling.scrollTop = 0;
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  try { window.scrollTo(0, 0); } catch { /* Some test browsers do not implement scrollTo. */ }
}
