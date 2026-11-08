import { useState } from "react";
import { useTranslation } from "react-i18next";
import { moneyInputValue, parseMoney } from "../lib/money";

/** The draft retains formatting; consumers receive integer minor units only. */
export function MoneyInput({
  id,
  value,
  onChange,
  required = true,
}: {
  id: string;
  value: number | null;
  onChange: (minor: number | null) => void;
  required?: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(
    value === null ? "" : moneyInputValue(value),
  );
  const invalid = draft !== "" && parseMoney(draft) === null;
  return (
    <>
      <input
        id={id}
        inputMode="decimal"
        value={draft}
        required={required}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(parseMoney(e.target.value));
        }}
      />
      {invalid && (
        <span id={`${id}-error`} className="hint">
          {t("Enter a nonnegative amount with at most two decimals.")}
        </span>
      )}
    </>
  );
}
