import * as vscode from 'vscode';
import * as fs from 'fs';
import { dirname, join as joinPath } from 'path';

import { Cache } from './cache';
import { DiskCache } from './disk-cache';
import { GitignoreTemplate, GitignoreOperation, GitignoreOperationType, GitignoreProvider } from './interfaces';
import { GithubGitignoreRepositoryProvider } from './providers/github-gitignore-repository';
import { AuthenticationCancellationError, GithubContext, GithubSession } from './github/session';
import { GithubApiRateLimitReachedError } from './github/client';


// ─── Internal error types ─────────────────────────────────────────────────────

class CancellationError extends Error {}

// ─── QuickPick item interfaces ────────────────────────────────────────────────

interface GitignoreQuickPickItem extends vscode.QuickPickItem {
	template: GitignoreTemplate;
}

interface ExternalFileActionItem extends vscode.QuickPickItem {
	action: ExternalFileAction;
}

// ─── Public data types ────────────────────────────────────────────────────────

export interface GitignoreTemplateContent {
	template: GitignoreTemplate;
	content: string;
}

export interface GitignoreFileState {
	customContent: string;
	templateIds: Set<string>;
}

// ─── Enums ────────────────────────────────────────────────────────────────────

/** Describes the current state of an existing .gitignore file */
enum ExistingFileKind {
	/** No .gitignore file present in the workspace root */
	None,
	/** File exists and contains extension-managed section markers */
	ExtensionManaged,
	/** File exists but was not created / managed by this extension */
	External
}

/** Actions available when an external (unmanaged) .gitignore is found */
enum ExternalFileAction {
	/** Preserve existing content — place it in the Custom Rules section */
	Migrate,
	/** Write a backup file, then start fresh with templates only */
	BackupAndReplace,
	/** Discard existing content entirely and start fresh */
	Replace
}

// ─── File-format constants (internal — not user-configurable) ─────────────────
//
// These strings are baked into every managed .gitignore file. Changing them
// would break round-trip parsing of existing files, so they are intentionally
// kept as code constants rather than user settings.

const separator              = '# ----------------------------------------------------------------------';
const customRulesHeader      = '# Custom ignore rules';
const templatesHeader        = '# GitHub gitignore templates';
const templateHeaderPrefix   = '# Template: ';
const templateSourcePrefix   = '# Source: github/gitignore/';
const templateSummaryPrefix  = '# Templates: ';
const customRulesInstruction = '# Add project-specific ignore rules in this section. The extension preserves this content.';

// ─── In-memory template-list cache (lives for the extension lifetime) ─────────

const cache = createCache();

function createCache(): Cache {
	const config = vscode.workspace.getConfiguration('gitignore');
	const cacheExpirationInterval = config.get('cacheExpirationInterval', 3600);
	console.log(`techstack-gitignore: creating cache with cacheExpirationInterval: ${cacheExpirationInterval}`);
	return new Cache(cacheExpirationInterval);
}

// ─── Workspace resolution ─────────────────────────────────────────────────────

/**
 * Returns the workspace folder path.
 * Prompts for selection when multiple workspace folders are open.
 */
async function resolveWorkspaceFolderPath(): Promise<string> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders) {
		throw new CancellationError();
	} else if (folders.length === 1) {
		return folders[0].uri.fsPath;
	} else {
		const folder = await vscode.window.showWorkspaceFolderPick();
		if (!folder) {
			throw new CancellationError();
		}
		return folder.uri.fsPath;
	}
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function checkIfFileExists(filePath: string): Promise<boolean> {
	return new Promise((resolve) => {
		fs.stat(filePath, (err) => resolve(!err));
	});
}

async function readFileIfExists(filePath: string): Promise<string> {
	if (!await checkIfFileExists(filePath)) {
		return '';
	}
	return fs.promises.readFile(filePath, { encoding: 'utf8' });
}

function normalizeLineEndings(content: string): string {
	return content.replace(/\r\n?/g, '\n');
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Classifies the state of a .gitignore file:
 *   - None            → file does not exist
 *   - ExtensionManaged → file contains section markers written by this extension
 *   - External        → file exists but has no recognised extension markers
 */
function detectExistingFileKind(exists: boolean, content: string): ExistingFileKind {
	if (!exists) {
		return ExistingFileKind.None;
	}
	const hasSourceMarkers  = getTemplateMarkerIds(content).size > 0;
	const hasManagedHeaders = content.includes(customRulesHeader) && content.includes(templatesHeader);

	return (hasSourceMarkers || hasManagedHeaders)
		? ExistingFileKind.ExtensionManaged
		: ExistingFileKind.External;
}

// ─── Template download ────────────────────────────────────────────────────────

async function downloadTemplateContent(
	gitignoreRepository: GitignoreProvider,
	template: GitignoreTemplate,
	directory: string
): Promise<GitignoreTemplateContent> {
	const tempFileName = `.gitignore-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
	const tempPath = joinPath(directory, tempFileName);
	const fileStream = fs.createWriteStream(tempPath, { flags: 'w' });
	try {
		await gitignoreRepository.downloadToStream(template.path, fileStream);
		const content = await fs.promises.readFile(tempPath, { encoding: 'utf8' });
		return { template, content: normalizeLineEndings(content).trimEnd() };
	} finally {
		await fs.promises.rm(tempPath, { force: true });
	}
}

export async function downloadTemplateContents(
	gitignoreRepository: GitignoreProvider,
	templates: GitignoreTemplate[],
	directory: string,
	concurrency: number
): Promise<GitignoreTemplateContent[]> {
	const contents: GitignoreTemplateContent[] = [];
	const queue = sortTemplates(templates);
	const workerCount = Math.min(concurrency, queue.length);
	const workers = Array.from({ length: workerCount }, async () => {
		let template = queue.shift();
		while (template) {
			contents.push(await downloadTemplateContent(gitignoreRepository, template, directory));
			template = queue.shift();
		}
	});
	await Promise.all(workers);
	return contents.sort((a, b) => compareTemplates(a.template, b.template));
}

// ─── File writing ─────────────────────────────────────────────────────────────

export async function downloadGitignoreFile(
	gitignoreRepository: GitignoreProvider,
	operation: GitignoreOperation,
	concurrency: number
): Promise<void> {
	const existingContent = await readFileIfExists(operation.path);
	const templateContents = await downloadTemplateContents(
		gitignoreRepository, operation.templates, dirname(operation.path), concurrency
	);
	const state = getGitignoreFileState(existingContent, templateContents);

	// customContentOverride lets callers (e.g. the Migrate path) inject the
	// Custom Rules content directly instead of deriving it from the existing file.
	const customContent = operation.customContentOverride !== undefined
		? operation.customContentOverride
		: state.customContent;

	const content = renderGitignoreFile(customContent, templateContents);

	try {
		await fs.promises.writeFile(operation.path, content, { encoding: 'utf8' });
	} catch (error) {
		// If we just created the file, remove it so we don't leave a partial write
		if (operation.type === GitignoreOperationType.Overwrite ||
		    operation.type === GitignoreOperationType.BackupAndReplace) {
			fs.unlink(operation.path, err => {
				if (err) {
					console.error(`techstack-gitignore: ${err.message}`);
				}
			});
		}
		throw error;
	}
}

// ─── Content parsing ──────────────────────────────────────────────────────────

function compareTemplates(a: GitignoreTemplate, b: GitignoreTemplate): number {
	const nameComparison = a.name.localeCompare(b.name);
	if (nameComparison !== 0) {
		return nameComparison;
	}
	return a.path.localeCompare(b.path);
}

function sortTemplates<T extends GitignoreTemplate>(templates: T[]): T[] {
	return [...templates].sort(compareTemplates);
}

function getTemplateId(template: GitignoreTemplate): string {
	return template.path || template.name;
}

function getTemplateMarkerIds(content: string): Set<string> {
	const ids = new Set<string>();
	for (const line of normalizeLineEndings(content).split('\n')) {
		if (line.startsWith(templateSourcePrefix)) {
			ids.add(line.slice(templateSourcePrefix.length).trim());
		}
	}
	return ids;
}

function stripTemplateContent(customContent: string, templateContents: GitignoreTemplateContent[]): string {
	let nextContent = normalizeLineEndings(customContent);
	for (const templateContent of templateContents) {
		const content = templateContent.content.trim();
		if (content.length > 0) {
			nextContent = nextContent.replace(content, '');
		}
	}
	return nextContent.replace(/\n{3,}/g, '\n\n').trim();
}

function getManagedCustomContent(content: string): string | undefined {
	const normalizedContent = normalizeLineEndings(content);

	const customStart = normalizedContent.indexOf(customRulesHeader);
	const templateStart = normalizedContent.indexOf(templatesHeader);

	if (customStart === -1 || templateStart === -1 || templateStart <= customStart) {
		return undefined;
	}

	return normalizedContent
		.slice(customStart + customRulesHeader.length, templateStart)
		.replace(/^\n/, '')
		.replace(new RegExp(`^${separator}\\n?`), '')
		.replace(customRulesInstruction, '')
		.trim();
}

export function getGitignoreFileState(content: string, templateContents: GitignoreTemplateContent[]): GitignoreFileState {
	const normalizedContent = normalizeLineEndings(content);
	const managedCustomContent = getManagedCustomContent(normalizedContent);
	const templateIds = getTemplateMarkerIds(normalizedContent);

	const detectedTemplateContents = templateContents.filter(templateContent => {
		const templateContentText = templateContent.content.trim();
		return templateIds.has(getTemplateId(templateContent.template)) ||
			(templateContentText.length > 0 && normalizedContent.includes(templateContentText));
	});

	for (const templateContent of detectedTemplateContents) {
		templateIds.add(getTemplateId(templateContent.template));
	}

	const customContent = managedCustomContent ?? stripTemplateContent(normalizedContent, detectedTemplateContents);
	return { customContent, templateIds };
}

export function renderGitignoreFile(customContent: string, templateContents: GitignoreTemplateContent[]): string {
	const custom = customContent.trim();
	const sortedTemplateContents = [...templateContents].sort((a, b) => compareTemplates(a.template, b.template));
	const templateNames = sortedTemplateContents.map(tc => tc.template.name).join(', ') || 'none';

	const parts = [
		separator,
		customRulesHeader,
		separator,
		customRulesInstruction,
		custom,
		'',
		separator,
		templatesHeader,
		`${templateSummaryPrefix}${templateNames}`,
		separator
	].filter((part, index) => index !== 4 || part.length > 0);

	for (const templateContent of sortedTemplateContents) {
		parts.push(
			'',
			separator,
			`${templateHeaderPrefix}${templateContent.template.name}`,
			`${templateSourcePrefix}${getTemplateId(templateContent.template)}`,
			separator,
			templateContent.content.trim()
		);
	}

	return `${parts.join('\n')}\n`;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

/**
 * Splits items into selected/unselected, prefixes selected labels with $(check),
 * and places the selected group at the top of the list.
 */
function buildQuickPickItems(
	items: GitignoreQuickPickItem[],
	selectedTemplateIds: Set<string>
): { orderedItems: GitignoreQuickPickItem[]; preselected: GitignoreQuickPickItem[] } {
	const selected: GitignoreQuickPickItem[] = [];
	const unselected: GitignoreQuickPickItem[] = [];

	for (const item of items) {
		const isSelected =
			selectedTemplateIds.has(getTemplateId(item.template)) ||
			selectedTemplateIds.has(item.template.name);

		if (isSelected) {
			selected.push({ ...item, label: `$(check) ${item.label}` });
		} else {
			unselected.push(item);
		}
	}

	return { orderedItems: [...selected, ...unselected], preselected: selected };
}

/**
 * Shows the multi-select template picker.
 * Pre-selected items (from existing file + default setting) are pinned to the top
 * with a check-mark prefix.
 */
async function promptForTemplates(
	items: GitignoreQuickPickItem[],
	selectedTemplateIds: Set<string>,
	title: string,
	placeholder: string
): Promise<GitignoreTemplate[]> {
	return new Promise((resolve, reject) => {
		const quickPick = vscode.window.createQuickPick<GitignoreQuickPickItem>();
		const { orderedItems, preselected } = buildQuickPickItems(items, selectedTemplateIds);

		quickPick.title = title;
		quickPick.items = orderedItems;
		quickPick.canSelectMany = true;
		quickPick.matchOnDescription = true;
		quickPick.placeholder = placeholder;
		quickPick.selectedItems = preselected;

		quickPick.onDidAccept(() => {
			const selectedItems = [...quickPick.selectedItems];
			quickPick.hide();
			resolve(selectedItems.map(item => item.template));
		});
		quickPick.onDidHide(() => {
			quickPick.dispose();
			reject(new CancellationError());
		});
		quickPick.show();
	});
}

/**
 * Shows the action-picker for an external (unmanaged) .gitignore.
 * Options are ordered safest → most destructive.
 * Throws CancellationError if dismissed.
 */
async function promptExternalFileAction(backupSuffix: string): Promise<ExternalFileAction> {
	return new Promise((resolve, reject) => {
		const quickPick = vscode.window.createQuickPick<ExternalFileActionItem>();

		quickPick.title = 'Existing .gitignore detected';
		quickPick.placeholder = 'This .gitignore was not created by this extension — choose how to proceed';
		quickPick.matchOnDetail = true;
		quickPick.items = [
			{
				label: '$(files) Migrate — keep existing content as custom rules',
				description: 'Recommended',
				detail: 'Moves your current .gitignore content into the Custom Rules section and adds the selected templates below it. Nothing is lost.',
				action: ExternalFileAction.Migrate
			},
			{
				label: `$(save-as) Backup & replace`,
				detail: `Saves the current .gitignore as .gitignore${backupSuffix}, then creates a fresh managed file with the templates you select.`,
				action: ExternalFileAction.BackupAndReplace
			},
			{
				label: '$(trash) Replace — discard existing content',
				detail: 'Overwrites .gitignore entirely with the selected templates. Existing content will be permanently lost.',
				action: ExternalFileAction.Replace
			}
		];

		quickPick.onDidAccept(() => {
			// activeItems[0] is the keyboard-focused / highlighted item
			const selected = quickPick.activeItems[0];
			quickPick.hide();
			if (selected) {
				resolve(selected.action);
			} else {
				reject(new CancellationError());
			}
		});
		quickPick.onDidHide(() => {
			quickPick.dispose();
			reject(new CancellationError());
		});
		quickPick.show();
	});
}

/**
 * Shows a contextual success notification after the .gitignore has been written.
 */
function showSuccessMessage(operation: GitignoreOperation, backupPath?: string): Thenable<string | undefined> {
	const templateNames = operation.templates.map(t => t.name).join(', ');
	switch (operation.type) {
		case GitignoreOperationType.Update:
			return vscode.window.showInformationMessage(
				`.gitignore updated with templates: ${templateNames}`
			);
		case GitignoreOperationType.Overwrite:
			return vscode.window.showInformationMessage(
				`.gitignore created with templates: ${templateNames}`
			);
		case GitignoreOperationType.BackupAndReplace:
			return vscode.window.showInformationMessage(
				`.gitignore created with templates: ${templateNames}. Previous file saved as ${backupPath ?? '.gitignore.backup'}.`
			);
		default:
			throw new Error('Unsupported operation');
	}
}

// ─── Extension entry points ───────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	console.log('techstack-gitignore: extension activated');

	const githubContext = new GithubContext();

	// Persistent disk cache stored in VS Code's per-extension global storage
	const diskCache = new DiskCache(context.globalStorageUri);
	context.subscriptions.push({ dispose: () => diskCache.dispose() });

	const disposable = vscode.commands.registerCommand('gitignore.addgitignore', async () => {
		const githubSession = new GithubSession(githubContext);

		try {
			// Guard: a workspace must be open
			if (!vscode.workspace.workspaceFolders) {
				await vscode.window.showErrorMessage('No workspace/directory open');
				return;
			}

			// ── Read all user settings once ────────────────────────────────────
			const config = vscode.workspace.getConfiguration('gitignore');
			const cacheExpirationInterval: number = config.get('cacheExpirationInterval', 3600);
			const downloadConcurrency: number     = config.get('downloadConcurrency', 6);
			const backupSuffix: string            = config.get('backupSuffix', '.backup');
			const githubApiBaseUrl: string        = config.get('githubApiBaseUrl', 'https://api.github.com');
			const githubRepository: string        = config.get('githubRepository', 'github/gitignore');
			const defaultTemplates: string[]      = config.get('defaultTemplates', ['windows', 'linux', 'macos']);

			console.log(`techstack-gitignore: config — cacheExpiry=${cacheExpirationInterval}s, concurrency=${downloadConcurrency}, api=${githubApiBaseUrl}, repo=${githubRepository}`);

			// ── Resolve .gitignore path ─────────────────────────────────────────
			const workspacePath  = await resolveWorkspaceFolderPath();
			const gitignorePath  = joinPath(workspacePath, '.gitignore');
			const exists         = await checkIfFileExists(gitignorePath);
			const existingContent = await readFileIfExists(gitignorePath);

			// ── Classify the existing file ──────────────────────────────────────
			const fileKind = detectExistingFileKind(exists, existingContent);
			console.log(`techstack-gitignore: file kind = ${ExistingFileKind[fileKind]}`);

			// ── For external files, prompt for action BEFORE the network call ───
			// This gives immediate UI feedback and avoids a network round-trip
			// if the user decides to cancel.
			let externalAction: ExternalFileAction | undefined;
			if (fileKind === ExistingFileKind.External) {
				externalAction = await promptExternalFileAction(backupSuffix);
			}

			// ── Create provider with user-configured API URL and repository ─────
			const gitignoreRepository: GitignoreProvider = new GithubGitignoreRepositoryProvider(
				cache, githubSession, diskCache, githubApiBaseUrl, githubRepository
			);

			// ── Load template list (uses in-memory / disk cache when available) ─
			const templates = await gitignoreRepository.getTemplates();

			// ── Determine pre-selected templates ────────────────────────────────
			// For extension-managed files, detect existing template IDs from markers.
			// For external files, there are none — start with an empty selection.
			const existingTemplateContents =
				fileKind === ExistingFileKind.ExtensionManaged &&
				getTemplateMarkerIds(existingContent).size < 1
					? await downloadTemplateContents(gitignoreRepository, templates, workspacePath, downloadConcurrency)
					: [];

			const existingState = fileKind === ExistingFileKind.ExtensionManaged
				? getGitignoreFileState(existingContent, existingTemplateContents)
				: { customContent: '', templateIds: new Set<string>() };

			// Merge default templates into the selected set
			const allSelectedIds = new Set(existingState.templateIds);
			for (const defaultName of defaultTemplates) {
				const matched = templates.find(t => t.name.toLowerCase() === defaultName.toLowerCase());
				if (matched) {
					allSelectedIds.add(getTemplateId(matched));
					allSelectedIds.add(matched.name);
				}
			}

			// ── Build QuickPick items (selected items pinned to top) ─────────────
			const items = sortTemplates(templates).map(t => ({
				label: t.name,
				description: t.path,
				template: t
			}));

			// ── Contextual QuickPick title + placeholder ──────────────────────
			const pickerContext = (() => {
				switch (fileKind) {
					case ExistingFileKind.None:
						return {
							title: 'Create .gitignore',
							placeholder: 'No .gitignore found — select templates to create one from scratch'
						};
					case ExistingFileKind.ExtensionManaged:
						return {
							title: 'Update .gitignore',
							placeholder: 'Updating your managed .gitignore — adjust the template selection below'
						};
					case ExistingFileKind.External:
						return {
							title: 'Select templates for new .gitignore',
							placeholder: 'Choose the templates to include in your new managed .gitignore'
						};
				}
			})();

			const selectedTemplates = await promptForTemplates(
				items, allSelectedIds, pickerContext.title, pickerContext.placeholder
			);

			if (selectedTemplates.length < 1) {
				throw new CancellationError();
			}

			// ── Resolve the operation based on file kind + external action ───────
			let operationType: GitignoreOperationType = GitignoreOperationType.Overwrite;
			let customContentOverride: string | undefined;
			let backupPath: string | undefined;

			if (fileKind === ExistingFileKind.None) {
				operationType = GitignoreOperationType.Overwrite;

			} else if (fileKind === ExistingFileKind.ExtensionManaged) {
				operationType = GitignoreOperationType.Update;

			} else {
				// External file: honour the action chosen before the template picker
				switch (externalAction!) {
					case ExternalFileAction.Migrate:
						// Treat the entire existing file as the custom rules section
						operationType = GitignoreOperationType.Update;
						customContentOverride = normalizeLineEndings(existingContent).trim();
						break;

					case ExternalFileAction.BackupAndReplace:
						backupPath = `${gitignorePath}${backupSuffix}`;
						await fs.promises.copyFile(gitignorePath, backupPath);
						console.log(`techstack-gitignore: backed up .gitignore to ${backupPath}`);
						operationType = GitignoreOperationType.BackupAndReplace;
						break;

					case ExternalFileAction.Replace:
						operationType = GitignoreOperationType.Overwrite;
						break;
				}
			}

			console.log(`techstack-gitignore: writing .gitignore (${GitignoreOperationType[operationType]}) for ${workspacePath}`);

			const operation: GitignoreOperation = {
				path: gitignorePath,
				templates: sortTemplates(selectedTemplates),
				type: operationType,
				customContentOverride
			};

			await downloadGitignoreFile(gitignoreRepository, operation, downloadConcurrency);
			await showSuccessMessage(operation, backupPath);

		} catch (error) {
			if (error instanceof CancellationError) {
				console.info('techstack-gitignore: command cancelled');
				return;
			} else if (error instanceof GithubApiRateLimitReachedError) {
				console.error('techstack-gitignore: GitHub API rate limit reached');

				if (await githubSession.isAuthenticated()) {
					await vscode.window.showErrorMessage('GitHub API rate limit reached');
					return;
				}

				// Not yet authenticated — offer to sign in
				try {
					const token = await githubSession.tryGetGithubToken();
					if (token) {
						console.info('techstack-gitignore: acquiring GitHub access token succeeded');
						await vscode.window.showInformationMessage('Acquired GitHub access token. Please try again.');
					} else {
						console.error('techstack-gitignore: acquiring GitHub access token failed');
						await vscode.window.showErrorMessage('Acquiring GitHub access token failed');
					}
				} catch (innerError) {
					if (innerError instanceof CancellationError) {
						console.info('techstack-gitignore: command cancelled');
					} else if (innerError instanceof AuthenticationCancellationError) {
						console.info('techstack-gitignore: acquiring GitHub access token cancelled');
					} else {
						console.error('techstack-gitignore: ', innerError);
						await vscode.window.showErrorMessage(String(innerError));
					}
				}
			} else {
				console.error('techstack-gitignore: ', error);
				await vscode.window.showErrorMessage(String(error));
			}
		}
	});

	context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {
	console.log('techstack-gitignore: extension is now deactivated!');
}
