import * as vscode from "vscode";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as net from "net";
import { Logger, LogLevel } from "../../infrastructure/logger/logger";
import { Terminal } from "../../utils/terminal";

export interface DockerModel {
  name: string;
  size?: string;
  id?: string;
}

export class DockerModelService implements vscode.Disposable {
  private static instance: DockerModelService;
  private readonly logger: Logger;
  private readonly terminal: Terminal;

  // Cache Docker daemon availability to avoid repeated spawn failures
  private dockerDaemonAvailable: boolean | null = null;
  private lastDaemonCheck = 0;
  private static readonly DAEMON_CHECK_COOLDOWN_MS = 60_000; // Re-check at most once per minute

  constructor() {
    this.logger = Logger.initialize(DockerModelService.name, {
      minLevel: LogLevel.INFO,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: true,
    });
    this.terminal = Terminal.getInstance();
  }

  static getInstance(): DockerModelService {
    return (DockerModelService.instance ??= new DockerModelService());
  }

  /**
   * Check if Docker daemon is reachable. Caches result to avoid repeated spawn failures.
   */
  private async isDockerDaemonAvailable(): Promise<boolean> {
    const now = Date.now();
    if (
      this.dockerDaemonAvailable !== null &&
      now - this.lastDaemonCheck < DockerModelService.DAEMON_CHECK_COOLDOWN_MS
    ) {
      return this.dockerDaemonAvailable;
    }

    this.dockerDaemonAvailable = await this.probeDockerSocket();
    this.lastDaemonCheck = Date.now();
    return this.dockerDaemonAvailable;
  }

  /**
   * Probe the Docker socket directly without spawning a process.
   * Returns true if the daemon socket is connectable.
   */
  private async probeDockerSocket(): Promise<boolean> {
    const socketPath =
      process.platform === "win32"
        ? "\\\\.\\pipe\\docker_engine"
        : (process.env.DOCKER_HOST?.replace("unix://", "") ??
          "/var/run/docker.sock");

    // Non-blocking existence check on Unix
    if (process.platform !== "win32") {
      try {
        await fsp.access(socketPath, fs.constants.R_OK);
      } catch {
        return false;
      }
    }

    return new Promise((resolve) => {
      const socket = net.createConnection({ path: socketPath });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 1000);

      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  /**
   * Reset cached daemon status (e.g. when user explicitly retries).
   */
  resetDaemonCache(): void {
    this.dockerDaemonAvailable = null;
    this.lastDaemonCheck = 0;
  }

  async checkModelRunnerAvailable(): Promise<boolean> {
    try {
      return await this.terminal.checkDockerModelRunner();
    } catch (e) {
      this.logger.error("Failed to check Docker Model Runner", e);
      return false;
    }
  }

  async enableModelRunner(): Promise<{ success: boolean; error?: string }> {
    this.logger.info("Enabling Docker Model Runner...");
    try {
      await this.terminal.enableDockerModelRunner();
      return { success: true };
    } catch (e) {
      this.logger.error("Failed to enable Docker Model Runner", e);
      let errorMessage = e instanceof Error ? e.message : String(e);

      // Check for specific CLI errors indicating the command is not supported
      if (
        errorMessage.includes("unknown flag: --tcp") ||
        errorMessage.includes("is not a docker command") ||
        errorMessage.includes("unknown command") ||
        errorMessage.includes("exit code 125")
      ) {
        errorMessage =
          "CLI enablement failed. Please enable 'Docker Model Runner' manually in Docker Desktop Settings -> Beta Features.";
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async checkOllamaRunning(): Promise<boolean> {
    // Centralized cache check — no duplicated cooldown logic
    const daemonUp = await this.isDockerDaemonAvailable();
    if (!daemonUp) return false;

    try {
      const output = await this.terminal.getRunningOllamaContainer();
      // output is JSON string or empty
      return output.trim().length > 0;
    } catch (e) {
      // Daemon was up during probe but failed now — invalidate cache
      const msg = String(e);
      if (
        msg.includes("docker.sock") ||
        msg.includes("connect:") ||
        msg.includes("exit code 1")
      ) {
        this.resetDaemonCache();
      }
      return false;
    }
  }

  async startComposeOllama(): Promise<{ success: boolean; error?: string }> {
    this.logger.info("Starting Ollama via Docker Compose...");
    try {
      await this.terminal.runDockerComposeUp();
      return { success: true };
    } catch (e) {
      this.logger.error("Failed to start Ollama via Docker Compose", e);
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async pullOllamaModel(
    modelName: string,
  ): Promise<{ success: boolean; error?: string }> {
    // Strip 'ai/' prefix if present for Ollama compatibility
    const sanitizedName = modelName.replace(/^ai\//, "");
    this.logger.info(
      `Pulling model into Ollama container: ${sanitizedName} (original: ${modelName})`,
    );
    try {
      await this.terminal.pullOllamaModel(sanitizedName);
      return { success: true };
    } catch (e) {
      this.logger.error(`Failed to pull model ${modelName} into Ollama`, e);
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async getModels(): Promise<DockerModel[]> {
    // Fast-path: skip all Docker daemon commands if daemon is known to be down
    const daemonUp = await this.isDockerDaemonAvailable();
    if (!daemonUp) {
      return [];
    }

    let runnerModels: DockerModel[] = [];
    const ollamaModels: DockerModel[] = [];

    // 1. Try to get models from Docker Model Runner
    try {
      const output = await this.terminal.getLocalModelList();
      try {
        const json = JSON.parse(output);
        if (Array.isArray(json)) {
          runnerModels = json.map((m: any) => ({
            name:
              m.Name || (m.Repository ? `${m.Repository}:${m.Tag}` : "Unknown"),
            size: m.Size,
            id: m.ID || m.ImageID,
          }));
        }
      } catch (e) {
        // Fallback to text parsing if needed, or just ignore invalid JSON
      }
    } catch (error) {
      // It's expected to fail if the Model Runner is not enabled/installed.
      // We log at debug level to avoid cluttering logs with "errors" that are normal states.
      // this.logger.debug("Docker Model Runner not available or failed to list models", error);
    }

    // 2. Try to get models from Ollama container
    try {
      const ollamaOutput = await this.terminal.getOllamaModels();
      // Parse ollama output (NAME ID SIZE MODIFIED)
      const lines = ollamaOutput.trim().split("\n");
      if (lines.length > 1) {
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].trim().split(/\s+/);
          if (parts.length >= 1) {
            ollamaModels.push({
              name: parts[0], // e.g. llama3:latest
              size: parts[2] || "Unknown",
              id: parts[1] || "Unknown",
            });
          }
        }
      }
    } catch (e) {
      // Ollama might not be running or no models
    }

    return [...runnerModels, ...ollamaModels];
  }

  async pullModel(
    modelName: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.logger.info(`Pulling model: ${modelName}`);
    try {
      await this.terminal.pullDockerModel(modelName);
      return { success: true };
    } catch (e) {
      this.logger.error(`Failed to pull model ${modelName}`, e);
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async deleteModel(
    modelName: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.logger.info(`Deleting model: ${modelName}`);
    try {
      await this.terminal.deleteDockerModel(modelName);
      return { success: true };
    } catch (e) {
      this.logger.error(`Failed to delete model ${modelName}`, e);
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  dispose() {
    // Cleanup if needed
  }
}
