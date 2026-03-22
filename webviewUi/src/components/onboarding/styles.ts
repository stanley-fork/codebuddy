import styled, { keyframes } from "styled-components";

// ─── Animations ─────────────────────────────────────────

const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
`;

const slideIn = keyframes`
  from { opacity: 0; transform: translateX(20px); }
  to { opacity: 1; transform: translateX(0); }
`;

// ─── Layout ─────────────────────────────────────────────

export const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: var(--vscode-editor-background, #1e1e1e);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
`;

export const WizardContainer = styled.div`
  max-width: 640px;
  width: 100%;
  margin: 0 auto;
  padding: 32px 24px;
  animation: ${fadeIn} 0.4s ease-out;
`;

export const StepContent = styled.div`
  animation: ${slideIn} 0.3s ease-out;
  min-height: 300px;
`;

// ─── Header ─────────────────────────────────────────────

export const WizardHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
`;

export const StepIndicator = styled.div`
  display: flex;
  gap: 8px;
  align-items: center;
`;

export const StepDot = styled.div<{ $active: boolean; $completed: boolean }>`
  width: 10px;
  height: 10px;
  border-radius: 50%;
  transition: all 0.2s ease;
  background: ${(p) =>
    p.$active
      ? "var(--vscode-focusBorder, #007acc)"
      : p.$completed
        ? "var(--vscode-terminal-ansiGreen, #89d185)"
        : "var(--vscode-widget-border, #3c3c3c)"};
`;

export const SkipButton = styled.button`
  background: none;
  border: none;
  color: var(--vscode-descriptionForeground, #888);
  font-size: 12px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;

  &:hover {
    color: var(--vscode-foreground, #ccc);
    background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
  }
`;

// ─── Typography ─────────────────────────────────────────

export const StepTitle = styled.h2`
  color: var(--vscode-foreground, #cccccc);
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 8px 0;
`;

export const StepSubtitle = styled.p`
  color: var(--vscode-descriptionForeground, #888);
  font-size: 13px;
  margin: 0 0 24px 0;
  line-height: 1.5;
`;

// ─── Navigation ─────────────────────────────────────────

export const NavRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 32px;
  padding-top: 16px;
  border-top: 1px solid var(--vscode-widget-border, #3c3c3c);
`;

export const PrimaryButton = styled.button`
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none;
  padding: 8px 20px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  font-weight: 500;

  &:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

export const SecondaryButton = styled.button`
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #fff);
  border: none;
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground, #45494e);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

// ─── Cards & Lists ──────────────────────────────────────

export const Card = styled.div<{ $selected?: boolean }>`
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid
    ${(p) =>
      p.$selected
        ? "var(--vscode-focusBorder, #007acc)"
        : "var(--vscode-widget-border, #3c3c3c)"};
  border-radius: 6px;
  padding: 12px 16px;
  cursor: pointer;
  transition: border-color 0.15s ease;

  &:hover {
    border-color: var(--vscode-focusBorder, #007acc);
  }
`;

export const CardTitle = styled.div`
  color: var(--vscode-foreground, #ccc);
  font-size: 13px;
  font-weight: 500;
`;

export const CardDescription = styled.div`
  color: var(--vscode-descriptionForeground, #888);
  font-size: 12px;
  margin-top: 4px;
`;

export const CardGrid = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

// ─── Form ───────────────────────────────────────────────

export const InputGroup = styled.div`
  margin-bottom: 16px;
`;

export const Label = styled.label`
  display: block;
  color: var(--vscode-foreground, #ccc);
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 6px;
`;

export const TextInput = styled.input`
  width: 100%;
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #ccc);
  border: 1px solid var(--vscode-input-border, #3c3c3c);
  border-radius: 4px;
  padding: 8px 12px;
  font-size: 13px;
  font-family: var(--vscode-font-family);
  box-sizing: border-box;

  &:focus {
    outline: none;
    border-color: var(--vscode-focusBorder, #007acc);
  }

  &::placeholder {
    color: var(--vscode-input-placeholderForeground, #888);
  }
`;

// ─── Status ─────────────────────────────────────────────

export const StatusBadge = styled.span<{
  $variant: "success" | "error" | "info" | "pending";
}>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: ${(p) => {
    switch (p.$variant) {
      case "success":
        return "rgba(137, 209, 133, 0.15)";
      case "error":
        return "rgba(241, 76, 76, 0.15)";
      case "info":
        return "rgba(55, 148, 255, 0.15)";
      case "pending":
        return "rgba(204, 167, 0, 0.15)";
    }
  }};
  color: ${(p) => {
    switch (p.$variant) {
      case "success":
        return "var(--vscode-terminal-ansiGreen, #89d185)";
      case "error":
        return "var(--vscode-editorError-foreground, #f14c4c)";
      case "info":
        return "var(--vscode-editorInfo-foreground, #3794ff)";
      case "pending":
        return "var(--vscode-editorWarning-foreground, #cca700)";
    }
  }};
`;

// ─── Welcome-specific ───────────────────────────────────

export const WelcomeHero = styled.div`
  text-align: center;
  padding: 40px 0 20px;
`;

export const WelcomeLogo = styled.div`
  font-size: 48px;
  margin-bottom: 16px;
`;

export const WelcomeTitle = styled.h1`
  color: var(--vscode-foreground, #cccccc);
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 12px 0;
`;

export const WelcomeSubtitle = styled.p`
  color: var(--vscode-descriptionForeground, #888);
  font-size: 14px;
  line-height: 1.6;
  margin: 0 0 32px 0;
  max-width: 480px;
  margin-inline: auto;
`;

export const FeatureList = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  text-align: left;
`;

export const FeatureItem = styled.div`
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px;
  border-radius: 6px;
  background: var(--vscode-input-background, #3c3c3c);
`;

export const FeatureIcon = styled.span`
  font-size: 18px;
  flex-shrink: 0;
  line-height: 1;
  margin-top: 2px;
`;

export const FeatureText = styled.div`
  font-size: 12px;
  color: var(--vscode-foreground, #ccc);
  line-height: 1.4;

  strong {
    display: block;
    margin-bottom: 2px;
  }
`;

// ─── Provider-specific ──────────────────────────────────

export const ProviderRow = styled.div<{ $selected?: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid
    ${(p) =>
      p.$selected
        ? "var(--vscode-focusBorder, #007acc)"
        : "var(--vscode-widget-border, #3c3c3c)"};
  background: ${(p) =>
    p.$selected
      ? "rgba(0, 122, 204, 0.08)"
      : "var(--vscode-input-background, #3c3c3c)"};
  transition: all 0.15s ease;

  &:hover {
    border-color: var(--vscode-focusBorder, #007acc);
  }
`;

export const ProviderName = styled.span`
  color: var(--vscode-foreground, #ccc);
  font-size: 13px;
  font-weight: 500;
`;

export const ProviderStatus = styled.span`
  font-size: 11px;
`;

// ─── Security-specific ──────────────────────────────────

export const SecurityProfile = styled.div<{ $selected?: boolean }>`
  padding: 12px 16px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid
    ${(p) =>
      p.$selected
        ? "var(--vscode-focusBorder, #007acc)"
        : "var(--vscode-widget-border, #3c3c3c)"};
  transition: all 0.15s ease;

  &:hover {
    border-color: var(--vscode-focusBorder, #007acc);
  }
`;

export const ProfileName = styled.div`
  color: var(--vscode-foreground, #ccc);
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 4px;
`;

export const ProfileDescription = styled.div`
  color: var(--vscode-descriptionForeground, #888);
  font-size: 12px;
  line-height: 1.4;
`;

// ─── Task-specific ──────────────────────────────────────

export const TaskCard = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid var(--vscode-widget-border, #3c3c3c);
  background: var(--vscode-input-background, #3c3c3c);
  transition: all 0.15s ease;

  &:hover {
    border-color: var(--vscode-focusBorder, #007acc);
    background: rgba(0, 122, 204, 0.05);
  }
`;

export const TaskIcon = styled.span`
  font-size: 20px;
  flex-shrink: 0;
`;

export const TaskLabel = styled.span`
  color: var(--vscode-foreground, #ccc);
  font-size: 13px;
`;

// ─── Workspace info ─────────────────────────────────────

export const InfoGrid = styled.div`
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 16px;
  font-size: 12px;
  margin-bottom: 20px;
`;

export const InfoLabel = styled.span`
  color: var(--vscode-descriptionForeground, #888);
`;

export const InfoValue = styled.span`
  color: var(--vscode-foreground, #ccc);
`;

export const CheckboxRow = styled.label`
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--vscode-foreground, #ccc);
  padding: 6px 0;
`;
