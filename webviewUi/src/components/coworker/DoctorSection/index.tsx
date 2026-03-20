import React, { useEffect, useMemo } from "react";
import { useDoctorStore } from "../../../stores/doctor.store";
import {
  Section,
  SectionTitle,
  TaskDescription,
  QuickActions,
  TriggerButton,
  ErrorText,
} from "../CoWorkerPanel";
import {
  DoctorSummaryRow,
  DoctorBadge,
  DoctorFindingsList,
  DoctorFindingItem,
  DoctorFindingText,
  DoctorFixTag,
  DoctorSuccessText,
  DoctorTimestamp,
} from "./styles";

export const DoctorSection: React.FC<{ isOpen: boolean }> = ({ isOpen }) => {
  const {
    findings,
    lastScanTime,
    isScanning,
    lastError,
    lastFixesApplied,
    runScan,
    runAutoFix,
    hydrate,
  } = useDoctorStore();

  useEffect(() => {
    if (isOpen && lastScanTime === null) hydrate();
  }, [isOpen, lastScanTime, hydrate]);

  const { critical, warn, info, fixable, timestampColor } = useMemo(() => {
    const c = findings.filter((f) => f.severity === "critical").length;
    const w = findings.filter((f) => f.severity === "warn").length;
    const i = findings.filter((f) => f.severity === "info").length;
    const fix = findings.filter((f) => f.autoFixable).length;
    const color =
      c > 0
        ? "var(--vscode-editorError-foreground, #f14c4c)"
        : w > 0
          ? "var(--vscode-editorWarning-foreground, #cca700)"
          : "var(--vscode-editorInfo-foreground, #3794ff)";
    return {
      critical: c,
      warn: w,
      info: i,
      fixable: fix,
      timestampColor: color,
    };
  }, [findings]);

  return (
    <Section>
      <SectionTitle>Security Pulse</SectionTitle>
      <TaskDescription style={{ marginBottom: 8 }}>
        Runs security health checks across API keys, terminal restrictions, MCP
        servers, file permissions, and security config.
      </TaskDescription>

      {/* ── Summary badges ── */}
      {lastScanTime !== null && (
        <DoctorSummaryRow>
          {critical > 0 && (
            <DoctorBadge $variant="critical">{critical} critical</DoctorBadge>
          )}
          {warn > 0 && (
            <DoctorBadge $variant="warn">{warn} warning</DoctorBadge>
          )}
          {info > 0 && <DoctorBadge $variant="info">{info} info</DoctorBadge>}
          {findings.length === 0 && (
            <DoctorBadge $variant="info">No issues</DoctorBadge>
          )}
        </DoctorSummaryRow>
      )}

      {/* ── Findings list ── */}
      {findings.length > 0 && (
        <DoctorFindingsList>
          {findings.map((f) => (
            <DoctorFindingItem key={f.id} $severity={f.severity}>
              <span>
                {f.severity === "critical"
                  ? "❌"
                  : f.severity === "warn"
                    ? "⚠️"
                    : "ℹ️"}
              </span>
              <DoctorFindingText>
                <strong>[{f.check}]</strong> {f.message}
                {f.autoFixable && <DoctorFixTag>auto-fixable</DoctorFixTag>}
              </DoctorFindingText>
            </DoctorFindingItem>
          ))}
        </DoctorFindingsList>
      )}

      {lastError && <ErrorText>{lastError}</ErrorText>}
      {lastFixesApplied !== null && lastFixesApplied > 0 && (
        <DoctorSuccessText>
          ✅ {lastFixesApplied} fix(es) applied
        </DoctorSuccessText>
      )}

      {/* ── Actions ── */}
      <QuickActions>
        <TriggerButton onClick={runScan} disabled={isScanning}>
          {isScanning ? "⏳ Scanning..." : "🩺 Run Doctor"}
        </TriggerButton>
        {fixable > 0 && (
          <TriggerButton onClick={runAutoFix} disabled={isScanning}>
            🔧 Auto-Fix ({fixable})
          </TriggerButton>
        )}
      </QuickActions>

      {lastScanTime !== null && (
        <DoctorTimestamp style={{ color: timestampColor }}>
          Last scan: {new Date(lastScanTime).toLocaleTimeString()}
        </DoctorTimestamp>
      )}
    </Section>
  );
};
