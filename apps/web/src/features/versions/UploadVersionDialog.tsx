import { FileArchive, FolderOpen, Upload } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Progress } from '@/shared/ui/progress';
import { Textarea } from '@/shared/ui/textarea';
import { useToast } from '@/shared/ui/toast-context';

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
  const releaseNotesId = 'upload-release-notes';
  const [file, setFile] = useState<File | null>(null);
  const [folderFiles, setFolderFiles] = useState<File[] | null>(null);
  const [desc, setDesc] = useState('');
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);

  const label = file
    ? file.name
    : folderFiles
      ? t('upload.selectedFiles', { count: folderFiles.length })
      : null;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) {
      setFile(f);
      setFolderFiles(null);
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
      }
    };
    input.click();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!file && !folderFiles) || !projectId) return;
    setUploading(true);
    try {
      await api.uploadVersion(projectId, file, folderFiles, desc, setProgress);
      toast(t('common.uploaded'));
      setFile(null);
      setFolderFiles(null);
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
              disabled={(!file && !folderFiles) || uploading}
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
