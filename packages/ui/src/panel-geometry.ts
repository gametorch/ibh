/**
 * Panel geometry: dragging (header handle), native resizing (bottom-right
 * grip), viewport clamping, persisted geometry and the host-provided default
 * position. The harness only ever signals elements it created itself.
 */

const GEOMETRY_KEY = 'ibh:panel-geometry';
const MIN_W = 280;
const MIN_H = 320;
const MARGIN = 8;

export interface Geometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GeometryInstall {
  dispose(): void;
}

export function installGeometry(deps: {
  panel: HTMLElement;
  header: HTMLElement;
  launcher: HTMLElement;
  defaultPosition?: { left?: number; top?: number; right?: number; bottom?: number };
}): GeometryInstall {
  const { panel, header, launcher } = deps;
  const disposers: Array<() => void> = [];

  const clampGeometry = (g: Geometry): Geometry => {
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const width = Math.min(Math.max(g.width, MIN_W), vp.w - MARGIN * 2);
    const height = Math.min(Math.max(g.height, MIN_H), vp.h - MARGIN * 2);
    const left = Math.min(Math.max(g.left, MARGIN), Math.max(MARGIN, vp.w - width - MARGIN));
    const top = Math.min(Math.max(g.top, MARGIN), Math.max(MARGIN, vp.h - height - MARGIN));
    return { left, top, width, height };
  };

  const applyGeometry = (g: Geometry): void => {
    const c = clampGeometry(g);
    panel.style.left = `${c.left}px`;
    panel.style.top = `${c.top}px`;
    panel.style.width = `${c.width}px`;
    panel.style.height = `${c.height}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  };

  const writeGeometry = (g: Geometry): void => {
    try {
      localStorage.setItem(GEOMETRY_KEY, JSON.stringify(clampGeometry(g)));
    } catch {
      /* private mode */
    }
  };

  const readGeometry = (): Geometry | null => {
    try {
      const raw = localStorage.getItem(GEOMETRY_KEY);
      if (!raw) return null;
      const g = JSON.parse(raw) as Partial<Geometry>;
      if (typeof g.left !== 'number' || typeof g.top !== 'number' || typeof g.width !== 'number' || typeof g.height !== 'number') {
        return null;
      }
      return clampGeometry(g as Geometry);
    } catch {
      return null;
    }
  };

  /** Host-provided start position; the launcher button follows the same spot. */
  const applyDefaultPosition = (): void => {
    const dp = deps.defaultPosition;
    if (!dp) return;
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const width = Math.min(400, vp.w - MARGIN * 2);
    const height = Math.min(560, vp.h - MARGIN * 2);
    const left = dp.left ?? (vp.w - (dp.right ?? 20) - width);
    const top = dp.top ?? (vp.h - (dp.bottom ?? 20) - height);
    applyGeometry({ left, top, width, height });
    launcher.style.left = panel.style.left;
    launcher.style.top = panel.style.top;
    launcher.style.right = 'auto';
    launcher.style.bottom = 'auto';
  };

  const resetGeometry = (): void => {
    try {
      localStorage.removeItem(GEOMETRY_KEY);
    } catch {
      /* ignore */
    }
    panel.style.left = '';
    panel.style.top = '';
    panel.style.width = '';
    panel.style.height = '';
    panel.style.right = '';
    panel.style.bottom = '';
    applyDefaultPosition();
  };

  const savedGeometry = readGeometry();
  if (savedGeometry) applyGeometry(savedGeometry);
  else applyDefaultPosition();

  let drag: { offsetX: number; offsetY: number } | null = null;
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    // switch from right/bottom anchoring to explicit left/top on first drag
    applyGeometry({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    const fresh = panel.getBoundingClientRect();
    drag = { offsetX: e.clientX - fresh.left, offsetY: e.clientY - fresh.top };
    panel.classList.add('dragging');
    try {
      header.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag) return;
    applyGeometry({
      left: e.clientX - drag.offsetX,
      top: e.clientY - drag.offsetY,
      width: panel.getBoundingClientRect().width,
      height: panel.getBoundingClientRect().height,
    });
  };
  const endDrag = (e: PointerEvent) => {
    if (!drag) return;
    drag = null;
    panel.classList.remove('dragging');
    try {
      header.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const r = panel.getBoundingClientRect();
    writeGeometry({ left: r.left, top: r.top, width: r.width, height: r.height });
  };
  const onDblClick = (e: MouseEvent) => {
    if (e.target instanceof Element && e.target.closest('button')) return;
    resetGeometry();
  };

  header.addEventListener('pointerdown', onPointerDown);
  header.addEventListener('pointermove', onPointerMove);
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);
  header.addEventListener('dblclick', onDblClick);

  // Native resize (bottom-right grip): clamp to the viewport and persist.
  let resizeSaveTimer: number | null = null;
  const resizeObserver = new ResizeObserver(() => {
    if (panel.hidden) return;
    const r = panel.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) return;
    if (panel.style.left === '') {
      // first native resize while still right/bottom anchored -> pin position
      applyGeometry({ left: r.left, top: r.top, width: r.width, height: r.height });
    }
    if (resizeSaveTimer !== null) clearTimeout(resizeSaveTimer);
    resizeSaveTimer = window.setTimeout(() => {
      const rect = panel.getBoundingClientRect();
      writeGeometry({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }, 250);
  });
  resizeObserver.observe(panel);

  const onWindowResize = () => {
    if (panel.hidden) return;
    const r = panel.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) return;
    applyGeometry({ left: r.left, top: r.top, width: r.width, height: r.height });
    if (launcher.style.left !== '') {
      const l = Number(launcher.style.left);
      const t = Number(launcher.style.top);
      if (!Number.isNaN(l)) launcher.style.left = `${Math.min(Math.max(l, MARGIN), Math.max(MARGIN, window.innerWidth - 56))}px`;
      if (!Number.isNaN(t)) launcher.style.top = `${Math.min(Math.max(t, MARGIN), Math.max(MARGIN, window.innerHeight - 56))}px`;
    }
  };
  window.addEventListener('resize', onWindowResize);

  return {
    dispose: () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', onWindowResize);
      header.removeEventListener('pointerdown', onPointerDown);
      header.removeEventListener('pointermove', onPointerMove);
      header.removeEventListener('pointerup', endDrag);
      header.removeEventListener('pointercancel', endDrag);
      header.removeEventListener('dblclick', onDblClick);
      for (const d of disposers) d();
    },
  };
}
