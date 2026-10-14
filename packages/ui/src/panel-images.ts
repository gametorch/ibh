import type { ImageAttachment } from '@ibh/core';
import { el } from './el';
import type { ChatSurface } from './panel-messages';

export interface ImageInputOptions {
  maxCount?: number;
  maxBytes?: number;
  accept?: string;
}

export interface ImageInputHandle {
  attachments(): readonly ImageAttachment[];
  clear(): void;
  destroy(): void;
}

const DEFAULT_MAX_COUNT = 5;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB before base64

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(new Error('could not read the image')));
    reader.readAsDataURL(file);
  });
}

const isImage = (file: File): boolean => file.type.startsWith('image/');

/**
 * Image input for the composer: an attach button (file picker) plus paste and
 * drag & drop, with thumbnail previews. Attachments are read as base64 data URLs
 * and handed to the model in the multimodal chat-completions shape.
 */
export function installImageInput(deps: {
  button: HTMLButtonElement;
  fileInput: HTMLInputElement;
  strip: HTMLElement;
  input: HTMLTextAreaElement;
  dropTarget: HTMLElement;
  surface: ChatSurface;
  options?: ImageInputOptions;
}): ImageInputHandle {
  const { button, fileInput, strip, input, dropTarget, surface } = deps;
  const maxCount = deps.options?.maxCount ?? DEFAULT_MAX_COUNT;
  const maxBytes = deps.options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const attachments: ImageAttachment[] = [];

  const totalBytes = () => attachments.reduce((sum, a) => sum + (a.size ?? 0), 0);

  const render = () => {
    strip.textContent = '';
    for (const [index, image] of attachments.entries()) {
      const thumb = el('div', 'thumb');
      const img = el('img');
      img.src = image.url;
      img.alt = image.name ?? 'attached image';
      const remove = el('button', 'thumb-remove');
      remove.type = 'button';
      remove.title = 'Remove image';
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        attachments.splice(index, 1);
        render();
      });
      thumb.append(img, remove);
      strip.append(thumb);
    }
    strip.hidden = attachments.length === 0;
  };

  const addFiles = (files: readonly File[]) => {
    void (async () => {
      for (const file of files) {
        if (!isImage(file)) {
          surface.addNotice(`(skipped "${file.name || 'file'}" — not an image)`);
          continue;
        }
        if (attachments.length >= maxCount) {
          surface.addNotice(`(up to ${maxCount} images per message)`);
          break;
        }
        if (totalBytes() + file.size > maxBytes) {
          surface.addNotice(`(images exceed the ${Math.round(maxBytes / (1024 * 1024))} MiB limit)`);
          break;
        }
        try {
          const url = await readAsDataUrl(file);
          attachments.push({
            url,
            name: file.name || undefined,
            mime: file.type || undefined,
            size: file.size,
          });
        } catch (e) {
          surface.addNotice(`(could not read "${file.name}": ${e instanceof Error ? e.message : String(e)})`);
        }
      }
      render();
    })();
  };

  const onButtonClick = () => fileInput.click();
  const onFileChange = () => {
    if (fileInput.files && fileInput.files.length > 0) addFiles([...fileInput.files]);
    fileInput.value = '';
  };
  const onPaste = (event: ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file && isImage(file)) files.push(file);
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
    }
  };
  const onDragOver = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      dropTarget.classList.add('drop-target');
    }
  };
  const onDragLeave = () => dropTarget.classList.remove('drop-target');
  const onDrop = (event: DragEvent) => {
    dropTarget.classList.remove('drop-target');
    if (event.dataTransfer && event.dataTransfer.files.length > 0) {
      event.preventDefault();
      addFiles([...event.dataTransfer.files]);
    }
  };

  button.addEventListener('click', onButtonClick);
  fileInput.addEventListener('change', onFileChange);
  input.addEventListener('paste', onPaste);
  dropTarget.addEventListener('dragover', onDragOver);
  dropTarget.addEventListener('dragleave', onDragLeave);
  dropTarget.addEventListener('drop', onDrop);

  return {
    attachments: () => attachments,
    clear: () => {
      attachments.length = 0;
      render();
    },
    destroy: () => {
      button.removeEventListener('click', onButtonClick);
      fileInput.removeEventListener('change', onFileChange);
      input.removeEventListener('paste', onPaste);
      dropTarget.removeEventListener('dragover', onDragOver);
      dropTarget.removeEventListener('dragleave', onDragLeave);
      dropTarget.removeEventListener('drop', onDrop);
    },
  };
}
