import React, { useEffect, useState, useCallback } from "react";
import {
  useOnboardingStore,
  type ProviderInfo,
  type ProjectInfo,
  type SuggestedTask,
  type OnboardingStep,
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

// ─── Step Order ─────────────────────────────────────────

const STEPS: OnboardingStep[] = [
  "welcome",
  "provider",
  "workspace",
  "security",
  "firstTask",
];

const STEP_LABELS: Record<OnboardingStep, string> = {
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
    nextStep,
    prevStep,
    skip,
    dismiss,
    completeStep,
    testProvider,
  } = useOnboardingStore();

  if (!isVisible) return null;

  const stepIdx = STEPS.indexOf(currentStep);
  const isFirstStep = stepIdx === 0;
  const isLastStep = stepIdx === STEPS.length - 1;

  return (
    <Overlay>
      <WizardContainer>
        <WizardHeader>
          <StepIndicator>
            {STEPS.map((s, i) => (
              <StepDot
                key={s}
                $active={i === stepIdx}
                $completed={i < stepIdx}
                title={STEP_LABELS[s]}
              />
            ))}
          </StepIndicator>
          <SkipButton onClick={skip}>Skip setup</SkipButton>
        </WizardHeader>

        <StepContent key={currentStep}>
          {currentStep === "welcome" && <WelcomeStep />}
          {currentStep === "provider" && (
            <ProviderStep
              providers={providers}
              isTestingProvider={isTestingProvider}
              testResult={testResult}
              onTestProvider={testProvider}
              onComplete={completeStep}
            />
          )}
          {currentStep === "workspace" && (
            <WorkspaceStep
              projectInfo={projectInfo}
              onComplete={completeStep}
            />
          )}
          {currentStep === "security" && (
            <SecurityStep onComplete={completeStep} />
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
            <SecondaryButton onClick={prevStep}>Back</SecondaryButton>
          ) : (
            <div />
          )}
          {!isLastStep ? (
            <PrimaryButton onClick={nextStep}>
              {currentStep === "welcome" ? "Get Started" : "Next"}
            </PrimaryButton>
          ) : (
            <PrimaryButton onClick={dismiss}>
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
  onTestProvider: (provider: string, apiKey?: string) => void;
  onComplete: (step: number, data: Record<string, unknown>) => void;
}

const ProviderStep: React.FC<ProviderStepProps> = ({
  providers,
  isTestingProvider,
  testResult,
  onTestProvider,
  onComplete,
}) => {
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [apiKey, setApiKey] = useState("");

  const handleProviderSelect = useCallback((id: string) => {
    setSelectedProvider(id);
    setApiKey("");
  }, []);

  const handleSave = useCallback(() => {
    if (selectedProvider && apiKey) {
      onComplete(1, { provider: selectedProvider, apiKey });
    }
  }, [selectedProvider, apiKey, onComplete]);

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
            />
            <PrimaryButton
              onClick={() => onTestProvider(selectedProvider, apiKey)}
              disabled={!apiKey || isTestingProvider}
              style={{ flexShrink: 0 }}
            >
              {isTestingProvider ? "Testing..." : "Test"}
            </PrimaryButton>
          </div>
          {testResult && testResult.provider === selectedProvider && (
            <div style={{ marginTop: 8 }}>
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
              style={{ marginTop: 12, width: "100%" }}
            >
              Save & Set as Active Provider
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
}

const WorkspaceStep: React.FC<WorkspaceStepProps> = ({
  projectInfo,
  onComplete,
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
        onClick={() => onComplete(2, { createRules })}
        style={{ marginTop: 12 }}
      >
        Apply Configuration
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
      "All tools with auto-approve. Only catastrophic commands blocked. For experienced users in  trusted environments.",
    icon: "⚡",
  },
];

interface SecurityStepProps {
  onComplete: (step: number, data: Record<string, unknown>) => void;
}

const SecurityStep: React.FC<SecurityStepProps> = ({ onComplete }) => {
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
          onComplete(3, { permissionProfile: selectedProfile })
        }
        style={{ marginTop: 16 }}
      >
        Apply Security Profile
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
