import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import styled, { keyframes } from "styled-components";
import {
  WelcomeHero,
  WelcomeLogo,
  WelcomeSubtitle as OnboardingSubtitle,
  FeatureList,
  FeatureItem,
  FeatureIcon,
  FeatureText,
} from "./onboarding/styles";
import {
  CodeBuddyLogo,
  ChatBubbleIcon,
  SearchIcon,
  LockIcon,
  GlobeIcon,
  WrenchIcon,
  RefreshIcon,
} from "./onboarding/icons";

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

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ username }) => {
  const { t } = useTranslation();
  const [displayedText, setDisplayedText] = useState("");
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
        <OnboardingSubtitle>
          {t("welcome.subtitle")}
        </OnboardingSubtitle>
        <FeatureList>
          <FeatureItem>
            <FeatureIcon><ChatBubbleIcon /></FeatureIcon>
            <FeatureText>
              <strong>{t("welcome.featureAgentMode")}</strong>
              {t("welcome.featureAgentModeDesc")}
            </FeatureText>
          </FeatureItem>
          <FeatureItem>
            <FeatureIcon><SearchIcon /></FeatureIcon>
            <FeatureText>
              <strong>{t("welcome.featureAskMode")}</strong>
              {t("welcome.featureAskModeDesc")}
            </FeatureText>
          </FeatureItem>
          <FeatureItem>
            <FeatureIcon><GlobeIcon /></FeatureIcon>
            <FeatureText>
              <strong>{t("welcome.featureProviders")}</strong>
              {t("welcome.featureProvidersDesc")}
            </FeatureText>
          </FeatureItem>
          <FeatureItem>
            <FeatureIcon><LockIcon /></FeatureIcon>
            <FeatureText>
              <strong>{t("welcome.featureDiffReview")}</strong>
              {t("welcome.featureDiffReviewDesc")}
            </FeatureText>
          </FeatureItem>
          <FeatureItem>
            <FeatureIcon><WrenchIcon /></FeatureIcon>
            <FeatureText>
              <strong>{t("welcome.featureMCP")}</strong>
              {t("welcome.featureMCPDesc")}
            </FeatureText>
          </FeatureItem>
          <FeatureItem>
            <FeatureIcon><RefreshIcon /></FeatureIcon>
            <FeatureText>
              <strong>{t("welcome.featureMentions")}</strong>
              {t("welcome.featureMentionsDesc")}
            </FeatureText>
          </FeatureItem>
        </FeatureList>
      </WelcomeHero>
    </WelcomeContainer>
  );
};