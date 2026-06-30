import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Upload, FileArchive, FolderOpen } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onUploaded: () => void;
}

export function UploadDialog({ open, onOpenChange, projectId, onUploaded }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [folderFiles, setFolderFiles] = useState<File[] | null>(null);
  const [desc, setDesc] = useState("");
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);

  const label = file
    ? file.name
    : folderFiles
      ? `${folderFiles.length} files`
      : null;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) { setFile(f); setFolderFiles(null); }
  };

  const handleSelectZip = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip";
    input.onchange = () => {
      if (input.files?.[0]) { setFile(input.files[0]); setFolderFiles(null); }
    };
    input.click();
  };

  const handleSelectFolder = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
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
      toast(t("common.uploaded"));
      setFile(null); setFolderFiles(null); setDesc(""); setProgress(0);
      onUploaded();
      onOpenChange(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : t("common.failed"), "error");
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("upload.title")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={handleSelectZip}
            className="border-2 border-dashed border-border rounded-lg p-8 flex flex-col items-center justify-center text-center hover:border-primary/50 hover:bg-muted/30 transition-colors cursor-pointer"
          >
            <div className="h-10 w-10 bg-primary/10 rounded-full flex items-center justify-center mb-3">
              <Upload className="size-5 text-primary" />
            </div>
            <p className="text-sm font-medium">{label ?? t("upload.dropzone")}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("upload.dropzoneDesc")}</p>

            <div className="flex gap-2 mt-3">
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={(e) => { e.stopPropagation(); handleSelectZip(); }}
              >
                <FileArchive className="size-3.5" />
                {t("upload.selectZip")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={(e) => { e.stopPropagation(); handleSelectFolder(); }}
              >
                <FolderOpen className="size-3.5" />
                {t("upload.selectFolder")}
              </Button>
            </div>
          </div>

          {uploading && (
            <div className="space-y-1">
              <Progress value={progress} className="h-1.5" />
              <p className="text-xs text-muted-foreground text-right">{progress}%</p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t("upload.releaseNotes")}</label>
            <Textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder={t("upload.releaseNotesPlaceholder")}
              rows={2}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
              {t("upload.cancel")}
            </Button>
            <Button type="submit" disabled={(!file && !folderFiles) || uploading}>
              {uploading ? `${progress}%` : t("upload.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
