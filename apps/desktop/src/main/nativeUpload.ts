import type { PickedDirectory } from '@deploykit/client';
import type { BrowserWindow, Session } from 'electron';

export async function pickDirectory(
  _parent: BrowserWindow
): Promise<PickedDirectory | null> {
  throw new Error('nativeUpload.pickDirectory not implemented yet (Task 8)');
}

export async function uploadFolder(
  _session: Session,
  _origin: string,
  _projectId: string,
  _directoryPath: string,
  _description: string,
  _onProgress?: (percent: number) => void
): Promise<{ version: { id: string; name: string } }> {
  throw new Error('nativeUpload.uploadFolder not implemented yet (Task 8)');
}
