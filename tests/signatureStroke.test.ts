import { describe, expect, it } from "vitest";
import { bindSignatureSurface, createSignatureStroke, signatureBackingSize, signaturePoint } from "../field-app/src/lib/signatureStroke";
import type { SignaturePoint, SignatureStroke } from "../field-app/src/lib/signatureStroke";

function ink() {
  const segments: Array<[SignaturePoint, SignaturePoint]> = [];
  const begins: SignaturePoint[] = [];
  const stroke = createSignatureStroke({
    begin(point) { begins.push(point); },
    segment(from, to) { segments.push([from, to]); },
  });
  return { stroke, segments, begins };
}

function surface() {
  const listeners = new Map<string, { listener: (event: never) => void; options?: AddEventListenerOptions }>();
  const capture: number[] = [];
  const fake = {
    listeners,
    capture,
    addEventListener(type: string, listener: (event: never) => void, options?: AddEventListenerOptions) {
      listeners.set(type, { listener, options });
    },
    removeEventListener(type: string) { listeners.delete(type); },
    setPointerCapture(pointerId: number) { capture.push(pointerId); },
    fire(type: string, event: object) { listeners.get(type)?.listener(event as never); },
  };
  return fake;
}

const rect = () => ({ left: 10, top: 20 });

describe("signature stroke", () => {
  it("maps a finger into the canvas box and sizes the bitmap for the screen", () => {
    expect(signaturePoint(30, 50, { left: 10, top: 20 })).toEqual({ x: 20, y: 30 });
    expect(signatureBackingSize(100, 160, 3)).toEqual({ width: 300, height: 480, ratio: 3 });
    expect(signatureBackingSize(10, 10, 0).ratio).toBe(1);
  });

  it("keeps drawing when the pointer stays down, and does not listen for pointerleave", () => {
    const { stroke, segments } = ink();
    const pad = surface();
    bindSignatureSurface(pad, stroke, rect);
    expect(pad.listeners.has("pointerleave")).toBe(false);
    expect(pad.listeners.has("pointerout")).toBe(false);
    expect(pad.listeners.get("touchmove")?.options).toEqual({ passive: false });
    expect(pad.listeners.get("touchstart")?.options).toEqual({ passive: false });
    pad.fire("pointerdown", { pointerId: 4, pointerType: "touch", clientX: 15, clientY: 28, cancelable: true, preventDefault() {} });
    expect(pad.capture).toEqual([4]);
    expect(stroke.isDrawing).toBe(true);
    pad.fire("pointermove", { pointerType: "touch", clientX: 40, clientY: 70, cancelable: true, preventDefault() {} });
    expect(segments).toEqual([[{ x: 5, y: 8 }, { x: 30, y: 50 }]]);
    expect(stroke.hasInk).toBe(true);
  });

  it("draws a finger stroke from touch events when Safari ends the pointer first", () => {
    const { stroke, segments } = ink();
    const pad = surface();
    bindSignatureSurface(pad, stroke, rect);
    const prevented: string[] = [];
    const touch = (type: string, x: number, y: number) => pad.fire(type, {
      cancelable: true,
      touches: type === "touchend" ? [] : [{ clientX: x, clientY: y }],
      changedTouches: [{ clientX: x, clientY: y }],
      preventDefault() { prevented.push(type); },
    });
    pad.fire("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 12, clientY: 22, cancelable: true, preventDefault() {} });
    pad.fire("pointerup", { pointerType: "touch", clientX: 12, clientY: 22, cancelable: true, preventDefault() {} });
    expect(stroke.isDrawing).toBe(false);
    touch("touchmove", 18, 40);
    touch("touchmove", 36, 80);
    expect(prevented).toEqual(["touchmove", "touchmove"]);
    expect(segments).toEqual([[{ x: 8, y: 20 }, { x: 26, y: 60 }]]);
    expect(stroke.hasInk).toBe(true);
  });

  it("does not draw the same finger twice when pointer and touch both move", () => {
    const { stroke, segments } = ink();
    const pad = surface();
    bindSignatureSurface(pad, stroke, rect);
    pad.fire("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 20, cancelable: true, preventDefault() {} });
    pad.fire("pointermove", { pointerType: "touch", clientX: 20, clientY: 30, cancelable: true, preventDefault() {} });
    pad.fire("touchmove", { cancelable: true, touches: [{ clientX: 40, clientY: 60 }], changedTouches: [], preventDefault() {} });
    expect(segments).toHaveLength(1);
    expect(stroke.hasInk).toBe(true);
  });

  it("clearing the stroke drops the ink", () => {
    const drawn = ink();
    const stroke: SignatureStroke = drawn.stroke;
    stroke.touchStart({ x: 0, y: 0 });
    stroke.touchMove({ x: 4, y: 4 });
    expect(stroke.hasInk).toBe(true);
    stroke.reset();
    expect(stroke.hasInk).toBe(false);
    expect(stroke.isDrawing).toBe(false);
  });
});
