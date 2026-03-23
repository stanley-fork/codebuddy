import { useEffect } from "react";
import styled from "styled-components";
import { useGitStore } from "../stores/git.store";

const Bar = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #888);
  white-space: nowrap;
  overflow: hidden;
`;

const BranchName = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--vscode-foreground, #ccc);
  font-weight: 500;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const Badge = styled.span<{ $color?: string }>`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 5px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 500;
  background: ${(p) => p.$color ?? "rgba(255,255,255,0.08)"};
  color: var(--vscode-foreground, #ccc);
`;

const BranchIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

export function GitStatusBar() {
  const { branch, changedFiles, staged, ahead, behind, startPolling, stopPolling } =
    useGitStore();

  useEffect(() => {
    startPolling();
    return stopPolling;
  }, [startPolling, stopPolling]);

  if (!branch) return null;

  return (
    <Bar title={`Branch: ${branch}`}>
      <BranchName>
        <BranchIcon />
        {branch}
      </BranchName>
      {changedFiles > 0 && (
        <Badge $color="rgba(224,175,104,0.15)" title={`${changedFiles} changed file${changedFiles !== 1 ? "s" : ""}`}>
          {changedFiles}M
        </Badge>
      )}
      {staged > 0 && (
        <Badge $color="rgba(122,162,247,0.15)" title={`${staged} staged file${staged !== 1 ? "s" : ""}`}>
          {staged}S
        </Badge>
      )}
      {ahead > 0 && (
        <Badge $color="rgba(137,209,133,0.15)" title={`${ahead} commit${ahead !== 1 ? "s" : ""} ahead`}>
          ↑{ahead}
        </Badge>
      )}
      {behind > 0 && (
        <Badge $color="rgba(247,118,142,0.15)" title={`${behind} commit${behind !== 1 ? "s" : ""} behind`}>
          ↓{behind}
        </Badge>
      )}
    </Bar>
  );
}
