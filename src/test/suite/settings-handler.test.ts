/**
 * SettingsHandler Tests
 *
 * Tests: codebuddy-model-change-event handling and SETTING_MAP routing.
 */

import * as assert from "assert";
import * as sinon from "sinon";
import { SettingsHandler } from "../../webview-providers/handlers/settings-handler";

suite("SettingsHandler", () => {
  let handler: SettingsHandler;
  let orchestratorStub: { publish: sinon.SinonStub };

  setup(() => {
    orchestratorStub = { publish: sinon.stub() };
    handler = new SettingsHandler(
      orchestratorStub,
      { fsPath: "/test", scheme: "file" } as any,
    );
  });

  teardown(() => {
    sinon.restore();
  });

  test("commands list includes codebuddy-model-change-event", () => {
    assert.ok(
      handler.commands.includes("codebuddy-model-change-event"),
      "commands should include codebuddy-model-change-event",
    );
  });

  test("commands list includes all SETTING_MAP keys", () => {
    const expectedKeys = [
      "streaming-change-event",
      "compact-mode-change-event",
      "auto-approve-change-event",
      "allow-file-edits-change-event",
      "allow-terminal-change-event",
      "verbose-logging-change-event",
      "index-codebase-change-event",
      "context-window-change-event",
      "include-hidden-change-event",
      "max-file-size-change-event",
      "font-size-change-event",
      "font-family-change-event",
      "daily-standup-change-event",
      "code-health-change-event",
      "dependency-check-change-event",
      "git-watchdog-change-event",
      "end-of-day-summary-change-event",
    ];
    for (const key of expectedKeys) {
      assert.ok(
        handler.commands.includes(key),
        `commands should include ${key}`,
      );
    }
  });

  test("commands list includes special handlers", () => {
    const specialCommands = [
      "theme-change-event",
      "language-change-event",
      "nickname-change-event",
      "update-user-info",
      "updateConfiguration",
      "update-model-event",
      "reindex-workspace-event",
      "open-codebuddy-settings",
      "get-provider-health",
    ];
    for (const cmd of specialCommands) {
      assert.ok(
        handler.commands.includes(cmd),
        `commands should include ${cmd}`,
      );
    }
  });
});
