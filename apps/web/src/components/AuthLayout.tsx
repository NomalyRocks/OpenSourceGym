import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";
import { dateLocale } from "../i18n/format";

export function AuthLayout({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const todayLabel = new Date()
    .toLocaleDateString(dateLocale(i18n.resolvedLanguage), {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    })
    .toLocaleUpperCase(dateLocale(i18n.resolvedLanguage));

  return (
    <div className="auth-wrap">
      <div className="auth-frame">
        <div className="auth-grid-bg" aria-hidden="true" />

        <div className="auth-masthead">
          <div className="auth-masthead-top">
            <span>OPENGYM/OPS</span>
            <span>{todayLabel}</span>
          </div>
          <div>
            <div className="auth-masthead-eyebrow">
              {t("FACILITY MANAGEMENT SYSTEM")}
            </div>
            <div className="auth-masthead-title">
              {t("SET.")}
              <br />
              {t("REP.")}
              <br />
              {t("RUN.")}
            </div>
          </div>
          <div />
        </div>

        <div className="auth-card-wrap">
          <div className="auth-card">
            <LanguageSwitcher />
            <span className="corner-mark corner-mark--tl" aria-hidden="true">
              +
            </span>
            <span className="corner-mark corner-mark--tr" aria-hidden="true">
              +
            </span>
            <span className="corner-mark corner-mark--bl" aria-hidden="true">
              +
            </span>
            <span className="corner-mark corner-mark--br" aria-hidden="true">
              +
            </span>
            <div className="auth-eyebrow">{t("TERMINAL ACCESS")}</div>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
