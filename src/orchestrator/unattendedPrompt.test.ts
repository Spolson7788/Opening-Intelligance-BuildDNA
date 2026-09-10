import { describe, expect, it } from 'vitest';
import { buildUnattendedPrompt, compactCheckpoint } from './unattendedPrompt.js';

describe('unattended prompt compaction', () => {
  it('preserves active resume fields while excluding large historical sections', () => {
    const checkpoint = {
      workstream_id: 'AA-GROK-001',
      status: 'ACTIVE_MEASUREMENT_BACKFILL',
      active_source_row_ref: 'CAD-3D Assets!1845',
      active_stage: 'ACTIVE_MEASUREMENT_BACKFILL',
      first_unfinished_task: 'Continue exact PED5600 full-sheet extraction.',
      do_not_repeat: 'Do not restart completed rows.',
      historical_checkpoint_statements: Array.from({ length: 200 }, (_, i) => `historical ${i}`),
      assa_abloy_missing_published_dimension_backfill: {
        state: 'IN_PROGRESS',
        active_source_row_ref: 'CAD-3D Assets!1845',
        new_records_added: 529,
        pe8500: { huge: 'x'.repeat(10000) },
        pe8600: { huge: 'y'.repeat(10000) }
      },
      last_full_sheet_backfill: {
        source_row_ref: 'CAD-3D Assets!1839',
        source_asset: 'evidence/pe8900/PE8900_MEDT42.png',
        next_source_row_ref: 'CAD-3D Assets!1845',
        first_unfinished_task: 'Continue governed full-sheet extraction.'
      }
    };

    const compact = compactCheckpoint(checkpoint);
    expect(compact.active_source_row_ref).toBe('CAD-3D Assets!1845');
    expect(compact.first_unfinished_task).toBe('Continue exact PED5600 full-sheet extraction.');
    expect(compact.historical_checkpoint_statements).toBeUndefined();
    expect(compact.assa_abloy_missing_published_dimension_backfill).toEqual({
      state: 'IN_PROGRESS',
      active_source_row_ref: 'CAD-3D Assets!1845',
      new_records_added: 529
    });
  });

  it('builds a targeted bounded prompt without embedding the raw checkpoint', () => {
    const previousSlice = process.env.OI_EXECUTION_SLICE_MINUTES;
    process.env.OI_EXECUTION_SLICE_MINUTES = '10';

    try {
      const hugeHistory = Array.from({ length: 300 }, (_, i) => `HISTORY-${i}-${'z'.repeat(100)}`);
      const checkpointText = JSON.stringify({
        status: 'ACTIVE_MEASUREMENT_BACKFILL',
        active_source_row_ref: 'CAD-3D Assets!1845',
        first_unfinished_task: 'Extract the next exact sheet.',
        historical_checkpoint_statements: hugeHistory
      });

      const prompt = buildUnattendedPrompt({
        checkpointPath: '/runner/lane/oi-workstreams/assa-abloy/CURRENT_CHECKPOINT.json',
        checkpointText,
        laneId: 'ASSA_ABLOY',
        manufacturerGroup: 'ASSA_ABLOY',
        executionOwner: 'ASSA_ABLOY_LANE',
        allowedWriteRoot: 'oi-workstreams/assa-abloy/',
        branch: 'oi-assa-abloy-evidence'
      });

      expect(prompt).toContain('FULL_CHECKPOINT_PATH = oi-workstreams/assa-abloy/CURRENT_CHECKPOINT.json');
      expect(prompt).toContain('CAD-3D Assets!1845');
      expect(prompt).toContain('Extract the next exact sheet.');
      expect(prompt).toContain('Do not begin with a broad repository census.');
      expect(prompt).toContain('EXECUTION_SLICE_TARGET_MINUTES = 10');
      expect(prompt).toContain('one durable slice in a continuously rotating scheduler');
      expect(prompt).toContain('The outer workflow can only validate and commit after you return');
      expect(prompt).toContain('TOOL OUTPUT AND TOKEN BUDGET');
      expect(prompt).toContain('Never dump raw binary data');
      expect(prompt).toContain('no more than about 200 lines or 20 KB');
      expect(prompt).toContain('Do not print raw PDF streams.');
      expect(prompt).toContain('HTTP 429');
      expect(prompt).toContain('Do not generate images.');
      expect(prompt).not.toContain('HISTORY-299');
      expect(prompt.length).toBeLessThan(checkpointText.length);
    } finally {
      if (previousSlice === undefined) delete process.env.OI_EXECUTION_SLICE_MINUTES;
      else process.env.OI_EXECUTION_SLICE_MINUTES = previousSlice;
    }
  });
});