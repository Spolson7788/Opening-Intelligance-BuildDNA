// Builds a real tracking-page URL for major carriers. No carrier API calls
// (no credentials, no live status polling) — this gets the user to the
// carrier's own tracking page in one click, which covers most of the
// practical value without needing an actual integration.
export function carrierTrackingUrl(carrier: string | null | undefined, trackingNumber: string | null | undefined): string | null {
  if (!trackingNumber) return null;
  const c = (carrier || "").toLowerCase();
  if (c === "ups") return `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}`;
  if (c === "fedex") return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`;
  if (c === "usps") return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`;
  return null; // LTL freight / other carriers don't have a universal tracking URL pattern
}

export const SHIPMENT_STATUS_LABELS: Record<string, string> = {
  not_shipped: "Not shipped",
  ordered: "Ordered",
  shipped: "Shipped",
  in_transit: "In transit",
  delivered: "Delivered",
  installed: "Installed",
  other: "Other",
};
