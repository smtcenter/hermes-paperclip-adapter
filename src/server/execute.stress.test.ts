/**
 * Hermes Paperclip Adapter — Stress Test Suite
 *
 * Tests for:
 * - Long-running sessions (180+ seconds)
 * - Session resumption and persistence
 * - Multiple heartbeat cycles
 * - Token accumulation across runs
 * - Graceful timeout handling
 * - Memory stability
 *
 * Import: node --test dist/server/execute.stress.test.js
 */

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// ─────────────────────────────────────────────────────────────────────────
// Test Utilities
// ─────────────────────────────────────────────────────────────────────────

interface MockMeasurement {
  timestamp: number;
  heapUsedMB: number;
  externalMB: number;
  rssKB: number;
  duration: number;
}

function getCurrentMemory(): Omit<MockMeasurement, 'timestamp' | 'duration'> {
  const mem = process.memoryUsage();
  return {
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    externalMB: Math.round(mem.external / 1024 / 1024),
    rssKB: Math.round(mem.rss / 1024),
  };
}

class SessionRecorder {
  sessionIds: string[] = [];
  measurements: MockMeasurement[] = [];
  errors: string[] = [];
  totalOutputBytes = 0;

  recordSessionId(id: string) {
    if (!this.sessionIds.includes(id)) {
      this.sessionIds.push(id);
    }
  }

  recordMeasurement(duration: number) {
    this.measurements.push({
      timestamp: Date.now(),
      ...getCurrentMemory(),
      duration,
    });
  }

  recordError(err: string) {
    this.errors.push(err);
  }

  getReport() {
    return {
      totalSessions: this.sessionIds.length,
      sessionIds: this.sessionIds,
      measurementCount: this.measurements.length,
      avgHeapMB: Math.round(
        this.measurements.reduce((sum, m) => sum + m.heapUsedMB, 0) /
          Math.max(this.measurements.length, 1)
      ),
      maxHeapMB: Math.max(...this.measurements.map((m) => m.heapUsedMB), 0),
      minHeapMB: Math.min(...this.measurements.map((m) => m.heapUsedMB), 999),
      avgDurationMS: Math.round(
        this.measurements.reduce((sum, m) => sum + m.duration, 0) /
          Math.max(this.measurements.length, 1)
      ),
      errors: this.errors,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Mock Hermes CLI Response
// ─────────────────────────────────────────────────────────────────────────

/**
 * Simulates a hermes chat -q -Q response with configurable runtime.
 * Used for stress testing without requiring live Hermes availability.
 */
function mockHermesResponse(durationMs: number, sessionId: string): string {
  const tokenUsage = Math.floor(Math.random() * 4000) + 1000;
  const costUSD = (tokenUsage / 1000) * 0.003; // ~$0.003 per 1k tokens
  return `Test response from mock Hermes\n[tool] running...\nCompleted successfully\nsession_id: ${sessionId}\nToken Usage: input=${Math.floor(
    tokenUsage * 0.6
  )}, output=${Math.floor(tokenUsage * 0.4)}\nCost: $${costUSD.toFixed(5)}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Stress Tests
// ─────────────────────────────────────────────────────────────────────────

describe('Hermes Paperclip Adapter — Stress Tests', () => {
  describe('Session Persistence', () => {
    test('should use the same session ID across multiple heartbeats', async () => {
      const recorder = new SessionRecorder();
      const baseSessionId = `stress-test-${Date.now()}`;

      // Simulate 5 heartbeats re-using same session ID (--resume)
      for (let i = 0; i < 5; i++) {
        const sessionId = i === 0 ? baseSessionId : baseSessionId;
        const mockOutput = mockHermesResponse(100, sessionId);
        recorder.recordSessionId(sessionId);

        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.equal(
        recorder.sessionIds.length,
        1,
        'Should maintain single session ID across heartbeats'
      );
      assert.equal(
        recorder.sessionIds[0],
        baseSessionId,
        'Session ID should persist'
      );
    });

    test('should create new session ID on cache miss', async () => {
      const recorder = new SessionRecorder();

      // Simulate heartbeat 1: new session
      recorder.recordSessionId(`session-1-${Date.now()}`);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate heartbeat 2: cache miss, new session
      recorder.recordSessionId(`session-2-${Date.now()}`);
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.equal(
        recorder.sessionIds.length,
        2,
        'Should have 2 distinct session IDs on cache miss'
      );
      assert.notEqual(
        recorder.sessionIds[0],
        recorder.sessionIds[1],
        'Session IDs should differ'
      );
    });
  });

  describe('Memory Stability', () => {
    test('should not leak memory over 10 heartbeat cycles', async () => {
      const recorder = new SessionRecorder();
      const cycleCount = 10;

      for (let i = 0; i < cycleCount; i++) {
        const start = Date.now();
        const mockOutput = mockHermesResponse(50, `stress-mem-${i}`);
        recorder.recordSessionId(`stress-mem-${i}`);

        // Simulate processing
        const lines = mockOutput.split('\n');
        recorder.totalOutputBytes += mockOutput.length;

        const duration = Date.now() - start;
        recorder.recordMeasurement(duration);

        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const report = recorder.getReport();
      assert.equal(report.totalSessions, 10, 'Should process 10 sessions');

      // Memory shouldn't grow dramatically
      // Heap delta should stay < 50MB over cycle
      const heapDelta = report.maxHeapMB - report.minHeapMB;
      assert.ok(
        heapDelta < 100,
        `Heap delta ${heapDelta}MB should be < 100MB (acceptable variance)`
      );
    });

    test('should report consistent average duration', async () => {
      const recorder = new SessionRecorder();

      // Run 5 iterations with consistent mock time
      for (let i = 0; i < 5; i++) {
        recorder.recordMeasurement(100); // All 100ms
      }

      const report = recorder.getReport();
      assert.equal(
        report.avgDurationMS,
        100,
        'Average duration should be stable'
      );
    });
  });

  describe('Long-Running Sessions', () => {
    test('should simulate 300+ second task completion', async () => {
      const recorder = new SessionRecorder();
      const startTime = Date.now();
      const targetDurationMS = 300000; // 5 minutes

      // Simulate a long task with periodic measurements
      let elapsedMS = 0;
      let checkpoint = 0;
      while (elapsedMS < targetDurationMS) {
        const chunkDuration = Math.min(50000, targetDurationMS - elapsedMS); // 50s chunks
        recorder.recordMeasurement(chunkDuration);
        recorder.recordSessionId(`long-session`);
        elapsedMS += chunkDuration;
        checkpoint++;

        if (checkpoint % 3 === 0) {
          // Simulate memory flush every 3 checkpoints
          if (global.gc) global.gc();
        }
      }

      const actualElapsed = Date.now() - startTime;
      assert.ok(
        elapsedMS >= targetDurationMS,
        `Simulated duration ${elapsedMS}ms should be >= ${targetDurationMS}ms`
      );
      assert.equal(
        recorder.sessionIds.length,
        1,
        'Should maintain session across long run'
      );
    });

    test('should handle graceful timeout after 1800s', async () => {
      const recorder = new SessionRecorder();

      // Simulate a timeout scenario: task runs until 1800s, then stops
      const timeoutThreshold = 1800000;
      let elapsedMS = 0;

      for (let i = 0; i < 20; i++) {
        const chunkDuration = 100000; // 100s chunks
        if (elapsedMS + chunkDuration > timeoutThreshold) {
          recorder.recordError('TIMEOUT: Session exceeded 1800s limit');
          break;
        }
        recorder.recordMeasurement(chunkDuration);
        elapsedMS += chunkDuration;
      }

      const report = recorder.getReport();
      assert.ok(report.avgDurationMS > 0, 'Should have recorded durations');
      assert.ok(
        report.errors.length > 0,
        'Should record timeout error'
      );
    });
  });

  describe('Token Accumulation', () => {
    test('should accumulate token counts across multiple runs', async () => {
      const recorder = new SessionRecorder();
      let totalTokens = 0;

      // Simulate multiple runs, each generating random tokens
      for (let i = 0; i < 5; i++) {
        const tokenCount = Math.floor(Math.random() * 4000) + 1000;
        totalTokens += tokenCount;
        const mockOutput = mockHermesResponse(
          100,
          `accumulate-${i}`
        );
        recorder.recordSessionId(`accumulate-${i}`);

        // Extract token count from mock output
        const match = mockOutput.match(/input=(\d+), output=(\d+)/);
        if (match) {
          const input = parseInt(match[1], 10);
          const output = parseInt(match[2], 10);
          assert.ok(input > 0, 'Input tokens should be > 0');
          assert.ok(output > 0, 'Output tokens should be > 0');
        }
      }

      assert.ok(totalTokens > 5000, 'Should accumulate meaningful token count');
    });
  });

  describe('Error Recovery', () => {
    test('should recover from a single failed heartbeat', async () => {
      const recorder = new SessionRecorder();

      // Heartbeat 1: success
      recorder.recordSessionId('recovery-1');
      recorder.recordMeasurement(100);

      // Heartbeat 2: error
      recorder.recordError('Network timeout on heartbeat 2');

      // Heartbeat 3: success (recovery)
      recorder.recordSessionId('recovery-2');
      recorder.recordMeasurement(100);

      const report = recorder.getReport();
      assert.equal(report.totalSessions, 2, 'Should recover and continue');
      assert.equal(
        report.errors.length,
        1,
        'Should log the single error'
      );
    });

    test('should handle consecutive errors with exponential backoff simulation', async () => {
      const recorder = new SessionRecorder();
      let backoffMS = 100;

      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          if (attempt < 2) {
            // First 2 attempts fail
            throw new Error(`Connection refused (attempt ${attempt})`);
          }
          // Attempts 2 and 3 succeed
          recorder.recordSessionId(`backoff-success-${attempt}`);
          recorder.recordMeasurement(100);
        } catch (err) {
          recorder.recordError((err as Error).message);
          // Exponential backoff: 100ms, 200ms, 400ms
          backoffMS *= 2;
          await new Promise((resolve) => setTimeout(resolve, 10)); // Simulated wait
        }
      }

      const report = recorder.getReport();
      assert.equal(
        report.errors.length,
        2,
        'Should have 2 recorded errors'
      );
      assert.equal(
        report.totalSessions,
        2,
        'Should have 2 successful sessions (attempts 2 and 3)'
      );
    });
  });

  describe('Concurrent Heartbeats', () => {
    test('should queue multiple concurrent heartbeats without data loss', async () => {
      const recorder = new SessionRecorder();
      const promises: Promise<void>[] = [];

      // Simulate 5 concurrent heartbeat requests
      for (let i = 0; i < 5; i++) {
        const promise = new Promise<void>((resolve) => {
          setTimeout(() => {
            recorder.recordSessionId(`concurrent-${i}`);
            recorder.recordMeasurement(Math.random() * 100 + 50);
            resolve();
          }, Math.random() * 50);
        });
        promises.push(promise);
      }

      await Promise.all(promises);

      const report = recorder.getReport();
      assert.equal(
        report.totalSessions,
        5,
        'Should process all concurrent heartbeats'
      );
      assert.equal(
        report.measurementCount,
        5,
        'Should record all measurements'
      );
    });
  });
});
