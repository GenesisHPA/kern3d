// Part of the Kern3D project (based on Chili3D), under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { getCurrentApplication, type IDocument, Transaction, workspaceTabs } from "@chili3d/core";
import { LaserEditor } from "./laserEditor";
import style from "./laserEditor.module.css";
import { type LaserJobMode, modeOf, newLaserJob, setLaserHomeOpener } from "./laserJobs";
import { LaserNode } from "./laserNode";
import { el, t } from "./laserUi";

const TAB_ID = "laser-home";

/** What each card says: its title, a line on what it is for, and what it can do. */
const MODES: { mode: LaserJobMode; icon: string; title: string; lead: string; points: string[] }[] = [
    {
        mode: "flat",
        icon: "▭",
        title: "laser.home.flat",
        lead: "laser.home.flat.lead",
        points: ["laser.home.flat.p1", "laser.home.flat.p2", "laser.home.flat.p3", "laser.home.flat.p4"],
    },
    {
        mode: "rotary",
        icon: "◎",
        title: "laser.home.rotary",
        lead: "laser.home.rotary.lead",
        points: [
            "laser.home.rotary.p1",
            "laser.home.rotary.p2",
            "laser.home.rotary.p3",
            "laser.home.rotary.p4",
        ],
    },
];

/**
 * The «Лазер» workspace's own page: two large cards, flat engraving and engraving round a part
 * in the rotary chuck — what each is for, «Новый проект», and the document's projects of that
 * kind to open. It covers the model (and its browser) as a job does; a job opened from it
 * comes to the front, and the job's «Режимы» button brings this page back.
 */
class LaserStartPage {
    private readonly dialog = document.createElement("dialog");

    constructor() {
        this.dialog.className = style.dialog;
    }

    private get document(): IDocument | undefined {
        return getCurrentApplication().activeView?.document;
    }

    readonly tab = {
        id: TAB_ID,
        title: () => t("laser.home.tab"),
        icon: "icon-layer-group",
        show: () => this.show(),
        hide: () => {
            if (this.dialog.open) this.dialog.close();
        },
        close: () => {
            if (this.dialog.open) this.dialog.close();
            this.dialog.remove();
            workspaceTabs.remove(TAB_ID);
        },
    };

    private show() {
        if (!this.dialog.isConnected) document.body.append(this.dialog);
        this.render();
        if (!this.dialog.open) this.dialog.show();
    }

    /** Renames a project (one undo step); the open job's tab follows. */
    private rename(job: LaserNode) {
        const name = window.prompt(t("laser.home.renamePrompt"), job.name)?.trim();
        if (!name || name === job.name) return;
        Transaction.execute(job.document, "laser.rename", () => {
            job.name = name;
        });
        this.render();
    }

    /** Deletes a project after asking (one undo step: Ctrl+Z brings it back). */
    private remove(job: LaserNode) {
        if (!window.confirm(t("laser.home.deleteConfirm", job.name))) return;
        LaserEditor.closeFor(job.id);
        const document = job.document;
        Transaction.execute(document, "laser.delete", () => job.parent?.remove(job));
        this.render();
    }

    private render() {
        const document = this.document;
        const jobs = document
            ? (document.modelManager.findNodes((n) => n instanceof LaserNode) as LaserNode[])
            : [];
        const cards = MODES.map((m) => {
            const mine = jobs.filter((j) => modeOf(j) === m.mode).reverse();
            const create = el("button", {
                className: style.homePrimary,
                textContent: `+ ${t("laser.newJob")}`,
                onclick: () => {
                    if (document !== undefined) LaserEditor.open(newLaserJob(document, m.mode));
                },
            });
            const recent =
                mine.length === 0
                    ? [el("div", { className: style.muted, textContent: t("laser.home.none") })]
                    : mine.slice(0, 6).map((job) =>
                          el(
                              "div",
                              { className: style.homeJobRow },
                              el("button", {
                                  className: style.homeJob,
                                  textContent: job.name,
                                  onclick: () => LaserEditor.open(job),
                              }),
                              el("button", {
                                  className: style.homeRename,
                                  textContent: "✎",
                                  title: t("laser.home.rename"),
                                  onclick: () => this.rename(job),
                              }),
                              el("button", {
                                  className: style.homeDelete,
                                  textContent: "✕",
                                  title: t("laser.home.delete"),
                                  onclick: () => this.remove(job),
                              }),
                          ),
                      );
            return el(
                "div",
                { className: style.homeCard },
                el(
                    "div",
                    { className: style.homeHead },
                    el("span", { className: style.homeIcon, textContent: m.icon }),
                    el("span", { className: style.homeTitle, textContent: t(m.title) }),
                ),
                el("div", { className: style.homeLead, textContent: t(m.lead) }),
                el(
                    "ul",
                    { className: style.homePoints },
                    ...m.points.map((p) => el("li", { textContent: t(p) })),
                ),
                create,
                el("div", { className: style.homeRecentTitle, textContent: t("laser.home.recent") }),
                el("div", { className: style.homeRecent }, ...recent),
            );
        });
        this.dialog.replaceChildren(
            el(
                "div",
                { className: style.home },
                el(
                    "div",
                    { className: style.homeTop },
                    el("span", { className: style.homeHeading, textContent: t("laser.home.heading") }),
                    el("button", {
                        textContent: t("laser.toModel"),
                        onclick: () => workspaceTabs.activate(undefined),
                    }),
                ),
                el("div", { className: style.homeCards }, ...cards),
            ),
        );
    }
}

let page: LaserStartPage | undefined;

/** Brings the «Лазер» page to the front (opening its tab once). */
export function showLaserHome() {
    page ??= new LaserStartPage();
    workspaceTabs.open(page.tab);
}

setLaserHomeOpener(showLaserHome);
