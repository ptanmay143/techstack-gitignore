import { WriteStream } from "fs";


export interface GitignoreTemplate {
	name: string;
	path: string;
	download_url: string;
	type: string;
	sha?: string;
}

export interface GitignoreProvider {
	getTemplates(): Promise<GitignoreTemplate[]>;
	downloadToStream(templatePath: string, writeStream: WriteStream): Promise<void>;
}

export enum GitignoreOperationType {
	Update,
	Overwrite,
	/** Creates a backup of the existing file, then writes a fresh managed file */
	BackupAndReplace
}

export interface GitignoreOperation {
	type: GitignoreOperationType;
	/**
	 * Path to the .gitignore file to write to
	 */
	path: string;
	/**
	 * gitignore template files to use
	 */
	templates: GitignoreTemplate[];
	/**
	 * When set, this string is used as the Custom Rules section verbatim
	 * instead of being derived from the existing file contents.
	 * Used by the Migrate flow to preserve an external .gitignore's content.
	 */
	customContentOverride?: string;
}
