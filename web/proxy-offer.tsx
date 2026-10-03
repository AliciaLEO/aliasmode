import { useTranslation } from "./i18n.tsx";

const PROXY_PROVIDER_URL = "https://nobleproxy.com/t/aliasmode";

export function ProxyProviderOffer({ replacement = false }: { replacement?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="proxy-referral">
      <strong>{replacement
        ? t("Need another proxy? View recommended replacements.")
        : t("Need a proxy? Get one from our recommended provider.")}</strong>
      <a
        href={PROXY_PROVIDER_URL}
        target="_blank"
        rel="noreferrer"
        aria-label={t("View recommended proxies at NobleProxy (opens externally)")}
      >
        {replacement ? t("View replacements") : t("View provider")} <span aria-hidden="true">↗</span>
      </a>
    </div>
  );
}
