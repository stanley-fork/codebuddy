import styled from "styled-components";

export const DoctorSummaryRow = styled.div`
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
`;

export const DoctorBadge = styled.span<{
  $variant: "critical" | "warn" | "info";
}>`
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  background: ${(p) =>
    p.$variant === "critical"
      ? "rgba(241, 76, 76, 0.15)"
      : p.$variant === "warn"
        ? "rgba(204, 167, 0, 0.15)"
        : "rgba(55, 148, 255, 0.15)"};
  color: ${(p) =>
    p.$variant === "critical"
      ? "var(--vscode-editorError-foreground, #f14c4c)"
      : p.$variant === "warn"
        ? "var(--vscode-editorWarning-foreground, #cca700)"
        : "var(--vscode-editorInfo-foreground, #3794ff)"};
`;

export const DoctorFindingsList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
  max-height: 200px;
  overflow-y: auto;
`;

export const DoctorFindingItem = styled.div<{ $severity: string }>`
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.08));
  border-left: 2px solid
    ${(p) =>
      p.$severity === "critical"
        ? "var(--vscode-editorError-foreground, #f14c4c)"
        : p.$severity === "warn"
          ? "var(--vscode-editorWarning-foreground, #cca700)"
          : "var(--vscode-editorInfo-foreground, #3794ff)"};
`;

export const DoctorFindingText = styled.span`
  flex: 1;
  line-height: 1.4;
  color: var(--vscode-foreground);
`;

export const DoctorFixTag = styled.span`
  margin-left: 4px;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(55, 148, 255, 0.12);
  color: var(--vscode-editorInfo-foreground, #3794ff);
`;

export const DoctorSuccessText = styled.div`
  color: var(--vscode-terminal-ansiGreen, #89d185);
  font-size: 11px;
  margin-bottom: 6px;
`;

export const DoctorTimestamp = styled.div`
  font-size: 10px;
  margin-top: 6px;
  color: var(--vscode-descriptionForeground);
`;
