// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "./document";
import type { IProgress } from "./foundation";
import type { VisualNode } from "./model";

export interface IDataExchange {
    importFormats(): string[];
    exportFormats(): string[];
    /** `progress`: the import window's bar and stage (a file at a time; «Отмена» between files). */
    import(document: IDocument, files: FileList | File[], progress?: IProgress): Promise<void>;
    export(type: string, nodes: VisualNode[]): Promise<BlobPart[] | undefined>;
}
