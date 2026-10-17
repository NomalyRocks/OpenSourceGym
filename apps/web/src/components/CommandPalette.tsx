import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";

export interface PaletteItem {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
}

/** Quick actions: jump to a page or switch gym by typing a few letters. */
export function CommandPalette({
  items,
  onClose,
}: {
  items: PaletteItem[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLocaleLowerCase();
  const shown = items.filter((i) => i.label.toLocaleLowerCase().includes(q));

  useEffect(() => inputRef.current?.focus(), []);

  function choose(item: PaletteItem | undefined) {
    if (!item) return;
    onClose();
    item.run();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") choose(shown[index]);
  }

  return (
    <div className="modal-overlay top" onMouseDown={onClose}>
      <div
        className="panel palette"
        role="dialog"
        aria-label={t("Quick actions")}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          placeholder={t("Type a page or gym name…")}
        />
        <div className="palette-list">
          {shown.map((item, i) => (
            <button
              key={item.id}
              type="button"
              className={i === index ? "selected" : ""}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(item)}
            >
              <item.icon size={16} className="icon" />
              {item.label}
            </button>
          ))}
          {shown.length === 0 && (
            <p className="hint" style={{ padding: 10 }}>
              {t("No results.")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
