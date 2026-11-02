// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, Id, Node, serializable, serialize } from "@chili3d/core";
import { type DrawingData, defaultDrawingData, parseDrawingData, stringifyDrawingData } from "./drawingData";

export interface DrawingNodeOptions {
    document: IDocument;
    name: string;
    id?: string;
    content?: string;
}

/**
 * A 2D drawing sheet in the document tree. It stores only the drawing's description — the
 * sheet, title block, views and annotations — as one JSON string: the views' line work is
 * projected again from the model nodes they name whenever the drawing is opened or exported,
 * so it follows every change of the model. One string field keeps undo atomic (a drawing edit
 * is one snapshot) and the persisted shape simple: `{ __cla$$__: "DrawingNode", id, name,
 * visible, userData, content }`.
 */
@serializable()
export class DrawingNode extends Node {
    get icon(): string {
        return "icon-file-plus";
    }

    constructor(options: DrawingNodeOptions) {
        super(options.document, options.name, options.id ?? Id.generate());
        this.setPrivateValue("content", options.content ?? stringifyDrawingData(defaultDrawingData()));
    }

    @serialize()
    get content(): string {
        return this.getPrivateValue("content");
    }
    set content(value: string) {
        this.setProperty("content", value);
    }

    /** A fresh copy of the parsed description; edit it and hand it back to `setData`. */
    get data(): DrawingData {
        return parseDrawingData(this.content);
    }

    setData(data: DrawingData) {
        this.content = stringifyDrawingData(data);
    }

    protected onVisibleChanged(): void {}

    protected onParentVisibleChanged(): void {}
}
