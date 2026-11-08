import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { bindSignatureSurface, createSignatureStroke, signatureBackingSize } from "../lib/signatureStroke";
import type { SignatureStroke } from "../lib/signatureStroke";

export interface SignaturePadHandle {
  getDataUrl: () => string | null;
  clear: () => void;
}

interface SignaturePadProps {
  height?: number;
}

interface PadApi {
  fit: () => void;
  prepare: () => CanvasRenderingContext2D | null;
}

// Drawn in dark ink on a white canvas — deliberately the opposite of the
// field app's own dark theme, since a signature should read like ink on
// paper (and print cleanly if it ever ends up on a compliance PDF), not
// match the surrounding UI. The bitmap is sized from the displayed box and
// devicePixelRatio; width and height are not React props, because setting
// them on render clears the ink.
export const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(function SignaturePad(
  { height = 160 },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasDrawnRef = useRef(false);
  const heightRef = useRef(height);
  const sizeRef = useRef<{ width: number; height: number; ratio: number } | null>(null);
  const apiRef = useRef<PadApi>({ fit() {}, prepare: () => null });
  const [hasDrawn, setHasDrawn] = useState(false);
  heightRef.current = height;

  const strokeRef = useRef<SignatureStroke | null>(null);
  if (strokeRef.current === null) {
    strokeRef.current = createSignatureStroke({
      begin(point) {
        const ctx = apiRef.current.prepare();
        if (!ctx) return;
        ctx.beginPath();
        ctx.moveTo(point.x, point.y);
      },
      segment(from, to) {
        const ctx = apiRef.current.prepare();
        if (!ctx) return;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        if (!hasDrawnRef.current) {
          hasDrawnRef.current = true;
          setHasDrawn(true);
        }
      },
    });
  }

  apiRef.current.fit = () => {
    const canvas = canvasRef.current;
    if (!canvas || hasDrawnRef.current || strokeRef.current?.isDrawing) return;
    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width;
    const cssHeight = rect.height || heightRef.current;
    if (cssWidth < 2 || cssHeight < 2) return;
    const size = signatureBackingSize(cssWidth, cssHeight, window.devicePixelRatio || 1);
    if (sizeRef.current?.width === size.width && sizeRef.current.height === size.height) return;
    canvas.width = size.width;
    canvas.height = size.height;
    sizeRef.current = size;
  };

  apiRef.current.prepare = () => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    if (!sizeRef.current) apiRef.current.fit();
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const ratio = sizeRef.current?.ratio ?? (window.devicePixelRatio || 1);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#14171a";
    return ctx;
  };

  useImperativeHandle(ref, () => ({
    getDataUrl: () => {
      if (!hasDrawnRef.current || !canvasRef.current) return null;
      return canvasRef.current.toDataURL("image/png");
    },
    clear: () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      strokeRef.current?.reset();
      hasDrawnRef.current = false;
      setHasDrawn(false);
      if (canvas && ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    const stroke = strokeRef.current;
    if (!canvas || !stroke) return;
    apiRef.current.fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => apiRef.current.fit());
    observer?.observe(canvas);
    const unbind = bindSignatureSurface(canvas, stroke, () => canvas.getBoundingClientRect());
    return () => {
      observer?.disconnect();
      unbind();
    };
  }, [height]);

  return (
    <div className="signature-pad-frame">
      <canvas
        ref={canvasRef}
        className="signature-pad"
        style={{ height, touchAction: "none" }}
      />
      {!hasDrawn && (
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
          Sign above with your finger or mouse
        </p>
      )}
    </div>
  );
});
