import * as vscode from "vscode";
import { Logger } from "../infrastructure/logger/logger";
import { SqliteDatabaseService } from "./sqlite-database.service";

export enum NotificationSource {
  System = "System",
  Commands = "Commands",
  Git = "Git",
  Chat = "Chat",
  MCP = "MCP",
  ModelManager = "Model Manager",
  Workspace = "Workspace",
  GitLab = "GitLab",
  Jira = "Jira",
  PRReview = "PR Review",
  Agent = "Agent",
}

export interface NotificationItem {
  id: number;
  type: "info" | "warning" | "error" | "success";
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  source?: string;
}

export class NotificationService {
  private static instance: NotificationService;
  private logger: Logger;
  private dbService: SqliteDatabaseService;
  private _onDidNotificationChange = new vscode.EventEmitter<void>();
  public readonly onDidNotificationChange = this._onDidNotificationChange.event;

  // Dedup: track recent notifications to prevent duplicates within a time window
  private static readonly DEDUP_WINDOW_MS = 30_000; // 30 seconds
  private static readonly DEDUP_MAP_MAX_SIZE = 200;
  private static readonly MAX_STORED_NOTIFICATIONS = 500;
  private static readonly PRUNE_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
  private recentNotifications = new Map<string, number>();
  private lastPruneTime = 0;

  private constructor() {
    this.logger = Logger.initialize("NotificationService", {});
    this.dbService = SqliteDatabaseService.getInstance();
  }

  public static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  /**
   * Add a new notification
   */
  public async addNotification(
    type: "info" | "warning" | "error" | "success",
    title: string,
    message: string,
    source: NotificationSource = NotificationSource.System,
  ): Promise<void> {
    // Deduplicate: skip if the same type+title was added within the window
    const dedupKey = `${type}:${title}`;
    const now = Date.now();
    const lastSeen = this.recentNotifications.get(dedupKey);
    if (lastSeen && now - lastSeen < NotificationService.DEDUP_WINDOW_MS) {
      return; // duplicate within window — suppress
    }
    this.recentNotifications.set(dedupKey, now);

    // Prune stale dedup entries when approaching the cap
    if (
      this.recentNotifications.size > NotificationService.DEDUP_MAP_MAX_SIZE
    ) {
      for (const [key, ts] of this.recentNotifications) {
        if (now - ts >= NotificationService.DEDUP_WINDOW_MS) {
          this.recentNotifications.delete(key);
        }
      }
    }

    try {
      await this.dbService.initialize();
      this.dbService.executeSqlCommand(
        `INSERT INTO notifications (type, title, message, source, read_status, timestamp) 
         VALUES (?, ?, ?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        [type, title, message, source],
      );
      await this.maybePruneNotifications();
      this.logger.info(`Added notification: ${title}`);
      this._onDidNotificationChange.fire();
    } catch (error) {
      this.logger.error("Failed to add notification", error);
    }
  }

  /**
   * Prune old notification rows from the DB, gated by an interval to avoid per-insert scans.
   */
  private async maybePruneNotifications(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPruneTime < NotificationService.PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastPruneTime = now;
    try {
      const results = this.dbService.executeSql(
        `SELECT COUNT(*) as count FROM notifications`,
      );
      // Coerce explicitly: SQLite COUNT may return number or bigint depending on driver
      const totalCount = Number(results[0]?.count ?? 0);
      const excess = totalCount - NotificationService.MAX_STORED_NOTIFICATIONS;
      if (excess <= 0) {
        return;
      }
      this.dbService.executeSqlCommand(
        `DELETE FROM notifications
         WHERE id IN (
           SELECT id FROM notifications
           ORDER BY timestamp ASC
           LIMIT ?
         )`,
        [excess],
      );
      this.logger.debug(
        `Pruned ${excess} old notifications (was ${totalCount})`,
      );
    } catch (pruneError) {
      this.logger.warn("Failed to prune old notifications", pruneError);
    }
  }

  /**
   * Get all notifications
   */
  public async getNotifications(limit = 50): Promise<NotificationItem[]> {
    try {
      await this.dbService.initialize();
      const results = this.dbService.executeSql(
        `SELECT * FROM notifications ORDER BY timestamp DESC LIMIT ?`,
        [limit],
      );

      return results.map((row: any) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        message: row.message,
        timestamp: row.timestamp,
        read: row.read_status === 1,
        source: row.source,
      }));
    } catch (error) {
      this.logger.error("Failed to get notifications", error);
      return [];
    }
  }

  /**
   * Get unread notifications count
   */
  public async getUnreadCount(): Promise<number> {
    try {
      await this.dbService.initialize();
      const results = this.dbService.executeSql(
        `SELECT COUNT(*) as count FROM notifications WHERE read_status = 0`,
      );
      return results[0]?.count || 0;
    } catch (error) {
      this.logger.error("Failed to get unread count", error);
      return 0;
    }
  }

  /**
   * Mark a notification as read
   */
  public async markAsRead(id: number): Promise<void> {
    try {
      await this.dbService.initialize();
      this.dbService.executeSqlCommand(
        `UPDATE notifications SET read_status = 1 WHERE id = ?`,
        [id],
      );
      this._onDidNotificationChange.fire();
    } catch (error) {
      this.logger.error(`Failed to mark notification ${id} as read`, error);
    }
  }

  /**
   * Mark all notifications as read
   */
  public async markAllAsRead(): Promise<void> {
    try {
      await this.dbService.initialize();
      this.dbService.executeSqlCommand(
        `UPDATE notifications SET read_status = 1 WHERE read_status = 0`,
      );
      this._onDidNotificationChange.fire();
    } catch (error) {
      this.logger.error("Failed to mark all notifications as read", error);
    }
  }

  /**
   * Delete a single notification
   */
  public async deleteNotification(id: number): Promise<void> {
    try {
      await this.dbService.initialize();
      this.dbService.executeSqlCommand(
        `DELETE FROM notifications WHERE id = ?`,
        [id],
      );
      this._onDidNotificationChange.fire();
    } catch (error) {
      this.logger.error(`Failed to delete notification ${id}`, error);
    }
  }

  /**
   * Clear all notifications
   */
  public async clearAll(): Promise<void> {
    try {
      await this.dbService.initialize();
      this.dbService.executeSqlCommand(`DELETE FROM notifications`);
      this._onDidNotificationChange.fire();
    } catch (error) {
      this.logger.error("Failed to clear notifications", error);
    }
  }
}
