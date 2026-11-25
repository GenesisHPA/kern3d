// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Scrolling by dragging, whatever the screen reports. A real touch screen scrolls by itself, but
 * many HDMI touch boards (the Tesla panel's among them) report a finger as a mouse — then a drag
 * would only select text. So a press inside anything that scrolls, moved more than a few pixels,
 * scrolls it (with a little glide after) and the press is not a click any more.
 */
export function dragScroll(root: HTMLElement = document.body, threshold = 8) {
    let drag:
        | {
              el: HTMLElement;
              id: number;
              y: number;
              top: number;
              moved: boolean;
              v: number;
              t: number;
              last: number;
          }
        | undefined;
    let glide = 0;

    const scrollerOf = (target: EventTarget | null): HTMLElement | undefined => {
        for (let e = target as HTMLElement | null; e && e !== root.parentElement; e = e.parentElement) {
            if (e.scrollHeight <= e.clientHeight + 1) continue;
            const o = getComputedStyle(e).overflowY;
            if (o === "auto" || o === "scroll") return e;
        }
        return undefined;
    };

    root.addEventListener(
        "pointerdown",
        (e) => {
            if (e.pointerType === "touch" && e.isPrimary === false) return;
            // a real touch screen scrolls natively; drag ourselves only for mouse and pen
            if (e.pointerType === "touch") return;
            if ((e.target as HTMLElement).closest("input, textarea, select")) return;
            const el = scrollerOf(e.target);
            if (!el) return;
            cancelAnimationFrame(glide);
            drag = {
                el,
                id: e.pointerId,
                y: e.clientY,
                top: el.scrollTop,
                moved: false,
                v: 0,
                t: e.timeStamp,
                last: e.clientY,
            };
        },
        true,
    );

    root.addEventListener(
        "pointermove",
        (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            const dy = e.clientY - drag.y;
            if (!drag.moved && Math.abs(dy) < threshold) return;
            drag.moved = true;
            drag.el.scrollTop = drag.top - dy;
            const dt = Math.max(1, e.timeStamp - drag.t);
            drag.v = (drag.last - e.clientY) / dt; // px per ms, positive = content up
            drag.t = e.timeStamp;
            drag.last = e.clientY;
            e.preventDefault();
        },
        true,
    );

    const end = (e: PointerEvent) => {
        if (!drag || e.pointerId !== drag.id) return;
        const { el, moved } = drag;
        let v = drag.v * 16; // px per frame
        drag = undefined;
        if (!moved) return;
        // the press was a drag: swallow the click it would make
        const swallow = (c: Event) => {
            c.stopPropagation();
            c.preventDefault();
        };
        addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => removeEventListener("click", swallow, { capture: true }), 50);
        const step = () => {
            if (Math.abs(v) < 0.5) return;
            el.scrollTop += v;
            v *= 0.92;
            glide = requestAnimationFrame(step);
        };
        glide = requestAnimationFrame(step);
    };
    root.addEventListener("pointerup", end, true);
    root.addEventListener("pointercancel", end, true);
}
