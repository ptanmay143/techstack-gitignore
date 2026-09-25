import * as https from 'https';
import * as url from 'url';
import { WriteStream } from 'fs';

import { getAgent } from '../http-client';
import { Cache, CacheItem } from '../cache';
import { DiskCache } from '../disk-cache';
import { GitignoreProvider, GitignoreTemplate } from '../interfaces';
import { GithubSession } from '../github/session';
import { GitHubClient } from '../github/client';


interface GithubRepositoryItem {
	name: string;
	path: string;
	download_url: string;
	type: string;
	sha: string;
}

/**
 * Github gitignore template provider based on the "/repos" endpoint of the Github REST API.
 * https://docs.github.com/en/rest/repos/contents
 *
 * Supports configurable API base URL (for GitHub Enterprise) and repository path (for forks).
 */
export class GithubGitignoreRepositoryProvider implements GitignoreProvider {
	private client: GitHubClient;
	private templateShaByPath = new Map<string, string>();
	/** Base URL for the repository contents endpoint, e.g. https://api.github.com/repos/github/gitignore/contents/ */
	private contentsBaseUrl: string;

	constructor(
		private cache: Cache,
		githubSession: GithubSession,
		private diskCache?: DiskCache,
		apiBaseUrl: string = 'https://api.github.com',
		repository: string = 'github/gitignore'
	) {
		this.client = new GitHubClient(githubSession);
		// Ensure the base URL ends with a trailing slash so url.URL sub-path resolution works correctly
		this.contentsBaseUrl = `${apiBaseUrl.replace(/\/$/, '')}/repos/${repository}/contents/`;
	}

	/**
	 * Get all .gitignore templates (root, Global, and community directories)
	 */
	public async getTemplates(): Promise<GitignoreTemplate[]> {
		const result = await Promise.all([
			this.getFiles(),
			this.getFiles('Global'),
			this.getFiles('community')
		]);
		const files = (Array.prototype.concat.apply([], result) as GitignoreTemplate[])
			.sort((a: GitignoreTemplate, b: GitignoreTemplate) => a.name.localeCompare(b.name));
		return files;
	}

	/**
	 * Get all .gitignore files in a directory of the repository
	 */
	private async getFiles(path = ''): Promise<GitignoreTemplate[]> {
		// Return from in-memory cache if available
		const item = this.cache.get('gitignore/' + path) as GitignoreTemplate[];
		if (typeof item !== 'undefined') {
			item.forEach(template => {
				if (template.sha) {
					this.templateShaByPath.set(template.path, template.sha);
				}
			});
			return item;
		}

		const fullUrl = new url.URL(path, this.contentsBaseUrl);
		const options: https.RequestOptions = {
			agent: getAgent(),
			method: 'GET',
			headers: { ...await this.client.getHeaders(), 'Accept': 'application/vnd.github.v3+json' },
		};

		const responseBody = await this.client.requestString(fullUrl, options);
		const items = JSON.parse(responseBody) as GithubRepositoryItem[];

		const templates = items
			.filter(item => item.type === 'file' && item.name.endsWith('.gitignore'))
			.map(item => {
				this.templateShaByPath.set(item.path, item.sha);
				return <GitignoreTemplate>{
					name: item.name.replace(/\.gitignore/, ''),
					path: item.path,
					sha: item.sha
				};
			});

		this.cache.add(new CacheItem('gitignore/' + path, templates));
		return templates;
	}

	/**
	 * Downloads a .gitignore template to a write stream.
	 *
	 * Cache lookup order:
	 *   1. In-memory cache   — fastest, lives for the session
	 *   2. Persistent disk cache — survives restarts; keyed by SHA so content is
	 *      only re-fetched when the upstream file changes
	 *   3. GitHub API        — network request as last resort
	 */
	public async downloadToStream(templatePath: string, writeStream: WriteStream): Promise<void> {
		const sha = this.templateShaByPath.get(templatePath);
		const cacheKey = `gitignore/template/${templatePath}/${sha ?? 'latest'}`;

		// 1. In-memory cache
		const memContent = this.cache.get(cacheKey) as string;
		if (typeof memContent !== 'undefined') {
			return this.writeToStream(writeStream, memContent);
		}

		// 2. Persistent disk cache
		if (this.diskCache) {
			const diskContent = this.diskCache.get(cacheKey);
			if (diskContent !== undefined) {
				console.log(`techstack-gitignore: disk cache hit for ${cacheKey}`);
				this.cache.add(new CacheItem(cacheKey, diskContent));
				return this.writeToStream(writeStream, diskContent);
			}
		}

		// 3. GitHub API
		const fullUrl = new url.URL(templatePath, this.contentsBaseUrl);
		const options: https.RequestOptions = {
			agent: getAgent(),
			method: 'GET',
			headers: { ...await this.client.getHeaders(), 'Accept': 'application/vnd.github.v3.raw' }
		};

		const responseBody = await this.client.requestString(fullUrl, options);

		// Store in both caches
		this.cache.add(new CacheItem(cacheKey, responseBody));
		this.diskCache?.set(cacheKey, responseBody);

		return this.writeToStream(writeStream, responseBody);
	}

	/** Writes a string to a WriteStream, resolves when the stream is closed. */
	private writeToStream(writeStream: WriteStream, content: string): Promise<void> {
		return new Promise(resolve => {
			writeStream.on('finish', () => {
				writeStream.close();
				resolve();
			});
			writeStream.end(content);
		});
	}
}
