// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Loading } from "../src/loading";

describe("Loading custom element", () => {
    afterEach(() => {
        // Every Loading instance injects a <style> with its keyframes into
        // document.head — remove them so tests don't leak into each other.
        document.head.querySelectorAll("style").forEach((styleEl) => {
            if (styleEl.textContent?.includes("@keyframes kernSpin")) {
                styleEl.remove();
            }
        });
    });

    test("should be defined as a custom element", () => {
        expect(customElements.get("chili-loading")).toBe(Loading);
    });

    test("should create an instance", () => {
        const el = new Loading();
        expect(el).toBeInstanceOf(HTMLElement);
        expect(el).toBeInstanceOf(Loading);
    });

    test("should have fixed positioning style", () => {
        const el = new Loading();
        expect(el.style.position).toBe("fixed");
        expect(el.style.zIndex).toBe("9999");
        expect(el.style.width).toBe("100%");
        expect(el.style.height).toBe("100%");
    });

    test("should contain a spinner element", () => {
        const el = new Loading();
        const spinner = el.querySelector("div");
        expect(spinner).not.toBeNull();
        // The first child div should be the spinner
        const firstChild = el.children[0] as HTMLElement;
        expect(firstChild.tagName).toBe("DIV");
        expect(firstChild.style.borderRadius).toBe("50%");
    });

    test("should show the name and a 'Loading…' line", () => {
        const el = new Loading();
        const texts = Array.from(el.querySelectorAll("div")).map((d) => d.textContent);
        expect(texts).toContain("Kern3D");
        expect(texts).toContain("Loading…");
    });

    test("should inject keyframes animation into document head", () => {
        // Save the current head content
        const initialStyleCount = document.head.querySelectorAll("style").length;
        new Loading();
        const newStyleCount = document.head.querySelectorAll("style").length;
        // Each Loading instance appends exactly one style element with @keyframes
        expect(newStyleCount).toBe(initialStyleCount + 1);
    });

    test("should have spinner with animation style", () => {
        const el = new Loading();
        const spinner = el.children[0] as HTMLElement;
        expect(spinner.style.animation).toContain("kernSpin");
    });

    test("should have a dark background with an orange glow", () => {
        const el = new Loading();
        const background = el.getAttribute("style") ?? "";
        expect(background).toContain("#111215");
        expect(background).toContain("rgba(255, 122, 26");
    });

    test("second instance should also work", () => {
        const el1 = new Loading();
        const el2 = new Loading();
        expect(el1).not.toBe(el2);
        expect(el2.children.length).toBeGreaterThan(0);
    });
});
