import "@testing-library/jest-dom/vitest";

// jsdom ships no PointerEvent, so fireEvent.pointerDown/Move would fall back to a bare
// Event and silently drop clientX/button/pointerId — the drag-to-reschedule tests
// (S5.5) need the real fields. Minimal shim over MouseEvent, test-only.
if (typeof window !== "undefined" && !window.PointerEvent) {
  class PointerEventShim extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "";
    }
  }
  window.PointerEvent = PointerEventShim as unknown as typeof PointerEvent;
}
