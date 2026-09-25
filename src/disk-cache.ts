import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const CACHE_FILE_NAME = 'template-cache.json';
const FLUSH_DEBOUNCE_MS = 500;

/**
 * Persistent disk cache for gitignore template content.
 *
 * Template file contents are stored in a JSON file inside the extension's
 * global storage directory (managed by VS Code, not tied to any workspace).
 * Cache keys are SHA-based, so a template is only re-downloaded when the
 * upstream commit changes.
 */
export class DiskCache {
	private storePath: string;
	private store: Record<string, string> = {};
	private loaded = false;
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private dirty = false;

	constructor(globalStorageUri: vscode.Uri) {
		this.storePath = path.join(globalStorageUri.fsPath, CACHE_FILE_NAME);
	}

	/**
	 * Retrieve a cached template content string by key.
	 * Returns undefined if the key is not in the cache.
	 */
	public get(key: string): string | undefined {
		this.ensureLoaded();
		return this.store[key];
	}

	/**
	 * Store a template content string in the cache.
	 * Changes are flushed to disk asynchronously (debounced).
	 */
	public set(key: string, value: string): void {
		this.ensureLoaded();
		this.store[key] = value;
		this.dirty = true;
		this.scheduleFlush();
	}

	/**
	 * Ensure the cache has been loaded from disk.
	 * This is a synchronous read so it must only be called once at startup.
	 */
	private ensureLoaded(): void {
		if (this.loaded) {
			return;
		}
		this.loaded = true;
		try {
			const raw = fs.readFileSync(this.storePath, { encoding: 'utf8' });
		const parsed = JSON.parse(raw) as Record<string, string> | null;
			if (parsed && typeof parsed === 'object') {
				this.store = parsed;
				console.log(`techstack-gitignore: disk cache loaded from ${this.storePath} (${Object.keys(this.store).length} entries)`);
			}
		} catch {
			// File doesn't exist yet or is corrupt — start with an empty cache.
			this.store = {};
			console.log(`techstack-gitignore: disk cache is empty or not yet created at ${this.storePath}`);
		}
	}

	/**
	 * Debounced flush: writes the cache to disk at most once every FLUSH_DEBOUNCE_MS.
	 */
	private scheduleFlush(): void {
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flushToDisk();
		}, FLUSH_DEBOUNCE_MS);
	}

	/**
	 * Synchronously write the cache to disk.
	 * Called on flush and also exposed so callers can force a flush on deactivation.
	 */
	public flushToDisk(): void {
		if (!this.dirty) {
			return;
		}
		try {
			const dir = path.dirname(this.storePath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			fs.writeFileSync(this.storePath, JSON.stringify(this.store), { encoding: 'utf8' });
			this.dirty = false;
			console.log(`techstack-gitignore: disk cache flushed to ${this.storePath}`);
		} catch (err) {
			console.error(`techstack-gitignore: failed to flush disk cache: ${String(err)}`);
		}
	}

	/**
	 * Cancel any pending flush timer and perform a final flush.
	 * Call this from the extension's deactivate() hook.
	 */
	public dispose(): void {
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		this.flushToDisk();
	}
}
