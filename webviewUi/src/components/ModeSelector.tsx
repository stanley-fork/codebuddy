import React, { useEffect, useRef, useState, useCallback } from "react";
import { useSettingsStore } from "../stores/settings.store";
import { codeBuddyMode } from "../constants/constant";

const MODE_META: Record<string, { hint: string }> = {
  Agent: { hint: "Autonomous — runs tools, edits files, executes commands" },
  Ask:   { hint: "Conversational — answers questions, no side-effects" },
};

/* ── Inline styles ── */

const pillStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  fontSize: "11px",
  padding: "2px 8px",
  borderRadius: "10px",
  cursor: "pointer",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "var(--vscode-descriptionForeground, rgba(255,255,255,0.7))",
  whiteSpace: "nowrap",
  position: "relative",
  userSelect: "none",
};

const popoverStyle: React.CSSProperties = {
  position: "absolute",
  bottom: "calc(100% + 6px)",
  left: 0,
  minWidth: "200px",
  background: "var(--vscode-editorWidget-background, #252526)",
  border: "1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.12))",
  borderRadius: "8px",
  boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
  zIndex: 1000,
  padding: "6px 0",
};

const itemStyle = (isActive: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "7px 12px",
  fontSize: "12px",
  cursor: "pointer",
  background: isActive ? "rgba(255,255,255,0.08)" : "transparent",
  color: isActive
    ? "var(--vscode-textLink-foreground, #3794ff)"
    : "var(--vscode-foreground, #ccc)",
  borderLeft: isActive
    ? "2px solid var(--vscode-textLink-foreground, #3794ff)"
    : "2px solid transparent",
});

const hintStyle: React.CSSProperties = {
  fontSize: "10px",
  color: "rgba(255,255,255,0.4)",
  marginTop: "2px",
};

/* ── Component ── */

export function ModeSelector() {
  const selectedMode = useSettingsStore((s) => s.selectedCodeBuddyMode);
  const handleModeChange = useSettingsStore((s) => s.handleCodeBuddyModeChange);
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [isOpen]);

  const select = useCallback(
    (value: string) => {
      handleModeChange(value);
      setIsOpen(false);
    },
    [handleModeChange],
  );

  const meta = MODE_META[selectedMode] ?? MODE_META.Agent;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div
        style={pillStyle}
        onClick={() => setIsOpen((o) => !o)}
        title={`Mode: ${selectedMode} — ${meta.hint}`}
        role="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <ModeIcon mode={selectedMode} size={11} />
        <span>{selectedMode}</span>
        <ChevronIcon size={8} />
      </div>

      {isOpen && (
        <div style={popoverStyle} role="listbox">
          {codeBuddyMode.map((opt) => {
            const isActive = selectedMode === opt.value;
            const m = MODE_META[opt.value];
            return (
              <div
                key={opt.value}
                style={itemStyle(isActive)}
                onClick={() => select(opt.value)}
                role="option"
                aria-selected={isActive}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
              >
                <ModeIcon mode={opt.value} size={13} />
                <div>
                  <div>{opt.label}</div>
                  {m && <div style={hintStyle}>{m.hint}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Tiny chevron icon ── */

function ChevronIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/* ── Mode icons (Agent = bolt, Ask = chat bubble) ── */

function ModeIcon({ mode, size = 14 }: { mode: string; size?: number }) {
  if (mode === "Agent") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
