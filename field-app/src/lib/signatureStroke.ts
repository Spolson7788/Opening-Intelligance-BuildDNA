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
  addEventListener(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener, options?: boolean | EventListenerOptions): void;
  setPointerCapture?(pointerId: number): void;
}

function blockScroll(event: CancellableEvent) {
  if (event.cancelable) event.preventDefault?.();
}

function touchPoint(event: Event, readRect: () => SignatureRect): SignaturePoint | null {
  if (!("touches" in event) && !("changedTouches" in event)) return null;
  const record = event as TouchEvent;
  const touch = record.touches?.[0] || record.changedTouches?.[0];
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
  const pointer = (event: Event): PointerEvent | null => {
    if (!("clientX" in event) || !("clientY" in event)) return null;
    return event as PointerEvent;
  };
  const onPointerDown: EventListener = (event) => {
    const point = pointer(event);
    if (!point || (point.pointerType === "mouse" && point.button !== 0)) return;
    blockScroll(point);
    try { surface.setPointerCapture?.(point.pointerId); } catch { /* iOS Safari can reject capture */ }
    stroke.pointerDown(signaturePoint(point.clientX, point.clientY, readRect()));
  };
  const onPointerMove: EventListener = (event) => {
    if (!stroke.isDrawing) return;
    const point = pointer(event);
    if (!point) return;
    blockScroll(point);
    stroke.pointerMove(signaturePoint(point.clientX, point.clientY, readRect()));
  };
  const onPointerUp: EventListener = (event) => {
    blockScroll(event);
    stroke.pointerUp();
  };
  const onTouchStart: EventListener = (event) => {
    blockScroll(event);
    const point = touchPoint(event, readRect);
    if (point) stroke.touchStart(point);
  };
  const onTouchMove: EventListener = (event) => {
    blockScroll(event);
    const point = touchPoint(event, readRect);
    if (point) stroke.touchMove(point);
  };
  const onTouchEnd: EventListener = (event) => {
    blockScroll(event);
    stroke.touchEnd();
  };
  const listeners: Array<[string, EventListener]> = [
    ["pointerdown", onPointerDown],
    ["pointermove", onPointerMove],
    ["pointerup", onPointerUp],
    ["pointercancel", onPointerUp],
    ["touchstart", onTouchStart],
    ["touchmove", onTouchMove],
    ["touchend", onTouchEnd],
    ["touchcancel", onTouchEnd],
  ];
  for (const [type, listener] of listeners) surface.addEventListener(type, listener, { passive: false });
  return () => {
    for (const [type, listener] of listeners) surface.removeEventListener(type, listener);
  };
}
