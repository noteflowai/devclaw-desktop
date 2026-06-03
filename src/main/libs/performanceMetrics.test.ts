import { expect, test, vi } from 'vitest';

import { CoworkIpcChannel } from '../../shared/cowork/constants';
import {
  getPerformanceSnapshot,
  markTimingValue,
  recordDbOperation,
  recordIpcSend,
  recordSettingsMetric,
  resetPerformanceMetricsForTesting,
  setDbSlowThresholdForTesting,
} from './performanceMetrics';

test('aggregates IPC payload metrics and session event rates', () => {
  resetPerformanceMetricsForTesting();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-02T00:00:00.000Z'));

  recordIpcSend({
    type: 'messageUpdate',
    sessionId: 'session-1',
    channel: CoworkIpcChannel.StreamMessageUpdate,
    payload: { sessionId: 'session-1', content: 'hello' },
    windowCount: 1,
  });
  recordIpcSend({
    type: 'message',
    sessionId: 'session-1',
    channel: CoworkIpcChannel.StreamMessage,
    payload: { sessionId: 'session-1', message: { id: 'm1', content: 'reply' } },
    windowCount: 2,
  });
  vi.setSystemTime(new Date('2026-06-02T00:00:01.000Z'));
  recordIpcSend({
    type: 'messageUpdate',
    sessionId: 'session-1',
    channel: CoworkIpcChannel.StreamMessageUpdate,
    payload: { sessionId: 'session-1', content: 'world' },
    windowCount: 1,
  });

  const snapshot = getPerformanceSnapshot();
  expect(snapshot.ipc.totalEvents).toBe(3);
  expect(snapshot.ipc.totalPayloadBytes).toBeGreaterThan(0);
  expect(snapshot.ipc.maxMessageUpdatePayloadBytes).toBeGreaterThan(0);
  expect(snapshot.ipc.byType.messageUpdate.count).toBe(2);
  expect(snapshot.ipc.byType.message.windowCount).toBe(2);
  expect(snapshot.ipc.sessions[0]).toMatchObject({
    sessionId: 'session-1',
    eventCount: 3,
    maxEventsPerSecond: 2,
  });

  vi.useRealTimers();
});

test('keeps the first startup timing value by default', () => {
  resetPerformanceMetricsForTesting();

  markTimingValue('first_paint_ms', 120);
  markTimingValue('first_paint_ms', 240);

  expect(getPerformanceSnapshot().startupTimings.first_paint_ms).toBe(120);
});

test('includes startup and selected engine timings in performance snapshot', () => {
  resetPerformanceMetricsForTesting();

  markTimingValue('app_ready_ms', 12);
  markTimingValue('window_created_ms', 45);
  markTimingValue('first_paint_ms', 90);
  markTimingValue('first_interactive_ms', 130);
  markTimingValue('selected_engine_detect_ms', 18);
  markTimingValue('selected_engine_ready_ms', 18);

  expect(getPerformanceSnapshot().startupTimings).toMatchObject({
    app_ready_ms: 12,
    window_created_ms: 45,
    first_paint_ms: 90,
    first_interactive_ms: 130,
    selected_engine_detect_ms: 18,
    selected_engine_ready_ms: 18,
  });
});

test('keeps a bounded slow DB operation ring buffer', () => {
  resetPerformanceMetricsForTesting();
  setDbSlowThresholdForTesting(1);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  for (let index = 0; index < 205; index += 1) {
    recordDbOperation({
      operation: 'getSession',
      sessionId: `session-${index}`,
      durationMs: 2,
      messageCount: index,
    });
  }

  const snapshot = getPerformanceSnapshot();
  expect(snapshot.db.totalOperations).toBe(205);
  expect(snapshot.db.slowOperations).toHaveLength(200);
  expect(snapshot.db.slowOperations[0].sessionId).toBe('session-5');
  expect(snapshot.db.byOperation.getSession.slowCount).toBe(205);
  expect(warnSpy).toHaveBeenCalled();

  warnSpy.mockRestore();
});

test('aggregates settings performance metrics', () => {
  resetPerformanceMetricsForTesting();
  const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

  recordSettingsMetric({
    type: 'open',
    durationMs: 42,
    tab: 'general',
    success: true,
  });
  recordSettingsMetric({
    type: 'ipc',
    durationMs: 125,
    tab: 'im',
    channel: 'im:openclaw:config-schema',
    success: false,
    error: 'OpenClaw CLI was not found',
    triggeredRuntimeStart: false,
  });

  const snapshot = getPerformanceSnapshot();
  expect(snapshot.settings.totalEvents).toBe(2);
  expect(snapshot.settings.byType.open).toMatchObject({
    count: 1,
    totalDurationMs: 42,
    maxDurationMs: 42,
  });
  expect(snapshot.settings.byType.ipc).toMatchObject({
    count: 1,
    totalDurationMs: 125,
    maxDurationMs: 125,
  });
  expect(snapshot.settings.byOperation.open).toMatchObject({
    count: 1,
    totalDurationMs: 42,
    maxDurationMs: 42,
  });
  expect(snapshot.settings.byOperation['ipc:im:openclaw:config-schema']).toMatchObject({
    count: 1,
    totalDurationMs: 125,
    maxDurationMs: 125,
  });
  expect(snapshot.settings.recentEvents[1]).toMatchObject({
    type: 'ipc',
    channel: 'im:openclaw:config-schema',
    success: false,
    triggeredRuntimeStart: false,
  });
  expect(debugSpy).toHaveBeenCalledWith(
    expect.stringContaining('settings ipc:im:openclaw:config-schema took 125ms.')
  );
  expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('tab=im.'));

  debugSpy.mockRestore();
});
