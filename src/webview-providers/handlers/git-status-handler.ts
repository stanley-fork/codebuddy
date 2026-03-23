import { WebviewMessageHandler, HandlerContext } from "./types";
import { GitActions, BranchInfo } from "../../services/git-actions";

const GIT_COMMANDS = ["git-status-request"] as const;

function isGitMessage(
  msg: unknown,
): msg is { command: (typeof GIT_COMMANDS)[number] } {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "command" in msg &&
    typeof (msg as Record<string, unknown>).command === "string" &&
    GIT_COMMANDS.includes(
      (msg as Record<string, unknown>).command as (typeof GIT_COMMANDS)[number],
    )
  );
}

export class GitStatusHandler implements WebviewMessageHandler {
  readonly commands = [...GIT_COMMANDS];

  async handle(
    message: Record<string, unknown>,
    ctx: HandlerContext,
  ): Promise<void> {
    if (!isGitMessage(message)) return;

    try {
      const git = new GitActions();
      const [branchInfo, status] = await Promise.all([
        git.getCurrentBranchInfo(),
        git.getRepositoryStatus(),
      ]);

      const changedFiles: number =
        (status.modified?.length ?? 0) +
        (status.not_added?.length ?? 0) +
        (status.created?.length ?? 0) +
        (status.deleted?.length ?? 0) +
        (status.renamed?.length ?? 0);

      const staged: number = status.staged?.length ?? 0;

      await ctx.webview.webview.postMessage({
        type: "git-status-result",
        branch: branchInfo.current,
        upstream: branchInfo.upstream ?? null,
        changedFiles,
        staged,
        ahead: status.ahead ?? 0,
        behind: status.behind ?? 0,
      });
    } catch {
      await ctx.webview.webview.postMessage({
        type: "git-status-result",
        branch: null,
        upstream: null,
        changedFiles: 0,
        staged: 0,
        ahead: 0,
        behind: 0,
      });
    }
  }
}
