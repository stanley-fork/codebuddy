/**
 * Enhanced Cache Manager Tests
 *
 * Tests: instanceName trimming and default fallback.
 */

import * as assert from "assert";
import * as sinon from "sinon";
import { EnhancedCacheManager } from "../../services/enhanced-cache-manager.service";

suite("EnhancedCacheManager", () => {
  let manager: EnhancedCacheManager;

  teardown(() => {
    if (manager) manager.dispose();
    sinon.restore();
  });

  test("uses provided instanceName", () => {
    manager = new EnhancedCacheManager({}, undefined, "vectorDB");
    assert.strictEqual((manager as any).instanceName, "vectorDB");
  });

  test("trims whitespace from instanceName", () => {
    manager = new EnhancedCacheManager({}, undefined, "  padded  ");
    assert.strictEqual((manager as any).instanceName, "padded");
  });

  test("falls back to 'default' when instanceName is empty string", () => {
    manager = new EnhancedCacheManager({}, undefined, "");
    assert.strictEqual((manager as any).instanceName, "default");
  });

  test("falls back to 'default' when instanceName is whitespace only", () => {
    manager = new EnhancedCacheManager({}, undefined, "   ");
    assert.strictEqual((manager as any).instanceName, "default");
  });

  test("falls back to 'default' when instanceName is omitted", () => {
    manager = new EnhancedCacheManager({});
    assert.strictEqual((manager as any).instanceName, "default");
  });

  test("applies config.maxSize to stats.maxSize", () => {
    manager = new EnhancedCacheManager({ maxSize: 500 });
    const stats = manager.getStats();
    assert.strictEqual(stats.maxSize, 500);
  });
});
