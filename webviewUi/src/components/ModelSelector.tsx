import React, { useEffect, useRef, useState, useCallback } from "react";
import { useSettingsStore } from "../stores/settings.store";
import { modelOptions, PREDEFINED_LOCAL_MODELS } from "../constants/constant";
import { usePanelStore } from "../stores/panels.store";
import { vscode } from "../utils/vscode";

/* ── Inline styles (compact status-bar component) ── */

const pillStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
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
  minWidth: "220px",
  maxWidth: "280px",
  background: "var(--vscode-editorWidget-background, #252526)",
  border: "1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.12))",
  borderRadius: "8px",
  boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
  zIndex: 1000,
  padding: "6px 0",
  maxHeight: "320px",
  overflowY: "auto",
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: "10px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  color: "rgba(255,255,255,0.4)",
  padding: "6px 12px 3px",
};

const itemStyle = (isActive: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "5px 12px",
  fontSize: "12px",
  cursor: "pointer",
  background: isActive ? "rgba(255,255,255,0.08)" : "transparent",
  color: isActive
    ? "var(--vscode-textLink-foreground, #3794ff)"
    : "var(--vscode-foreground, #ccc)",
  borderLeft: isActive ? "2px solid var(--vscode-textLink-foreground, #3794ff)" : "2px solid transparent",
});

const itemHoverHandlers = (isActive: boolean) => ({
  onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.05)";
  },
  onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isActive) e.currentTarget.style.background = "transparent";
  },
});

const badgeStyle = (color: string): React.CSSProperties => ({
  display: "inline-block",
  width: "6px",
  height: "6px",
  borderRadius: "50%",
  background: color,
  flexShrink: 0,
});

const localSubStyle: React.CSSProperties = {
  fontSize: "10px",
  color: "rgba(255,255,255,0.45)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const footerStyle: React.CSSProperties = {
  borderTop: "1px solid rgba(255,255,255,0.08)",
  padding: "6px 12px",
  fontSize: "11px",
  color: "var(--vscode-textLink-foreground, #3794ff)",
  cursor: "pointer",
  textAlign: "center",
};

/* ── Component ── */

export function ModelSelector() {
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const handleModelChange = useSettingsStore((s) => s.handleModelChange);
  const [isOpen, setIsOpen] = useState(false);
  const [dockerAvailable, setDockerAvailable] = useState(false);
  const [ollamaRunning, setOllamaRunning] = useState(false);
  const [activeLocalModel, setActiveLocalModel] = useState<string | null>(null);
  const [pulledModels, setPulledModels] = useState<string[]>([]);
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

  // Listen for Docker messages (same pattern as ModelsSettings)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data;
      switch (msg.type) {
        case "docker-status":
          setDockerAvailable(msg.available);
          break;
        case "docker-ollama-status":
          setOllamaRunning(msg.running);
          break;
        case "docker-local-model":
          setActiveLocalModel(msg.model);
          break;
        case "docker-models-list":
          if (msg.models) setPulledModels(msg.models.map((m: any) => m.name));
          break;
        case "docker-model-selected":
          if (msg.success) {
            setActiveLocalModel(msg.model);
            handleModelChange("Local");
          }
          break;
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleModelChange]);

  // Request Docker status on mount + poll every 30s
  useEffect(() => {
    const check = () => {
      vscode?.postMessage({ command: "docker-check-status" });
      vscode?.postMessage({ command: "docker-check-ollama-status" });
      vscode?.postMessage({ command: "docker-get-local-model" });
      vscode?.postMessage({ command: "docker-get-models" });
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  const selectProvider = useCallback(
    (value: string) => {
      handleModelChange(value);
      setIsOpen(false);
    },
    [handleModelChange],
  );

  const selectLocalModel = useCallback(
    (modelName: string) => {
      vscode?.postMessage({ command: "docker-use-model", model: modelName });
      // Keep popover open briefly so user sees feedback
    },
    [],
  );

  const openModelSettings = useCallback(() => {
    setIsOpen(false);
    usePanelStore.getState().openSettings();
  }, []);

  const isLocal = selectedModel === "Local";
  const localReady = dockerAvailable || ollamaRunning;
  const displayLabel =
    isLocal && activeLocalModel
      ? activeLocalModel
      : modelOptions.find((o) => o.value === selectedModel)?.label ?? selectedModel;

  const cloudProviders = modelOptions.filter((o) => o.value !== "Local");

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div
        style={pillStyle}
        onClick={() => setIsOpen((o) => !o)}
        title={`Model: ${displayLabel}${isLocal && localReady ? " (running)" : ""}`}
        role="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <ModelIcon size={11} />
        <span
          style={{
            maxWidth: "100px",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {displayLabel}
        </span>
        {isLocal && (
          <span
            style={badgeStyle(
              localReady
                ? "var(--vscode-testing-iconPassed, #4ec9b0)"
                : "var(--vscode-errorForeground, #f14c4c)",
            )}
            title={localReady ? "Local runtime active" : "Local runtime offline"}
          />
        )}
        <ChevronIcon size={8} />
      </div>

      {isOpen && (
        <div style={popoverStyle} role="listbox">
          {/* ── Cloud Providers ── */}
          <div style={sectionLabelStyle}>Providers</div>
          {cloudProviders.map((opt) => (
            <div
              key={opt.value}
              style={itemStyle(selectedModel === opt.value)}
              onClick={() => selectProvider(opt.value)}
              role="option"
              aria-selected={selectedModel === opt.value}
              {...itemHoverHandlers(selectedModel === opt.value)}
            >
              <span style={{ flex: 1 }}>{opt.label}</span>
              <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.35)" }}>
                {opt.pricingHint}
              </span>
            </div>
          ))}

          {/* ── Local Models ── */}
          <div style={{ ...sectionLabelStyle, marginTop: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
            Local Models
            <span
              style={badgeStyle(
                localReady
                  ? "var(--vscode-testing-iconPassed, #4ec9b0)"
                  : "var(--vscode-errorForeground, #f14c4c)",
              )}
              title={
                dockerAvailable
                  ? "Docker Model Runner active"
                  : ollamaRunning
                    ? "Ollama active"
                    : "No local runtime detected"
              }
            />
          </div>

          {/* Active local model */}
          {isLocal && activeLocalModel && (
            <div style={{ ...itemStyle(true), flexDirection: "column", alignItems: "flex-start", gap: "2px" }}>
              <span>{activeLocalModel}</span>
              <span style={localSubStyle}>Active · {dockerAvailable ? "Docker" : "Ollama"}</span>
            </div>
          )}

          {/* Pulled / available models */}
          {pulledModels
            .filter((m) => m !== activeLocalModel)
            .slice(0, 5)
            .map((m) => (
              <div
                key={m}
                style={itemStyle(false)}
                onClick={() => selectLocalModel(m)}
                role="option"
                aria-selected={false}
                {...itemHoverHandlers(false)}
              >
                <span style={{ flex: 1 }}>{m}</span>
                <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.35)" }}>Use</span>
              </div>
            ))}

          {/* Quick-pull suggestions when no pulled models */}
          {pulledModels.length === 0 && (
            <>
              {PREDEFINED_LOCAL_MODELS.slice(0, 3).map((m) => (
                <div
                  key={m.value}
                  style={{ ...itemStyle(false), opacity: 0.6 }}
                  title={m.description}
                  {...itemHoverHandlers(false)}
                >
                  <span style={{ flex: 1 }}>{m.label}</span>
                  <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.35)" }}>available</span>
                </div>
              ))}
            </>
          )}

          {/* Select Local provider if not already */}
          {!isLocal && (
            <div
              style={itemStyle(false)}
              onClick={() => selectProvider("Local")}
              role="option"
              aria-selected={false}
              {...itemHoverHandlers(false)}
            >
              <span style={{ flex: 1 }}>Switch to Local</span>
              <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.35)" }}>free</span>
            </div>
          )}

          {/* Footer link */}
          <div
            style={footerStyle}
            onClick={openModelSettings}
            {...{
              onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.04)";
              },
              onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => {
                e.currentTarget.style.background = "transparent";
              },
            }}
          >
            Manage models…
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Tiny inline icons ── */

function ModelIcon({ size = 14 }: { size?: number }) {
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
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

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
