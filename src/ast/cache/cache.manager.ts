/**
 * Cache Manager
 *
 * Manages LRU cache for parsed AST trees with proper disposal.
 */

import { LRUCache } from "lru-cache";
import Parser from "web-tree-sitter";
import * as vscode from "vscode";
import { IParsedFile } from "../query-types";

interface CacheEntry {
  tree: Parser.Tree;
  language: string;
  content: string;
}

export class CacheManager {
  private static instance: CacheManager | null = null;
  private cache: LRUCache<string, CacheEntry>;
  private hits = 0;
  private misses = 0;

  private constructor(
    private outputChannel: vscode.OutputChannel,
    maxSize = 50,
  ) {
    this.cache = new LRUCache<string, CacheEntry>({
      max: maxSize,
      dispose: (value) => {
        if (value?.tree) {
          try {
            value.tree.delete();
          } catch (error) {
            this.outputChannel.appendLine(
              `Warning: Failed to dispose tree: ${error}`,
            );
          }
        }
      },
    });
  }

  static getInstance(
    outputChannel: vscode.OutputChannel,
    maxSize?: number,
  ): CacheManager {
    if (!CacheManager.instance) {
      CacheManager.instance = new CacheManager(outputChannel, maxSize);
    }
    return CacheManager.instance;
  }

  /**
   * Gets cached AST if available and content hasn't changed
   */
  async get(
    filePath: string,
    currentContent: string,
  ): Promise<IParsedFile | null> {
    const cached = this.cache.get(filePath);
    if (!cached) {
      this.misses++;
      return null;
    }

    // Check if content has changed
    if (cached.content !== currentContent) {
      this.outputChannel.appendLine(
        `Content changed for ${filePath}. Cache invalidated.`,
      );
      this.misses++;
      this.invalidate(filePath);
      return null;
    }

    this.hits++;
    return {
      tree: cached.tree,
      language: cached.language,
      content: cached.content,
      filePath,
    };
  }

  /**
   * Stores parsed AST in cache
   */
  set(filePath: string, parsedFile: IParsedFile): void {
    this.cache.set(filePath, {
      tree: parsedFile.tree,
      language: parsedFile.language,
      content: parsedFile.content,
    });
  }

  /**
   * Invalidates cache entry for a file
   */
  invalidate(filePath: string): void {
    const cached = this.cache.get(filePath);
    if (cached?.tree) {
      try {
        cached.tree.delete();
      } catch (error) {
        this.outputChannel.appendLine(
          `Warning: Failed to delete tree for ${filePath}: ${error}`,
        );
      }
    }
    this.cache.delete(filePath);
  }

  /**
   * Checks if file is cached
   */
  has(filePath: string): boolean {
    return this.cache.has(filePath);
  }

  /**
   * Gets current cache size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Clears entire cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Returns cache hit/miss statistics.
   */
  getStats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Resets hit/miss counters — call periodically or after a clear().
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Disposes all resources
   */
  dispose(): void {
    this.clear();
    CacheManager.instance = null;
  }
}
