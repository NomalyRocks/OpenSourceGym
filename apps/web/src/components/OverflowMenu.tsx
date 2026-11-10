import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

export interface OverflowMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  reason?: string;
  destructive?: boolean;
}

/** A portalled menu so drawer scrolling never clips its actions. */
export function OverflowMenu({
  label,
  items,
}: {
  label: string;
  items: OverflowMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef("first");
  const id = useId();

  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = menu.current.getBoundingClientRect();
    const gap = 6;
    const below = anchor.bottom + gap;
    setPosition({
      top:
        below + bounds.height <= window.innerHeight - gap
          ? below
          : Math.max(gap, anchor.top - bounds.height - gap),
      left: Math.max(
        gap,
        Math.min(
          anchor.right - bounds.width,
          window.innerWidth - bounds.width - gap,
        ),
      ),
    });
    const buttons =
      menu.current.querySelectorAll<HTMLButtonElement>("[role=menuitem]");
    const index = initialFocus.current === "last" ? buttons.length - 1 : 0;
    buttons[index]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function outside(event: Event) {
      const target = event.target as Node;
      if (
        !menu.current?.contains(target) &&
        !trigger.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    }
    function closeOnScroll(event: Event) {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    }
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    document.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  if (items.length === 0) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ghost overflow-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          initialFocus.current = "first";
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            initialFocus.current = event.key === "ArrowUp" ? "last" : "first";
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            role="menu"
            aria-label={label}
            className="overflow-menu"
            style={position}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              const buttons = Array.from(
                menu.current?.querySelectorAll<HTMLButtonElement>(
                  "[role=menuitem]",
                ) ?? [],
              );
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              let next: number | undefined;
              if (event.key === "ArrowDown")
                next = (index + 1) % buttons.length;
              if (event.key === "ArrowUp")
                next = (index - 1 + buttons.length) % buttons.length;
              if (event.key === "Home") next = 0;
              if (event.key === "End") next = buttons.length - 1;
              if (next !== undefined) {
                event.preventDefault();
                buttons[next]?.focus();
              }
              if (event.key === "Tab") {
                setOpen(false);
                trigger.current?.focus();
              }
            }}
          >
            {items.map((item, index) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`overflow-item${item.destructive ? " destructive" : ""}`}
                aria-disabled={item.disabled || undefined}
                aria-describedby={item.reason ? `${id}-${index}` : undefined}
                onClick={() => {
                  if (item.disabled) return;
                  setOpen(false);
                  trigger.current?.focus();
                  item.onSelect();
                }}
              >
                <span>{item.label}</span>
                {item.reason && (
                  <span className="hint" id={`${id}-${index}`}>
                    {item.reason}
                  </span>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
