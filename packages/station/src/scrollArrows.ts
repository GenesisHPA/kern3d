// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** The element that scrolls and overflows: `start` itself or the first such inside it (visible). */
export function scrollerIn(start: HTMLElement): HTMLElement | undefined {
    const overflows = (e: HTMLElement) => {
        if (e.scrollHeight <= e.clientHeight + 2 || e.offsetParent === null) return false;
        const o = getComputedStyle(e).overflowY;
        return o === "auto" || o === "scroll";
    };
    if (overflows(start)) return start;
    for (const e of start.querySelectorAll<HTMLElement>("*")) if (overflows(e)) return e;
    return undefined;
}

/**
 * ▲ ▼ at the right of `host` for whatever `target()` gives that does not fit: a press pages by
 * about two thirds of the view, smoothly. They show only when there is something to scroll, and
 * each greys out at its end — for gloves, dusty fingers and touch boards that drag badly.
 */
export function scrollArrows(host: HTMLElement, target: () => HTMLElement | undefined): HTMLElement {
    const rail = document.createElement("div");
    rail.className = "scrollRail";
    const up = document.createElement("button");
    up.className = "scrollArrow";
    up.textContent = "▲";
    const down = document.createElement("button");
    down.className = "scrollArrow";
    down.textContent = "▼";
    rail.append(up, down);
    host.append(rail);

    const page = (dir: 1 | -1) => {
        const el = target();
        if (el) el.scrollBy({ top: dir * el.clientHeight * 0.7, behavior: "smooth" });
    };
    up.onclick = () => page(-1);
    down.onclick = () => page(1);

    const update = () => {
        const el = target();
        const show = el !== undefined;
        rail.classList.toggle("show", show);
        host.classList.toggle("hasRail", show);
        if (!el) return;
        up.disabled = el.scrollTop <= 1;
        down.disabled = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    };
    // content and tabs change all the time: a cheap look four times a second
    setInterval(update, 250);
    host.addEventListener("scroll", update, true);
    update();
    return rail;
}
