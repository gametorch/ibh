import type { IbhUiController } from './types';
import type { IbhUiOptions } from './types';
import type { ChatSurface } from './panel-messages';

/**
 * Speech-to-text (OpenRouter /audio/transcriptions): mic button flow with an
 * auto-send toggle. The integrator's key is optional — proxy mode sends no
 * Authorization header and relies on same-origin cookies.
 */
export function installStt(deps: {
  stt: NonNullable<IbhUiOptions['stt']>;
  micBtn: HTMLButtonElement;
  autoSendCheckbox: HTMLInputElement;
  surface: ChatSurface;
  input: HTMLTextAreaElement;
  controller: IbhUiController;
}): void {
  const { stt, micBtn, autoSendCheckbox, surface, input, controller } = deps;
  const { addMessage, addNotice } = surface;

  const transcribe = async (blob: Blob): Promise<string> => {
    const base64 = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.addEventListener('load', () => {
        const s = String(fr.result ?? '');
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : '');
      });
      fr.addEventListener('error', () => reject(new Error('could not read the recording')));
      fr.readAsDataURL(blob);
    });
    if (!base64) throw new Error('empty recording');

    const format = blob.type.includes('mp4') ? 'm4a' : 'webm';
    const payload: Record<string, unknown> = {
      model: stt.model,
      input_audio: { data: base64, format },
    };
    if (stt.language) payload.language = stt.language;

    const url = stt.endpoint ?? `${stt.baseUrl ?? 'https://openrouter.ai/api/v1'}/audio/transcriptions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (stt.apiKey) headers.Authorization = `Bearer ${stt.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(payload),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error */
    }
    if (!res.ok) {
      const detail =
        body && typeof body === 'object' && 'error' in body
          ? (body as { error?: { message?: string } }).error?.message
          : undefined;
      throw new Error(`STT failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    const text = (body as { text?: unknown })?.text;
    if (typeof text !== 'string') throw new Error('STT returned no text');
    return text.trim();
  };

  const MIC_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3Zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7Z"/></svg>';
  const STOP_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M7 7h10v10H7z"/></svg>';

  let mediaRecorder: MediaRecorder | null = null;
  let micStream: MediaStream | null = null;
  let recording = false;
  const setRecordingUi = (on: boolean) => {
    recording = on;
    micBtn.classList.toggle('recording', on);
    micBtn.title = on ? 'Stop recording' : 'Record voice message';
    micBtn.innerHTML = on ? STOP_SVG : MIC_SVG;
  };
  micBtn.innerHTML = MIC_SVG;

  micBtn.addEventListener('click', () => {
    if (recording) {
      try {
        mediaRecorder?.stop();
      } catch {
        /* ignore */
      }
      return;
    }
    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        addNotice('(speech input is not supported in this browser)');
        return;
      }
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        addNotice(`(microphone unavailable: ${e instanceof Error ? e.message : String(e)})`);
        return;
      }
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(micStream);
      mediaRecorder = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        micStream?.getTracks().forEach((t) => t.stop());
        micStream = null;
        mediaRecorder = null;
        setRecordingUi(false);
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (blob.size === 0) return;
        const notice = addNotice('transcribing…');
        void (async () => {
          try {
            const text = await transcribe(blob);
            notice.remove();
            if (!text) {
              addNotice('(no speech detected)');
              return;
            }
            if (autoSendCheckbox.checked) {
              addMessage(text, 'user');
              controller.send(text);
            } else {
              input.value = text;
              input.focus();
            }
          } catch (e) {
            notice.textContent = `(speech-to-text failed: ${e instanceof Error ? e.message : String(e)})`;
          }
        })();
      };
      rec.start();
      setRecordingUi(true);
    })();
  });
}
