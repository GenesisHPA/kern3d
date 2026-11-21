// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, Id, Node, serializable, serialize } from "@chili3d/core";
import { defaultLaserJob, type LaserJobData, parseLaserJob, stringifyLaserJob } from "./laserData";

export interface LaserNodeOptions {
    document: IDocument;
    name: string;
    id?: string;
    content?: string;
}

/**
 * A laser job in the document tree: the objects placed on the bed (imported outlines and
 * pictures, outlines taken from the model) with how each is burnt, as one JSON string — the
 * same single-field shape a drawing keeps, so an edit is one undo step and the persisted form is
 * `{ __cla$$__: "LaserNode", id, name, visible, userData, content }`. Pictures travel inside it
 * as data URLs, so a job reopens complete on another computer.
 */
@serializable()
export class LaserNode extends Node {
    get icon(): string {
        return "icon-layer-group";
    }

    constructor(options: LaserNodeOptions) {
        super(options.document, options.name, options.id ?? Id.generate());
        this.setPrivateValue("content", options.content ?? stringifyLaserJob(defaultLaserJob()));
    }

    @serialize()
    get content(): string {
        return this.getPrivateValue("content");
    }
    set content(value: string) {
        this.setProperty("content", value);
    }

    /** A fresh copy of the parsed job; edit it and hand it back to `setData`. */
    get data(): LaserJobData {
        return parseLaserJob(this.content);
    }

    setData(data: LaserJobData) {
        this.content = stringifyLaserJob(data);
    }

    protected onVisibleChanged(): void {}

    protected onParentVisibleChanged(): void {}
}
