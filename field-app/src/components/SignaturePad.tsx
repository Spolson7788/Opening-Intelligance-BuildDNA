import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export interface SignaturePadHandle {
  getDataUrl: () => string | null;
  clear: () => void;
}

interface SignaturePadProps {
  height?: number;
}

// Drawn in dark ink on a white canvas — deliberately the opposite of the
// field app's own dark theme, since a signature should read like ink on
// paper (and print cleanly if it ever ends up on a compliance PDF), not
// match the surrounding UI.
export const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(function SignaturePad(
  { height = 160 },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const hasDrawnRef = useRef(false);
  const [hasDrawn, setHasDrawn] = useState(false);

  useImperativeHandle(ref, () => ({
    getDataUrl: () => {
      if (!hasDrawnRef.current || !canvasRef.current) return null;
      return canvasRef.current.toDataURL("image/png");
    },
    clear: () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasDrawnRef.current = false;
      setHasDrawn(false);
    },
  }));

  function getPos(e: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const canvas = canvasRef.current!;
    canvas.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const ctx = canvas.getContext("2d")!;
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    e.preventDefault();
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#14171a";
    const { x, y } = getPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!hasDrawnRef.current) {
      hasDrawnRef.current = true;
      setHasDrawn(true);
    }
  }

  function onPointerUp() {
    drawingRef.current = false;
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={600}
        height={height * 2}
        style={{
          width: "100%",
          height,
          background: "#ffffff",
          borderRadius: 8,
          border: "1px solid var(--border)",
          touchAction: "none",
          display: "block",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      />
      {!hasDrawn && (
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
          Sign above with your finger or mouse
        </p>
      )}
    </div>
  );
});
