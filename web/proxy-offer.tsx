const PROXY_PROVIDER_URL = "https://nobleproxy.com/t/aliasmode";

export function ProxyProviderOffer({ replacement = false }: { replacement?: boolean }) {
  return (
    <div className="proxy-referral">
      <strong>{replacement
        ? "Need another proxy? View recommended replacements."
        : "Need a proxy? Get one from our recommended provider."}</strong>
      <a
        href={PROXY_PROVIDER_URL}
        target="_blank"
        rel="noreferrer"
        aria-label="View recommended proxies at NobleProxy (opens externally)"
      >
        {replacement ? "View replacements" : "View provider"} <span aria-hidden="true">↗</span>
      </a>
    </div>
  );
}
