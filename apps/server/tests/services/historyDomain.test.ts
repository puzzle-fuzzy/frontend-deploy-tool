import { describe, expect, test } from 'bun:test';
import type { Data } from '@deploykit/shared';
import { appendHistoryEvent } from '../../src/domain/history';
import { CURRENT_SCHEMA_VERSION } from '../../src/domain/schema';

function makeData(): Data {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [],
    users: [],
    history: [],
  };
}

const project = { id: 'p1', name: 'Demo' };
const version = { id: 'v1', name: 'abcdefg' };
const actorId = 'user-1';

describe('appendHistoryEvent', () => {
  test('prepends an event without metadata when none is given', () => {
    const data = makeData();
    appendHistoryEvent(data, 'project.create', project, actorId);

    expect(data.history).toHaveLength(1);
    expect(data.history[0]).toEqual({
      id: expect.any(String),
      action: 'project.create',
      projectId: 'p1',
      projectName: 'Demo',
      versionId: '',
      versionName: '',
      timestamp: expect.any(String),
      actorId,
    });
    // metadata is omitted entirely (not undefined-valued) when not provided.
    expect(data.history[0]).not.toHaveProperty('metadata');
  });

  test('attaches the provided metadata payload', () => {
    const data = makeData();
    appendHistoryEvent(data, 'version.upload', project, actorId, version, {
      sourceType: 'folder',
      size: 128,
      fileCount: 2,
    });

    expect(data.history[0].metadata).toEqual({
      sourceType: 'folder',
      size: 128,
      fileCount: 2,
    });
  });

  test('caps the log at 200 entries', () => {
    const data = makeData();
    for (let i = 0; i < 205; i++) {
      appendHistoryEvent(data, 'project.create', project, actorId);
    }
    expect(data.history).toHaveLength(200);
    // Newest events are kept at the front.
    expect(data.history[0].projectId).toBe('p1');
  });
});
