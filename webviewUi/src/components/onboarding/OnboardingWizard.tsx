import React, { useEffect, useState, useCallback } from "react";
import {
  useOnboardingStore,
  STEP_ORDER,
  type ProviderInfo,
  type ProjectInfo,
  type SuggestedTask,
} from "../../stores/onboarding.store";
import {
  Overlay,
  WizardContainer,
  WizardHeader,
  StepIndicator,
  StepDot,
  SkipButton,
  StepContent,
  StepTitle,
  StepSubtitle,
  NavRow,
  PrimaryButton,
  SecondaryButton,
  WelcomeHero,
  WelcomeLogo,
  WelcomeTitle,
  WelcomeSubtitle,
  FeatureList,
  FeatureItem,
  FeatureIcon,
  FeatureText,
  ProviderRow,
  ProviderName,
  ProviderStatus,
  StatusBadge,
  CardGrid,
  InputGroup,
  Label,
  TextInput,
  InfoGrid,
  InfoLabel,
  InfoValue,
  CheckboxRow,
  SecurityProfile,
  ProfileName,
  ProfileDescription,
  TaskCard,
  TaskIcon,
  TaskLabel,
} from "./styles";
import { vscode } from "../../utils/vscode";

// ─── Step metadata (derived from the store's STEP_ORDER) ─

const STEP_LABELS: Record<string, string> = {
  welcome: "Welcome",
  provider: "Provider",
  workspace: "Workspace",
  security: "Security",
  firstTask: "Get Started",
};

// ─── Main Component ─────────────────────────────────────

export const OnboardingWizard: React.FC = () => {
  const {
    isVisible,
    currentStep,
    providers,
    projectInfo,
    suggestedTasks,
    isTestingProvider,
    testResult,
    stepCompleting,
    nextStep,
    prevStep,
    skip,
    dismiss,
    completeStep,
    submitProviderKey,
    testProvider,
  } = useOnboardingStore();

  if (!isVisible) return null;

  const stepIdx = STEP_ORDER.indexOf(currentStep);
  const isFirstStep = stepIdx === 0;
  const isLastStep = stepIdx === STEP_ORDER.length - 1;

  return (
    <Overlay role="dialog" aria-modal="true" aria-label="Onboarding Wizard">
      <WizardContainer>
        <WizardHeader>
          <StepIndicator role="navigation" aria-label="Wizard steps">
            {STEP_ORDER.map((s, i) => (
              <StepDot
                key={s}
                $active={i === stepIdx}
                $completed={i < stepIdx}
                title={STEP_LABELS[s] ?? s}
                aria-label={`Step ${i + 1}: ${STEP_LABELS[s] ?? s}${i === stepIdx ? " (current)" : i < stepIdx ? " (completed)" : ""}`}
              />
            ))}
          </StepIndicator>
          <SkipButton onClick={skip} aria-label="Skip onboarding setup">Skip setup</SkipButton>
        </WizardHeader>

        <StepContent key={currentStep} role="region" aria-label={STEP_LABELS[currentStep] ?? currentStep}>
          {currentStep === "welcome" && <WelcomeStep />}
          {currentStep === "provider" && (
            <ProviderStep
              providers={providers}
              isTestingProvider={isTestingProvider}
              testResult={testResult}
              onTestProvider={testProvider}
              onSubmitKey={submitProviderKey}
              onComplete={completeStep}
              stepCompleting={stepCompleting}
            />
          )}
          {currentStep === "workspace" && (
            <WorkspaceStep
              projectInfo={projectInfo}
              onComplete={completeStep}
              stepCompleting={stepCompleting}
            />
          )}
          {currentStep === "security" && (
            <SecurityStep
              onComplete={completeStep}
              stepCompleting={stepCompleting}
            />
          )}
          {currentStep === "firstTask" && (
            <FirstTaskStep
              suggestedTasks={suggestedTasks}
              onDismiss={dismiss}
            />
          )}
        </StepContent>

        <NavRow>
          {!isFirstStep ? (
            <SecondaryButton onClick={prevStep} aria-label="Go to previous step">Back</SecondaryButton>
          ) : (
            <div />
          )}
          {!isLastStep ? (
            <PrimaryButton onClick={nextStep} aria-label="Go to next step">
              {currentStep === "welcome" ? "Get Started" : "Next"}
            </PrimaryButton>
          ) : (
            <PrimaryButton onClick={dismiss} aria-label="Close wizard and start using CodeBuddy">
              Start Using CodeBuddy
            </PrimaryButton>
          )}
        </NavRow>
      </WizardContainer>
    </Overlay>
  );
};

// ─── Step 0: Welcome ────────────────────────────────────

const WelcomeStep: React.FC = () => (
  <WelcomeHero>
    <WelcomeLogo>🤖</WelcomeLogo>
    <WelcomeTitle>Welcome to CodeBuddy</WelcomeTitle>
    <WelcomeSubtitle>
      Your autonomous AI software engineer for VS Code. Let&apos;s get you set
      up in under a minute.
    </WelcomeSubtitle>
    <FeatureList>
      <FeatureItem>
        <FeatureIcon>💬</FeatureIcon>
        <FeatureText>
          <strong>Agent Mode</strong>
          Autonomous coding with file edits, terminal, and browser
        </FeatureText>
      </FeatureItem>
      <FeatureItem>
        <FeatureIcon>🔍</FeatureIcon>
        <FeatureText>
          <strong>Codebase Search</strong>
          Hybrid semantic + keyword search across your entire project
        </FeatureText>
      </FeatureItem>
      <FeatureItem>
        <FeatureIcon>🔒</FeatureIcon>
        <FeatureText>
          <strong>Security Built-in</strong>
          Permission profiles, credential proxy, and safety guardrails
        </FeatureText>
      </FeatureItem>
      <FeatureItem>
        <FeatureIcon>🌐</FeatureIcon>
        <FeatureText>
          <strong>8 LLM Providers</strong>
          Anthropic, OpenAI, Gemini, Groq, Deepseek, and more
        </FeatureText>
      </FeatureItem>
      <FeatureItem>
        <FeatureIcon>🛠️</FeatureIcon>
        <FeatureText>
          <strong>16+ Skills</strong>
          GitHub, Jira, AWS, Kubernetes, databases, and more
        </FeatureText>
      </FeatureItem>
      <FeatureItem>
        <FeatureIcon>🔄</FeatureIcon>
        <FeatureText>
          <strong>Provider Failover</strong>
          Automatic fallback when your primary provider is down
        </FeatureText>
      </FeatureItem>
    </FeatureList>
  </WelcomeHero>
);

// ─── Step 1: Provider Setup ─────────────────────────────

interface ProviderStepProps {
  providers: ProviderInfo[];
  isTestingProvider: boolean;
  testResult: { provider: string; success: boolean; error?: string } | null;
  onTestProvider: (provider: string) => void;
  onSubmitKey: (provider: string, apiKey: string) => void;
  onComplete: (step: number, data: Record<string, unknown>) => void;
  stepCompleting: boolean;
}

const ProviderStep: React.FC<ProviderStepProps> = ({
  providers,
  isTestingProvider,
  testResult,
  onTestProvider,
  onSubmitKey,
  onComplete,
  stepCompleting,
}) => {
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [apiKey, setApiKey] = useState("");

  const handleProviderSelect = useCallback((id: string) => {
    setSelectedProvider(id);
    setApiKey("");
  }, []);

  const handleSave = useCallback(() => {
    if (stepCompleting || !selectedProvider || !apiKey) return;
    // Store key securely via dedicated command, then mark step complete
    onSubmitKey(selectedProvider, apiKey);
    onComplete(1, { provider: selectedProvider });
    setApiKey(""); // clear local state immediately
  }, [selectedProvider, apiKey, onSubmitKey, onComplete, stepCompleting]);

  const handleTest = useCallback(() => {
    if (!selectedProvider || !apiKey) return;
    // Store the key first, then test from stored key
    onSubmitKey(selectedProvider, apiKey);
    onTestProvider(selectedProvider);
  }, [selectedProvider, apiKey, onSubmitKey, onTestProvider]);

  const alreadyConfigured = providers.filter((p) => p.configured);

  return (
    <>
      <StepTitle>Choose Your AI Provider</StepTitle>
      <StepSubtitle>
        {alreadyConfigured.length > 0
          ? `You have ${alreadyConfigured.length} provider(s) configured. You can add more or continue.`
          : "Select a provider and enter your API key to get started."}
      </StepSubtitle>

      <CardGrid>
        {providers.map((p) => (
          <ProviderRow
            key={p.id}
            $selected={selectedProvider === p.id}
            onClick={() => handleProviderSelect(p.id)}
          >
            <ProviderName>{p.name}</ProviderName>
            <ProviderStatus>
              {p.configured ? (
                <StatusBadge $variant="success">
                  ✓ {p.isActive ? "Active" : "Configured"}
                </StatusBadge>
              ) : selectedProvider === p.id ? (
                <StatusBadge $variant="info">Selected</StatusBadge>
              ) : (
                <StatusBadge $variant="pending">Not configured</StatusBadge>
              )}
            </ProviderStatus>
          </ProviderRow>
        ))}
      </CardGrid>

      {selectedProvider && selectedProvider !== "local" && (
        <InputGroup style={{ marginTop: 16 }}>
          <Label htmlFor="apiKeyInput">
            API Key for{" "}
            {providers.find((p) => p.id === selectedProvider)?.name}
          </Label>
          <div style={{ display: "flex", gap: 8 }}>
            <TextInput
              id="apiKeyInput"
              type="password"
              placeholder="sk-... or your API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-label="API key input"
            />
            <PrimaryButton
              onClick={handleTest}
              disabled={!apiKey || isTestingProvider}
              style={{ flexShrink: 0 }}
              aria-label="Test API key"
            >
              {isTestingProvider ? "Testing..." : "Test"}
            </PrimaryButton>
          </div>
          {testResult && testResult.provider === selectedProvider && (
            <div style={{ marginTop: 8 }} role="status" aria-live="polite">
              {testResult.success ? (
                <StatusBadge $variant="success">✓ Key looks valid</StatusBadge>
              ) : (
                <StatusBadge $variant="error">
                  ✗ {testResult.error || "Test failed"}
                </StatusBadge>
              )}
            </div>
          )}
          {apiKey && (
            <PrimaryButton
              onClick={handleSave}
              disabled={stepCompleting}
              style={{ marginTop: 12, width: "100%" }}
              aria-label="Save API key and set as active provider"
            >
              {stepCompleting ? "Saving..." : "Save & Set as Active Provider"}
            </PrimaryButton>
          )}
        </InputGroup>
      )}

      {selectedProvider === "local" && (
        <InputGroup style={{ marginTop: 16 }}>
          <Label>Local Provider (Ollama, LM Studio, etc.)</Label>
          <StepSubtitle style={{ margin: "0 0 8px" }}>
            Configure your local provider URL in Settings → Local → Base URL
          </StepSubtitle>
          <SecondaryButton
            onClick={() =>
              vscode.postMessage({ command: "open-codebuddy-settings" })
            }
          >
            Open Settings
          </SecondaryButton>
        </InputGroup>
      )}
    </>
  );
};

// ─── Step 2: Workspace Config ───────────────────────────

interface WorkspaceStepProps {
  projectInfo: ProjectInfo | null;
  onComplete: (step: number, data: Record<string, unknown>) => void;
  stepCompleting: boolean;
}

const WorkspaceStep: React.FC<WorkspaceStepProps> = ({
  projectInfo,
  onComplete,
  stepCompleting,
}) => {
  const [createRules, setCreateRules] = useState(true);

  if (!projectInfo) {
    return (
      <>
        <StepTitle>Workspace Configuration</StepTitle>
        <StepSubtitle>
          Open a workspace folder to detect your project setup.
        </StepSubtitle>
      </>
    );
  }

  return (
    <>
      <StepTitle>Workspace Detected</StepTitle>
      <StepSubtitle>
        We analyzed your project and found the following:
      </StepSubtitle>

      <InfoGrid>
        <InfoLabel>Project</InfoLabel>
        <InfoValue>{projectInfo.name}</InfoValue>

        {projectInfo.languages.length > 0 && (
          <>
            <InfoLabel>Languages</InfoLabel>
            <InfoValue>{projectInfo.languages.join(", ")}</InfoValue>
          </>
        )}

        {projectInfo.frameworks.length > 0 && (
          <>
            <InfoLabel>Frameworks</InfoLabel>
            <InfoValue>{projectInfo.frameworks.join(", ")}</InfoValue>
          </>
        )}

        {projectInfo.packageManager && (
          <>
            <InfoLabel>Package Manager</InfoLabel>
            <InfoValue>{projectInfo.packageManager}</InfoValue>
          </>
        )}

        <InfoLabel>Git</InfoLabel>
        <InfoValue>{projectInfo.hasGit ? "✓ Detected" : "Not found"}</InfoValue>

        <InfoLabel>Docker</InfoLabel>
        <InfoValue>
          {projectInfo.hasDocker ? "✓ Detected" : "Not found"}
        </InfoValue>
      </InfoGrid>

      <CheckboxRow>
        <input
          type="checkbox"
          checked={createRules}
          onChange={(e) => setCreateRules(e.target.checked)}
        />
        Create <code>.codebuddy/rules.md</code> with project-specific guidelines
      </CheckboxRow>

      <PrimaryButton
        onClick={() => !stepCompleting && onComplete(2, { createRules })}
        disabled={stepCompleting}
        style={{ marginTop: 12 }}
        aria-label="Apply workspace configuration"
      >
        {stepCompleting ? "Applying..." : "Apply Configuration"}
      </PrimaryButton>
    </>
  );
};

// ─── Step 3: Security Review ────────────────────────────

const PROFILES = [
  {
    id: "restricted",
    name: "Restricted",
    description:
      "Read-only tools only. All terminal commands blocked. Best for reviewing code safely.",
    icon: "🔒",
  },
  {
    id: "standard",
    name: "Standard",
    description:
      "All tools enabled. Dangerous terminal commands blocked. Recommended for most users.",
    icon: "🛡️",
  },
  {
    id: "trusted",
    name: "Trusted",
    description:
      "All tools with auto-approve. Only catastrophic commands blocked. For experienced users in trusted environments.",
    icon: "⚡",
  },
];

interface SecurityStepProps {
  onComplete: (step: number, data: Record<string, unknown>) => void;
  stepCompleting: boolean;
}

const SecurityStep: React.FC<SecurityStepProps> = ({ onComplete, stepCompleting }) => {
  const [selectedProfile, setSelectedProfile] = useState("standard");

  return (
    <>
      <StepTitle>Security Profile</StepTitle>
      <StepSubtitle>
        Choose how much autonomy CodeBuddy has in your workspace. You can change
        this anytime in settings.
      </StepSubtitle>

      <CardGrid>
        {PROFILES.map((p) => (
          <SecurityProfile
            key={p.id}
            $selected={selectedProfile === p.id}
            onClick={() => setSelectedProfile(p.id)}
          >
            <ProfileName>
              {p.icon} {p.name}
              {selectedProfile === p.id && (
                <StatusBadge $variant="info" style={{ marginLeft: 8 }}>
                  Selected
                </StatusBadge>
              )}
            </ProfileName>
            <ProfileDescription>{p.description}</ProfileDescription>
          </SecurityProfile>
        ))}
      </CardGrid>

      <PrimaryButton
        onClick={() =>
          !stepCompleting && onComplete(3, { permissionProfile: selectedProfile })
        }
        disabled={stepCompleting}
        style={{ marginTop: 16 }}
        aria-label="Apply security profile"
      >
        {stepCompleting ? "Applying..." : "Apply Security Profile"}
      </PrimaryButton>
    </>
  );
};

// ─── Step 4: First Task ─────────────────────────────────

interface FirstTaskStepProps {
  suggestedTasks: SuggestedTask[];
  onDismiss: () => void;
}

const TASK_ICONS = ["📊", "🔍", "🐛", "📦", "📝", "🧪"];

const FirstTaskStep: React.FC<FirstTaskStepProps> = ({
  suggestedTasks,
  onDismiss,
}) => {
  const handleTaskClick = useCallback(
    (prompt: string) => {
      // Send the prompt to the chat and close the wizard
      vscode.postMessage({ command: "codebuddy-message", message: prompt });
      onDismiss();
    },
    [onDismiss],
  );

  return (
    <>
      <StepTitle>You&apos;re All Set! 🎉</StepTitle>
      <StepSubtitle>
        CodeBuddy is ready. Try one of these to get started, or just start
        typing in the chat.
      </StepSubtitle>

      <CardGrid>
        {suggestedTasks.map((task, i) => (
          <TaskCard key={task.label} onClick={() => handleTaskClick(task.prompt)}>
            <TaskIcon>{TASK_ICONS[i % TASK_ICONS.length]}</TaskIcon>
            <TaskLabel>{task.label}</TaskLabel>
          </TaskCard>
        ))}
      </CardGrid>
    </>
  );
};
