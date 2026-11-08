// Finger drawing for the inspection sign-off. iOS Safari delivers the touch
// as a scroll unless touchmove calls preventDefault from a non-passive
// listener, and it often ends the pointer gesture before any pointermove.
// The first stream that actually moves (pointer or touch) owns the stroke
// so the line is not drawn twice.

export interface SignaturePoint {
  x: number;
  y: number;
}

export interface SignatureRect {
  left: number;
  top: number;
}

export function signaturePoint(clientX: number, clientY: number, rect: SignatureRect): SignaturePoint {
  return { x: clientX - rect.left, y: clientY - rect.top };
}

export function signatureBackingSize(cssWidth: number, cssHeight: number, devicePixelRatio: number) {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return {
    width: Math.max(1, Math.round(cssWidth * ratio)),
    height: Math.max(1, Math.round(cssHeight * ratio)),
    ratio,
  };
}

export interface SignatureInk {
  begin(point: SignaturePoint): void;
  segment(from: SignaturePoint, to: SignaturePoint): void;
}

type StrokeSource = "pointer" | "touch";

export interface SignatureStroke {
  readonly hasInk: boolean;
  readonly isDrawing: boolean;
  pointerDown(point: SignaturePoint): void;
  pointerMove(point: SignaturePoint): void;
  pointerUp(): void;
  touchStart(point: SignaturePoint): void;
  touchMove(point: SignaturePoint): void;
  touchEnd(): void;
  reset(): void;
}

export function createSignatureStroke(ink: SignatureInk): SignatureStroke {
  let drawing = false;
  let hasInk = false;
  let source: StrokeSource | null = null;
  let last: SignaturePoint | null = null;

  const begin = (point: SignaturePoint) => {
    drawing = true;
    last = point;
    ink.begin(point);
  };

  const extend = (kind: StrokeSource, point: SignaturePoint) => {
    if (source && source !== kind) return;
    source = kind;
    if (!drawing || !last) {
      begin(point);
      return;
    }
    ink.segment(last, point);
    last = point;
    hasInk = true;
  };

  const end = (kind: StrokeSource) => {
    if (source && source !== kind) return;
    drawing = false;
    last = null;
    source = null;
  };

  return {
    get hasInk() { return hasInk; },
    get isDrawing() { return drawing; },
    pointerDown(point) {
      if (drawing) return;
      begin(point);
    },
    pointerMove(point) {
      if (!drawing) return;
      extend("pointer", point);
    },
    pointerUp() { end("pointer"); },
    touchStart(point) {
      if (drawing) return;
      begin(point);
    },
    touchMove(point) { extend("touch", point); },
    touchEnd() { end("touch"); },
    reset() {
      drawing = false;
      hasInk = false;
      source = null;
      last = null;
    },
  };
}

interface CancellableEvent {
  cancelable?: boolean;
  preventDefault?: () => void;
}

export interface SignatureSurface {
  addEventListener(type: string, listener: (event: never) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
  setPointerCapture?(pointerId: number): void;
}

function blockScroll(event: CancellableEvent) {
  if (event.cancelable) event.preventDefault?.();
}

function touchPoint(event: TouchEvent, readRect: () => SignatureRect): SignaturePoint | null {
  const touch = event.touches[0] || event.changedTouches[0];
  if (!touch) return null;
  return signaturePoint(touch.clientX, touch.clientY, readRect());
}

// Listeners stay on the canvas, not React's root, and are non-passive so
// preventDefault still stops the page from scrolling under a finger.
export function bindSignatureSurface(
  surface: SignatureSurface,
  stroke: SignatureStroke,
  readRect: () => SignatureRect,
) {
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    blockScroll(event);
    try { surface.setPointerCapture?.(event.pointerId); } catch { /* iOS Safari can reject capture */ }
    stroke.pointerDown(signaturePoint(event.clientX, event.clientY, readRect()));
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!stroke.isDrawing) return;
    blockScroll(event);
    stroke.pointerMove(signaturePoint(event.clientX, event.clientY, readRect()));
  };
  const onPointerUp = (event: PointerEvent) => {
    blockScroll(event);
    stroke.pointerUp();
  };
  const onTouchStart = (event: TouchEvent) => {
    blockScroll(event);
    const point = touchPoint(event, readRect);
    if (point) stroke.touchStart(point);
  };
  const onTouchMove = (event: TouchEvent) => {
    blockScroll(event);
    const point = touchPoint(event, readRect);
    if (point) stroke.touchMove(point);
  };
  const onTouchEnd = (event: TouchEvent) => {
    blockScroll(event);
    stroke.touchEnd();
  };
  const listeners: Array<[string, (event: never) => void]> = [
    ["pointerdown", onPointerDown as (event: never) => void],
    ["pointermove", onPointerMove as (event: never) => void],
    ["pointerup", onPointerUp as (event: never) => void],
    ["pointercancel", onPointerUp as (event: never) => void],
    ["touchstart", onTouchStart as (event: never) => void],
    ["touchmove", onTouchMove as (event: never) => void],
    ["touchend", onTouchEnd as (event: never) => void],
    ["touchcancel", onTouchEnd as (event: never) => void],
  ];
  for (const [type, listener] of listeners) surface.addEventListener(type, listener, { passive: false });
  return () => {
    for (const [type, listener] of listeners) surface.removeEventListener(type, listener);
  };
}
