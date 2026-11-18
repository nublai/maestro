/**
 * An in-memory OutcomeStoreFs that models what survives a crash: file bytes
 * are durable only after `fsync` of their file, and names (create, rename,
 * link, unlink) only after `fsync` of their directory. `crashImage()` is the
 * filesystem a restarted process would see. A hook can stop the "process"
 * before or after any operation; every later operation then fails too.
 */
import { dirname } from "node:path";
import type { OutcomeStoreFs } from "../../maestro/runtime/file-outcome-store.ts";

export class Crash extends Error {
	constructor(op: string) {
		super(`simulated crash at ${op}`);
		this.name = "Crash";
	}
}

interface Inode {
	data: Buffer;
	durable: Buffer;
	mode: number;
}

interface Handle {
	path: string;
	inode?: Inode;
	dir?: string;
	append: boolean;
	pos: number;
}

export interface FsOp {
	index: number;
	op: string;
	path: string;
}

function fsError(code: string, op: string, path: string): Error {
	return Object.assign(new Error(`${code}: ${op} ${path}`), { code });
}

export class DurableFs implements OutcomeStoreFs {
	private readonly dirs = new Set<string>();
	private names = new Map<string, Inode>();
	private durableNames = new Map<string, Inode>();
	private readonly handles = new Map<number, Handle>();
	private nextFd = 3;
	private crashed = false;
	/** Every operation, in order. */
	readonly ops: FsOp[] = [];
	/** Throw (for example `Crash`) before or after an operation. */
	hook?: (op: FsOp, phase: "before" | "after") => void;
	/** Reversion probe: fsync does nothing, as if it were removed. */
	fsyncIsNoop = false;
	/** Fault injection for one operation, before it changes anything. */
	fault?: (op: FsOp) => Error | undefined;

	private run<T>(op: string, path: string, body: () => T): T {
		const entry = { index: this.ops.length, op, path };
		if (this.crashed) throw new Crash(`${op} after crash`);
		this.ops.push(entry);
		this.guard(entry, "before");
		const error = this.fault?.(entry);
		if (error) throw error;
		const value = body();
		this.guard(entry, "after");
		return value;
	}

	private guard(op: FsOp, phase: "before" | "after"): void {
		try {
			this.hook?.(op, phase);
		} catch (error) {
			if (error instanceof Crash) this.crashed = true;
			throw error;
		}
	}

	/** What a restarted process would read: only fsynced bytes and names. */
	crashImage(): DurableFs {
		const image = new DurableFs();
		for (const dir of this.dirs) image.dirs.add(dir);
		const copies = new Map<Inode, Inode>();
		for (const [path, inode] of this.durableNames) {
			let copy = copies.get(inode);
			if (!copy) {
				copy = {
					data: Buffer.from(inode.durable),
					durable: Buffer.from(inode.durable),
					mode: inode.mode,
				};
				copies.set(inode, copy);
			}
			image.names.set(path, copy);
			image.durableNames.set(path, copy);
		}
		return image;
	}

	/** The current (volatile) bytes of a file, for assertions. */
	contents(path: string): Buffer | undefined {
		const inode = this.names.get(path);
		return inode && Buffer.from(inode.data);
	}

	mode(path: string): number | undefined {
		return this.names.get(path)?.mode;
	}

	list(dir: string): string[] {
		return [...this.names.keys()].filter((path) => dirname(path) === dir);
	}

	mkdirSync(path: string, options: { recursive: true; mode: number }): void {
		this.run("mkdir", path, () => {
			// Directories are modelled as durable once created.
			let current = path;
			while (!this.dirs.has(current) && current !== dirname(current)) {
				this.dirs.add(current);
				current = dirname(current);
			}
			void options;
		});
	}

	openSync(path: string, flags: string, mode = 0o666): number {
		return this.run(`open:${flags}`, path, () => {
			const fd = this.nextFd++;
			if (this.dirs.has(path)) {
				this.handles.set(fd, { path, dir: path, append: false, pos: 0 });
				return fd;
			}
			if (!this.dirs.has(dirname(path))) throw fsError("ENOENT", "open", path);
			let inode = this.names.get(path);
			if (flags === "wx" && inode) throw fsError("EEXIST", "open", path);
			if (flags === "r" && !inode) throw fsError("ENOENT", "open", path);
			if (!inode) {
				inode = { data: Buffer.alloc(0), durable: Buffer.alloc(0), mode };
				this.names.set(path, inode);
			} else if (flags === "w") inode.data = Buffer.alloc(0);
			this.handles.set(fd, { path, inode, append: flags === "a", pos: 0 });
			return fd;
		});
	}

	private handle(fd: number): Handle {
		const handle = this.handles.get(fd);
		if (!handle) throw fsError("EBADF", "fd", String(fd));
		return handle;
	}

	writeSync(
		fd: number,
		buffer: Uint8Array,
		offset: number,
		length: number,
	): number {
		const handle = this.handle(fd);
		return this.run("write", handle.path, () => {
			const inode = handle.inode;
			if (!inode) throw fsError("EISDIR", "write", handle.path);
			const chunk = Buffer.from(buffer.subarray(offset, offset + length));
			if (handle.append) inode.data = Buffer.concat([inode.data, chunk]);
			else {
				const before = inode.data.subarray(0, handle.pos);
				const after = inode.data.subarray(handle.pos + chunk.length);
				inode.data = Buffer.concat([before, chunk, after]);
				handle.pos += chunk.length;
			}
			return chunk.length;
		});
	}

	fsyncSync(fd: number): void {
		const handle = this.handle(fd);
		this.run(handle.dir ? "fsync:dir" : "fsync", handle.path, () => {
			if (this.fsyncIsNoop) return;
			if (handle.inode) {
				handle.inode.durable = Buffer.from(handle.inode.data);
				return;
			}
			const dir = handle.dir!;
			for (const path of this.durableNames.keys())
				if (dirname(path) === dir && !this.names.has(path))
					this.durableNames.delete(path);
			for (const [path, inode] of this.names)
				if (dirname(path) === dir) this.durableNames.set(path, inode);
		});
	}

	ftruncateSync(fd: number, length: number): void {
		const handle = this.handle(fd);
		this.run("ftruncate", handle.path, () => {
			const inode = handle.inode!;
			inode.data =
				length <= inode.data.length
					? Buffer.from(inode.data.subarray(0, length))
					: Buffer.concat([
							inode.data,
							Buffer.alloc(length - inode.data.length),
						]);
		});
	}

	closeSync(fd: number): void {
		const handle = this.handle(fd);
		this.run("close", handle.path, () => {
			this.handles.delete(fd);
		});
	}

	readFileSync(path: string): Buffer {
		return this.run("read", path, () => {
			if (this.dirs.has(path)) throw fsError("EISDIR", "read", path);
			const inode = this.names.get(path);
			if (!inode) throw fsError("ENOENT", "read", path);
			return Buffer.from(inode.data);
		});
	}

	renameSync(from: string, to: string): void {
		this.run("rename", `${from} -> ${to}`, () => {
			const inode = this.names.get(from);
			if (!inode) throw fsError("ENOENT", "rename", from);
			this.names.delete(from);
			this.names.set(to, inode);
		});
	}

	linkSync(existing: string, link: string): void {
		this.run("link", `${existing} -> ${link}`, () => {
			const inode = this.names.get(existing);
			if (!inode) throw fsError("ENOENT", "link", existing);
			if (this.names.has(link)) throw fsError("EEXIST", "link", link);
			this.names.set(link, inode);
		});
	}

	unlinkSync(path: string): void {
		this.run("unlink", path, () => {
			if (!this.names.delete(path)) throw fsError("ENOENT", "unlink", path);
		});
	}
}
