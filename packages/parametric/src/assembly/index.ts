// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { NodeCategories } from "@chili3d/core";
import { JointNode } from "./jointNode";

export * from "./assemblyService";
export * from "./assemblySolver";
export * from "./jointMath";
export * from "./jointNode";
export * from "./jointOrigin";

NodeCategories.register((node) => (node instanceof JointNode ? "joint" : undefined));
