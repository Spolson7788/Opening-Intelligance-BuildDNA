import { renewPrivateSiteAccess, siteAccessRenewalUrl } from "../lib/siteAccess";

export function RenewPrivateSiteAccess({ className, children }: { className?: string; children: string }) {
  const url = typeof window === "undefined" ? null : siteAccessRenewalUrl(window.location.origin);
  if (!url) return null;
  return (
    <a
      className={className}
      href={url}
      onClick={(event) => {
        event.preventDefault();
        renewPrivateSiteAccess(window.location, window.sessionStorage);
      }}
    >
      {children}
    </a>
  );
}
