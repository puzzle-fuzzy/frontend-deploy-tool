import { useApiClient, useNative } from '@deploykit/client';
import { FileArchive, FolderOpen, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../shared/ui/dialog';
import { Progress } from '../../shared/ui/progress';
import { Textarea } from '../../shared/ui/textarea';
import { useToast } from '../../shared/ui/toast-context';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onUploaded: () => void;
}

export function UploadVersionDialog({
  open,
  onOpenChange,
  projectId,
  onUploaded,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const api = useApiClient();
  const native = useNative();
  const releaseNotesId = 'upload-release-notes';
  const [file, setFile] = useState<File | null>(null);
  const [folderFiles, setFolderFiles] = useState<File[] | null>(null);
  // Native-picked directory: absolute disk path + its NativeFile entries.
  const [nativeDir, setNativeDir] = useState<{
    path: string;
    files: File[];
  } | null>(null);
  const [desc, setDesc] = useState('');
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (open) return;
    setFile(null);
    setFolderFiles(null);
    setNativeDir(null);
    setDesc('');
    setProgress(0);
  }, [open]);

  const label = file
    ? file.name
    : nativeDir
      ? t('upload.selectedFiles', { count: nativeDir.files.length })
      : folderFiles
        ? t('upload.selectedFiles', { count: folderFiles.length })
        : null;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) {
      setFile(f);
      setFolderFiles(null);
      setNativeDir(null);
    }
  };

  const handleSelectZip = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip';
    input.onchange = () => {
      if (input.files?.[0]) {
        setFile(input.files[0]);
        setFolderFiles(null);
        setNativeDir(null);
      }
    };
    input.click();
  };

  const handleSelectFolder = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.onchange = () => {
      if (input.files && input.files.length > 0) {
        setFolderFiles(Array.from(input.files));
        setFile(null);
        setNativeDir(null);
      }
    };
    input.click();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!file && !folderFiles && !nativeDir) || !projectId) return;
    setUploading(true);
    try {
      if (native && nativeDir) {
        // Desktop path: the main process reads bytes from disk and reports
        // progress over IPC. nativeDir holds the absolute directory path.
        await native.uploadFolder(projectId, nativeDir.path, desc, setProgress);
      } else {
        // Web path (unchanged): XHR upload of the picked File objects.
        await api.uploadVersion(
          projectId,
          file,
          folderFiles,
          desc,
          setProgress
        );
      }
      toast(t('common.uploaded'));
      native?.showNotification('DeployKit', t('common.uploaded'));
      setFile(null);
      setFolderFiles(null);
      setNativeDir(null);
      setDesc('');
      setProgress(0);
      onUploaded();
      onOpenChange(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : t('common.failed'), 'error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('upload.title')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <button
            type="button"
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={handleSelectZip}
            className="w-full border-2 border-dashed border-border rounded-lg p-8 flex flex-col items-center justify-center text-center hover:border-primary/50 hover:bg-muted/30 transition-colors cursor-pointer"
          >
            <div className="h-12 w-12 bg-primary/10 rounded-full flex items-center justify-center mb-3">
              <Upload className="size-6 text-primary" />
            </div>
            <p className="text-base font-medium">
              {label ?? t('upload.dropzone')}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {t('upload.dropzoneDesc')}
            </p>
          </button>

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="default"
              type="button"
              onClick={handleSelectZip}
            >
              <FileArchive className="size-4" />
              {t('upload.selectZip')}
            </Button>
            <Button
              variant="outline"
              size="default"
              type="button"
              onClick={handleSelectFolder}
            >
              <FolderOpen className="size-4" />
              {t('upload.selectFolder')}
            </Button>
            {native && (
              <Button
                variant="default"
                size="default"
                type="button"
                onClick={async () => {
                  const picked = await native.pickDirectory();
                  if (picked) {
                    // NativeFile is structurally compatible with File (the
                    // native upload branch never touches File-only APIs).
                    setNativeDir({
                      path: picked.directoryPath,
                      files: picked.files as unknown as File[],
                    });
                    setFile(null);
                    setFolderFiles(null);
                  }
                }}
              >
                <FolderOpen className="size-4" />
                Pick directory…
              </Button>
            )}
          </div>

          {uploading && (
            <div className="space-y-1">
              <Progress value={progress} className="h-1.5" />
              <p className="text-xs text-muted-foreground text-right">
                {progress}%
              </p>
            </div>
          )}

          <div className="space-y-2">
            <label
              htmlFor={releaseNotesId}
              className="text-sm font-medium text-muted-foreground"
            >
              {t('upload.releaseNotes')}
            </label>
            <Textarea
              id={releaseNotesId}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder={t('upload.releaseNotesPlaceholder')}
              rows={2}
            />
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              size="default"
              onClick={() => onOpenChange(false)}
            >
              {t('upload.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={(!file && !folderFiles && !nativeDir) || uploading}
              size="default"
            >
              {uploading ? `${progress}%` : t('upload.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
