// import * as assert from 'assert';

// import * as vscode from 'vscode';
import { downloadGitignoreFile } from '../extension';
import { GitignoreOperationType, GitignoreProvider, GitignoreTemplate } from '../interfaces';
import * as fs from 'fs';
import { createTmpTestDir } from './utils';
import assert from 'assert';

class GitignoreProviderMock implements GitignoreProvider {
	getTemplates(): Promise<GitignoreTemplate[]> {
		return Promise.resolve([
			{
				download_url :'',
				name: 'example',
				path: 'example',
				type: 'foo'
			},
			{
				download_url :'',
				name: 'Python',
				path: 'Python.gitignore',
				type: 'foo'
			},
			{
				download_url :'',
				name: 'Node',
				path: 'Node.gitignore',
				type: 'foo'
			}
		]);
	}
	downloadToStream(templatePath: string, writeStream: fs.WriteStream): Promise<void> {
		return new Promise((resolve) => {
			writeStream.write(templatePath + "\n");

			writeStream.on('finish', () => {
				writeStream.close();
				resolve();
			});

			writeStream.end();
		});
	}

}

function assertLines(path: string, ...expectedLines: string[]) {
	const content = fs.readFileSync(path, {encoding: 'utf8'});
	const lines = content.split(/\r?\n/);

	assert.strictEqual(lines.length, expectedLines.length);
	for (let i = 0; i < expectedLines.length; ++i) {
		const expected = expectedLines[i];
		const got = lines[i];
		console.log(`excepted: "${expected}", got: "${got}"`);
		assert.strictEqual(got, expected);
	}
}

function expectedManagedLines(customRules: string[], templateNames: string[], templatePaths: string[]) {
	const lines = [
		'# ----------------------------------------------------------------------',
		'# Custom ignore rules',
		'# ----------------------------------------------------------------------',
		'# Add project-specific ignore rules in this section. The extension preserves this content.',
		...customRules,
		'',
		'# ----------------------------------------------------------------------',
		'# GitHub gitignore templates',
		`# Templates: ${templateNames.join(', ')}`,
		'# ----------------------------------------------------------------------'
	];

	for (let i = 0; i < templateNames.length; ++i) {
		lines.push(
			'',
			'# ----------------------------------------------------------------------',
			`# Template: ${templateNames[i]}`,
			`# Source: github/gitignore/${templatePaths[i]}`,
			'# ----------------------------------------------------------------------',
			templatePaths[i]
		);
	}

	lines.push('');
	return lines;
}

suite('Extension Test Suite', () => {

	// test('Sample test', async () => {
	// 	//await vscode.commands.executeCommand('gitignore.addgitignore');
	// });


	test('can write a new gitignore file', async () => {
		const testBaseDir = await createTmpTestDir('download');
		const path = `${testBaseDir}/.gitignore`;


		const gitignoreProvider = new GitignoreProviderMock();
		const templates = await gitignoreProvider.getTemplates();

		const operation = {
			templates: [templates[0]],
			path: path,
			type: GitignoreOperationType.Overwrite
		};

		await downloadGitignoreFile(gitignoreProvider, operation, 6);

		const content = fs.readFileSync(path, {encoding: 'utf8'});
		console.log(content);

		assertLines(
			path,
			...expectedManagedLines([], ['example'], ['example'])
		);

		// Cleanup
		// if(fs.existsSync(path)) {
		// 	fs.unlinkSync(path);
		// }
	});

	test('can convert an existing gitignore file and preserve custom rules', async () => {
		const testBaseDir = await createTmpTestDir('download');
		const path = `${testBaseDir}/.gitignore`;
		fs.writeFileSync(path, "existing line");


		const gitignoreProvider = new GitignoreProviderMock();
		const templates = await gitignoreProvider.getTemplates();

		const operation = {
			templates: [templates[0]],
			path: path,
			type: GitignoreOperationType.Overwrite
		};

		await downloadGitignoreFile(gitignoreProvider, operation, 6);

		assertLines(
			path,
			...expectedManagedLines(['existing line'], ['example'], ['example'])
		);

		// Cleanup
		if(fs.existsSync(path)) {
			fs.unlinkSync(path);
		}
	});

	test('can update a gitignore file without duplicating existing template content', async () => {
		const testBaseDir = await createTmpTestDir('download');
		const path = `${testBaseDir}/.gitignore`;
		fs.writeFileSync(path, "existing line\nexample\n");

		const gitignoreProvider = new GitignoreProviderMock();
		const templates = await gitignoreProvider.getTemplates();

		const operation = {
			templates: [templates[0]],
			path: path,
			type: GitignoreOperationType.Update
		};

		await downloadGitignoreFile(gitignoreProvider, operation, 6);

		assertLines(
			path,
			...expectedManagedLines(['existing line'], ['example'], ['example'])
		);

		// Cleanup
		if(fs.existsSync(path)) {
			fs.unlinkSync(path);
		}
	});

	test('writes selected templates in a reproducible order', async () => {
		const firstTestBaseDir = await createTmpTestDir('download');
		const secondTestBaseDir = await createTmpTestDir('download');
		const firstPath = `${firstTestBaseDir}/.gitignore`;
		const secondPath = `${secondTestBaseDir}/.gitignore`;

		const gitignoreProvider = new GitignoreProviderMock();
		const templates = await gitignoreProvider.getTemplates();
		const python = templates.find(template => template.name === 'Python');
		const node = templates.find(template => template.name === 'Node');
		assert(python !== undefined);
		assert(node !== undefined);

		await downloadGitignoreFile(gitignoreProvider, {
			templates: [node, python],
			path: firstPath,
			type: GitignoreOperationType.Overwrite
		}, 6);
		await downloadGitignoreFile(gitignoreProvider, {
			templates: [python, node],
			path: secondPath,
			type: GitignoreOperationType.Overwrite
		}, 6);

		const firstContent = fs.readFileSync(firstPath, {encoding: 'utf8'});
		const secondContent = fs.readFileSync(secondPath, {encoding: 'utf8'});
		assert.strictEqual(firstContent, secondContent);
		assertLines(
			firstPath,
			...expectedManagedLines([], ['Node', 'Python'], ['Node.gitignore', 'Python.gitignore'])
		);

		if(fs.existsSync(firstPath)) {
			fs.unlinkSync(firstPath);
		}
		if(fs.existsSync(secondPath)) {
			fs.unlinkSync(secondPath);
		}
	});

});