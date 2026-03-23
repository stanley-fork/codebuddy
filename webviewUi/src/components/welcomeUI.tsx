import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import styled, { keyframes } from "styled-components";
import { WelcomeHero, WelcomeLogo } from "./onboarding/styles";
import { CodeBuddyLogo } from "./onboarding/icons";
import { useOnboardingStore } from "../stores/onboarding.store";

interface WelcomeScreenProps {
  username?: string;
  onGetStarted?: () => void;
}

const fadeIn = keyframes`
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

const WelcomeContainer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  padding: 40px 20px;
  animation: ${fadeIn} 0.4s ease-out;
`;

const GreetingTitle = styled.h1`
  font-size: 28px;
  font-weight: 700;
  color: var(--vscode-foreground, #cccccc);
  margin: 0 0 8px 0;
  letter-spacing: -0.5px;
  text-align: center;
`;

const Tagline = styled.p`
  font-size: 13px;
  color: var(--vscode-descriptionForeground, #999);
  margin: 0 0 24px 0;
  text-align: center;
  max-width: 380px;
  line-height: 1.5;
`;

const SetupCTA = styled.button`
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 6px;
  padding: 8px 20px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s ease;

  &:hover {
    background: var(--vscode-button-hoverBackground);
  }
`;

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ username }) => {
  const { t } = useTranslation();
  const [displayedText, setDisplayedText] = useState("");
  const isCompleted = useOnboardingStore((s) => s.isCompleted);
  const show = useOnboardingStore((s) => s.show);

  const greeting = username
    ? t("welcome.greetingWithName", { username })
    : t("welcome.greetingDefault");

  useEffect(() => {
    let currentIndex = 0;
    const interval = setInterval(() => {
      if (currentIndex <= greeting.length) {
        setDisplayedText(greeting.slice(0, currentIndex));
        currentIndex++;
      } else {
        clearInterval(interval);
      }
    }, 40);

    return () => clearInterval(interval);
  }, [greeting]);

  return (
    <WelcomeContainer>
      <WelcomeHero>
        <WelcomeLogo>
          <CodeBuddyLogo />
        </WelcomeLogo>
        <GreetingTitle>{displayedText}</GreetingTitle>
        <Tagline>{t("welcome.subtitle")}</Tagline>
        {!isCompleted && (
          <SetupCTA onClick={show}>
            {t("welcome.setupCTA")}
          </SetupCTA>
        )}
      </WelcomeHero>
    </WelcomeContainer>
  );
};