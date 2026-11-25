// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { StationJob, StationMachine } from "./stationMachine";

interface StoredJob {
    id: string;
    name: string;
    source: StationJob["source"];
}

/**
 * The queue kept on the station's disk (/api/jobs), so a restart of the screen or of the station
 * does not lose it: the stored jobs come back at start, a job added here is stored, and a job that
 * leaves the queue (removed, or done) is deleted.
 */
export class JobStore {
    private readonly stored = new Map<number, string>(); // machine job id → stored id

    constructor(
        private readonly machine: StationMachine,
        private readonly base = "",
    ) {
        machine.onChange(() => this.forgetGone());
    }

    /** Brings the stored jobs back into the queue. */
    async restore() {
        const list = (await (await fetch(`${this.base}/api/jobs`)).json()) as StoredJob[];
        for (const j of list) {
            const text = await (await fetch(`${this.base}/api/jobs/${j.id}`)).text();
            const job = this.machine.addJob(j.name, text, j.source);
            this.stored.set(job.id, j.id);
        }
    }

    /** Adds a job to the queue and stores it. */
    add(name: string, text: string, source: StationJob["source"]): StationJob {
        const job = this.machine.addJob(name, text, source);
        void fetch(`${this.base}/api/jobs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, text, source }),
        })
            .then((r) => r.json() as Promise<{ id: string }>)
            .then(({ id }) => {
                this.stored.set(job.id, id);
                this.forgetGone(); // removed while it was being stored
            })
            .catch(() => {});
        return job;
    }

    private forgetGone() {
        const queued = new Set(this.machine.snapshot().queue.map((j) => j.id));
        for (const [jobId, storedId] of this.stored) {
            if (queued.has(jobId)) continue;
            this.stored.delete(jobId);
            void fetch(`${this.base}/api/jobs/${storedId}`, { method: "DELETE" }).catch(() => {});
        }
    }
}
