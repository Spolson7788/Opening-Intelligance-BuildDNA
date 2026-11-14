export function formatMoney(minor, currency = "USD", digits = 2) {
  if (minor === null || minor === undefined || minor === "") return "Unknown";
  const amount = Number(minor);
  const places = Number.isInteger(Number(digits)) ? Number(digits) : 2;
  if (!Number.isFinite(amount)) return "Unknown";
  const major = amount / 10 ** places;
  const code = /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency: code, minimumFractionDigits: places, maximumFractionDigits: places,
    }).format(major);
  } catch {
    return major.toFixed(places);
  }
}

export function kindLabel(kind) {
  const labels = {
    cut_sheet: "Cut sheet", technical: "Technical", installation: "Installation instructions",
    warranty: "Warranty", estimate: "Estimate", invoice: "Invoice", credit: "Credit",
    payment: "Payment", payment_evidence: "Payment evidence",
  };
  return labels[kind] || String(kind || "").replaceAll("_", " ");
}

export function note(el, message, isError = false) {
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-error", isError);
}
