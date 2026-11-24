// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The screen shown while the wasm kernel starts: a dark page with a warm glow, an orange ring
 * turning round the logo and the name. Colours are written out because the theme's variables
 * are not set yet at this point.
 */
export class Loading extends HTMLElement {
    constructor() {
        super();
        this.initAnimation();
        this.style.cssText = `
            position: fixed;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 22px;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 9999;
            font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
            background:
                radial-gradient(40% 35% at 50% 42%, rgba(255, 122, 26, 0.22), transparent 70%),
                #111215;
        `;
        this.append(this.spinner(), this.label());
    }

    private spinner() {
        const ring = document.createElement("div");
        ring.style.cssText = `
            width: 64px;
            height: 64px;
            border-radius: 50%;
            background: conic-gradient(from 0deg, rgba(255, 122, 26, 0), #ffa24a 55%, #ff5f14 100%);
            -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px));
            mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px));
            filter: drop-shadow(0 0 10px rgba(255, 122, 26, 0.6));
            animation: kernSpin 0.9s linear infinite;
        `;
        return ring;
    }

    private label() {
        const name = document.createElement("div");
        name.textContent = "Kern3D";
        name.style.cssText = `
            font-size: 20px;
            font-weight: 700;
            letter-spacing: 0.18em;
            background: linear-gradient(90deg, #f1eeea 0%, #f1eeea 35%, #ffa24a 50%, #f1eeea 65%, #f1eeea 100%);
            background-size: 220% 100%;
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            animation: kernShimmer 1.8s ease-in-out infinite;
        `;
        const hint = document.createElement("div");
        hint.textContent = "Loading…";
        hint.style.cssText = "font-size: 12px; letter-spacing: 0.08em; color: #7d7770; margin-top: -12px;";
        const box = document.createElement("div");
        box.style.cssText = "display: flex; flex-direction: column; align-items: center; gap: 14px;";
        box.append(name, hint);
        return box;
    }

    private initAnimation() {
        const styleSheet = document.createElement("style");
        styleSheet.textContent = `
          @keyframes kernSpin {
            to { transform: rotate(360deg); }
          }
          @keyframes kernShimmer {
            from { background-position: 110% 0; }
            to { background-position: -10% 0; }
          }
        `;
        document.head.appendChild(styleSheet);
    }
}

customElements.define("chili-loading", Loading);
