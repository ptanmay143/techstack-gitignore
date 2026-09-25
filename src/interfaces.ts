import { WriteStream } from "fs";


export interface GitIgnoreTemplate {
	name: string;
	path: string;
	download_url: string;
	type: string;
	sha?: string;
}

export interface GitIgnoreProvider {
	getTemplates(): Promise<GitIgnoreTemplate[]>;
	downloadToStream(templatePath: string, writeStream: WriteStream): Promise<void>;
}

export enum GitIgnoreOperationType {
	Update,
	Overwrite,
	/** Creates a backup of the existing file, then writes a fresh managed file */
	BackupAndReplace
}

export interface GitIgnoreOperation {
	type: GitIgnoreOperationType;
	/**
	 * Path to the .gitignore file to write to
	 */
	path: string;
	/**
	 * gitignore template files to use
	 */
	templates: GitIgnoreTemplate[];
	/**
	 * When set, this string is used as the Custom Rules section verbatim
	 * instead of being derived from the existing file contents.
	 * Used by the Migrate flow to preserve an external .gitignore's content.
	 */
	customContentOverride?: string;
}
